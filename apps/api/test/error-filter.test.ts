// The filter driven DIRECTLY, with a fake ArgumentsHost. Two reasons this
// exists alongside the HTTP-level suite:
//
//   * A Nest application object is a Proxy whose `get` trap routes calls through
//     `ExceptionsZone`, which swallows what it catches. Anything asserted about
//     the filter by stubbing the app measures the proxy, not this code.
//   * The logging is invisible over HTTP. `NestFactory.create(…, { logger: false })`
//     calls `Logger.overrideLogger(false)` process-wide, so an integration suite
//     that boots quietly cannot also observe that a log was written.
//
// The logger is the REAL one — `createLogger`, with its redaction, its `err`
// serialiser and its hook — writing into memory. A spy on a logger method would
// assert what the filter PASSED and say nothing about what was written down,
// and what is written down is the entire question this file exists for.
import 'reflect-metadata';
import { HttpException, HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../src/shared/errors/domain-error.js';
import { DomainExceptionFilter } from '../src/shared/errors/domain-exception.filter.js';
import { DOMAIN_ERROR_RESPONSE } from '../src/shared/errors/error-mapping.js';
import { runWithRequestContext } from '../src/shared/request-context/request-context.js';
import { captureLogger, errorField, type CapturedLog } from './log-capture.js';

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

function filterWithLog(): { filter: DomainExceptionFilter; log: CapturedLog } {
  const log = captureLogger();
  return { filter: new DomainExceptionFilter(log.logger), log };
}

describe('DomainExceptionFilter logging', () => {
  it('records an unexpected failure at error level, naming the request id', () => {
    // Before this, an unexpected 500 produced literally zero bytes of output:
    // Nest's ExceptionsHandler logs only when NO custom filter handles the
    // exception, and this filter handles everything. The response carries a
    // requestId "to find the full trace" — this is what makes a trace exist.
    const { filter, log } = filterWithLog();
    const { host } = fakeHost();

    runWithRequestContext({ requestId: 'log-me' }, () => {
      filter.catch(new Error('UNEXPECTED_BOOM'), host);
    });

    const line = log.only();
    expect(line['level']).toBe('error');
    expect(line['msg']).toContain('log-me');
    expect(line['context']).toBe('DomainExceptionFilter');
  });

  /**
   * THE CARRY-FORWARD THIS FILTER OPENED AND PLAN 0C CLOSES.
   *
   * `describeCause` used to put the exception's stack in the log, and a stack
   * BEGINS with its message — so a `DATABASE_URL` in a thrown message was
   * written to stdout in full. Plan 0B-1's comment on that call said not to
   * inherit it silently; this is what stops it being inherited.
   */
  it('writes no part of a DSN carried in the exception message', () => {
    const { filter, log } = filterWithLog();
    const { host, captured } = fakeHost();

    filter.catch(new Error('connect failed: postgres://user:PASSWORD@host/db'), host);

    expect(log.raw()).not.toContain('PASSWORD');
    expect(log.raw()).not.toContain('postgres://');
    expect(JSON.stringify(captured.payload)).not.toContain('PASSWORD');
  });

  /**
   * The OTHER half, and a redaction assertion passes trivially without it:
   * ADR-0030 measured two of nine configurations silently DISCARDING the cause,
   * emitting a perfectly clean line with no diagnostic in it at all.
   *
   * This is also where Step 2b of the task brief was decided — against the real
   * filter rather than a synthetic harness. Obligation 7 applied literally
   * leaves `{"type":"Error","message":"[REDACTED]","stack":"[REDACTED]"}` and
   * nothing else; the frame-preserving serialiser keeps the throw site, which is
   * the thing an operator actually needs, and leaks neither way.
   */
  it('keeps the throw site, which is what makes the line worth writing', () => {
    const { filter, log } = filterWithLog();
    const { host } = fakeHost();

    function thrower(): never {
      throw new Error('UNEXPECTED_BOOM');
    }
    try {
      thrower();
    } catch (error: unknown) {
      filter.catch(error, host);
    }

    const err = errorField(log.only());
    expect(err['type']).toBe('Error');
    expect(err['message']).toBe('[REDACTED]');
    expect(err['stack']).toBe('[REDACTED]');

    const frames = err['frames'] as string[];
    expect(frames.length).toBeGreaterThan(1);
    expect(frames[0]).toContain('thrower');
    expect(frames.join('\n')).toContain('error-filter.test');
    // The message is in the stack's first line, and that line is the one thing
    // the frames must not carry.
    expect(frames.join('\n')).not.toContain('UNEXPECTED_BOOM');
  });

  it('never puts the exception message in the response', () => {
    const { filter, log } = filterWithLog();
    const { host, captured } = fakeHost();

    filter.catch(new Error('UNEXPECTED_BOOM'), host);

    expect(JSON.stringify(captured.payload)).not.toContain('UNEXPECTED_BOOM');
    expect(log.only()['msg']).not.toContain('UNEXPECTED_BOOM');
  });

  it('describes a thrown non-Error instead of stringifying it', () => {
    // A thrown plain object is arbitrary data, so nothing that could be a
    // secret is written at all — and it gets no frames, because the only stack
    // available would be the logger's own and would point at the logger rather
    // than at anything that went wrong.
    const { filter, log } = filterWithLog();
    const { host, captured } = fakeHost();

    filter.catch({ password: 'hunter2' }, host);

    expect(log.raw()).not.toContain('hunter2');
    expect(errorField(log.only())['frames']).toStrictEqual([]);
    expect(captured.status).toBe(500);
  });

  it('does not log a domain failure — a handled 410 is not an incident', () => {
    const { filter, log } = filterWithLog();
    const { host } = fakeHost();

    filter.catch(new DomainError('QUOTE_EXPIRED', 'expirada'), host);

    expect(log.lines()).toStrictEqual([]);
  });

  it('refuses to describe an HttpException that is not a 4xx', () => {
    // The missing lower bound, on the filter side. MEASURED: with only
    // `< 500`, `new HttpException('x', 302)` from any library produced a full
    // error envelope AT 302 — a status no client treats as an error, so the
    // body was unreachable by every client branch that exists.
    const { filter, log } = filterWithLog();
    const { host, captured } = fakeHost();

    filter.catch(new HttpException('a redirect, thrown', 302), host);

    expect(captured.status).toBe(500);
    expect(JSON.stringify(captured.payload)).toContain('INTERNAL_ERROR');
    expect(log.lines()).toHaveLength(1);
  });

  it('does not log a framework 4xx — a client error is not an incident either', () => {
    const { filter, log } = filterWithLog();
    const { host } = fakeHost();

    filter.catch(new HttpException('nope', HttpStatus.NOT_FOUND), host);

    expect(log.lines()).toStrictEqual([]);
  });

  it('produces one identical envelope whatever was thrown', () => {
    // Six shapes that reach the generic branch by different routes. The response
    // must not vary with them at all — a body that differs by thrown shape is an
    // oracle, and the differences are exactly the internals worth hiding. Kept
    // as a set rather than six cases so that a new branch which "helpfully"
    // describes one of them fails here.
    const thrown: readonly unknown[] = [
      'a bare string',
      { password: 'hunter2' },
      null,
      new Error('plain', { cause: new Error('the cause') }),
      new AggregateError([new Error('one'), new Error('two')], 'aggregate'),
      Object.assign(new Error('with a code'), { code: 'ECONNREFUSED' }),
    ];

    const { filter, log } = filterWithLog();
    const bodies = thrown.map((value) => {
      const { host, captured } = fakeHost();
      filter.catch(value, host);
      return JSON.stringify({ status: captured.status, payload: captured.payload });
    });

    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toContain('hunter2');
    expect(bodies[0]).not.toContain('ECONNREFUSED');
    expect(bodies[0]).toContain('INTERNAL_ERROR');
    // The same six, from the LOG's side: an Error's own properties are dropped
    // by the serialiser rather than left to a path that stops applying the day
    // the error is nested one level deeper.
    expect(log.raw()).not.toContain('hunter2');
    expect(log.raw()).not.toContain('ECONNREFUSED');
    expect(log.raw()).not.toContain('the cause');
  });

  it('logs a 5xx HttpException, because that one IS ours', () => {
    const { filter, log } = filterWithLog();
    const { host, captured } = fakeHost();

    filter.catch(new HttpException('upstream detail', HttpStatus.SERVICE_UNAVAILABLE), host);

    expect(log.lines()).toHaveLength(1);
    expect(log.raw()).not.toContain('upstream detail');
    expect(captured.status).toBe(DOMAIN_ERROR_RESPONSE.INTERNAL_ERROR.status);
    expect(JSON.stringify(captured.payload)).not.toContain('upstream detail');
  });
});
