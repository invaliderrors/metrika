// The filter driven DIRECTLY, with a fake ArgumentsHost. Two reasons this
// exists alongside the HTTP-level suite:
//
//   * A Nest application object is a Proxy whose `get` trap routes calls through
//     `ExceptionsZone`, which swallows what it catches. Anything asserted about
//     the filter by stubbing the app measures the proxy, not this code.
//   * The logging is invisible over HTTP. `NestFactory.create(…, { logger: false })`
//     calls `Logger.overrideLogger(false)` process-wide, so an integration suite
//     that boots quietly cannot also observe that a log was written.
import 'reflect-metadata';
import { HttpException, HttpStatus, Logger, type ArgumentsHost } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainError } from '../src/shared/errors/domain-error.js';
import { DomainExceptionFilter } from '../src/shared/errors/domain-exception.filter.js';
import { DOMAIN_ERROR_RESPONSE } from '../src/shared/errors/error-mapping.js';
import { runWithRequestContext } from '../src/shared/request-context/request-context.js';

interface Captured {
  status?: number;
  payload?: unknown;
}

function fakeHost(): { host: ArgumentsHost; captured: Captured } {
  const captured: Captured = {};
  const reply = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    send(payload: unknown) {
      captured.payload = payload;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => reply }),
  } as unknown as ArgumentsHost;
  return { host, captured };
}

/** Silenced, not merely observed — `vi.spyOn` calls through by default. */
function spyOnErrorLog() {
  return vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DomainExceptionFilter logging', () => {
  it('records an unexpected failure at error level, naming the request id', () => {
    // Before this, an unexpected 500 produced literally zero bytes of output:
    // Nest's ExceptionsHandler logs only when NO custom filter handles the
    // exception, and this filter handles everything. The response carries a
    // requestId "to find the full trace" — this is what makes a trace exist.
    const spy = spyOnErrorLog();
    const { host } = fakeHost();

    runWithRequestContext({ requestId: 'log-me' }, () => {
      new DomainExceptionFilter().catch(new Error('UNEXPECTED_BOOM'), host);
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain('log-me');
  });

  it('puts the stack in the log and never in the response', () => {
    const spy = spyOnErrorLog();
    const { host, captured } = fakeHost();

    new DomainExceptionFilter().catch(new Error('UNEXPECTED_BOOM'), host);

    expect(String(spy.mock.calls[0]?.[1])).toContain('UNEXPECTED_BOOM');
    expect(JSON.stringify(captured.payload)).not.toContain('UNEXPECTED_BOOM');
  });

  it('describes a thrown non-Error instead of stringifying it', () => {
    // A thrown plain object is arbitrary data. Redaction is Plan 0C's job, so
    // until it exists nothing that could be a secret is written at all — not
    // even to the log.
    const spy = spyOnErrorLog();
    const { host, captured } = fakeHost();

    new DomainExceptionFilter().catch({ password: 'hunter2' }, host);

    expect(JSON.stringify(spy.mock.calls[0])).not.toContain('hunter2');
    expect(captured.status).toBe(500);
  });

  it('does not log a domain failure — a handled 410 is not an incident', () => {
    const spy = spyOnErrorLog();
    const { host } = fakeHost();

    new DomainExceptionFilter().catch(new DomainError('QUOTE_EXPIRED', 'expirada'), host);

    expect(spy).not.toHaveBeenCalled();
  });

  it('does not log a framework 4xx — a client error is not an incident either', () => {
    const spy = spyOnErrorLog();
    const { host } = fakeHost();

    new DomainExceptionFilter().catch(new HttpException('nope', HttpStatus.NOT_FOUND), host);

    expect(spy).not.toHaveBeenCalled();
  });

  it('produces one identical envelope whatever was thrown', () => {
    // Six shapes that reach the generic branch by different routes. The response
    // must not vary with them at all — a body that differs by thrown shape is an
    // oracle, and the differences are exactly the internals worth hiding. Kept
    // as a set rather than six cases so that a new branch which "helpfully"
    // describes one of them fails here.
    spyOnErrorLog();
    const thrown: readonly unknown[] = [
      'a bare string',
      { password: 'hunter2' },
      null,
      new Error('plain', { cause: new Error('the cause') }),
      new AggregateError([new Error('one'), new Error('two')], 'aggregate'),
      Object.assign(new Error('with a code'), { code: 'ECONNREFUSED' }),
    ];

    const bodies = thrown.map((value) => {
      const { host, captured } = fakeHost();
      new DomainExceptionFilter().catch(value, host);
      return JSON.stringify({ status: captured.status, payload: captured.payload });
    });

    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toContain('hunter2');
    expect(bodies[0]).not.toContain('ECONNREFUSED');
    expect(bodies[0]).toContain('INTERNAL_ERROR');
  });

  it('logs a 5xx HttpException, because that one IS ours', () => {
    const spy = spyOnErrorLog();
    const { host, captured } = fakeHost();

    new DomainExceptionFilter().catch(
      new HttpException('upstream detail', HttpStatus.SERVICE_UNAVAILABLE),
      host,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(captured.status).toBe(DOMAIN_ERROR_RESPONSE.INTERNAL_ERROR.status);
    expect(JSON.stringify(captured.payload)).not.toContain('upstream detail');
  });
});
