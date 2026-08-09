// `handleFrameworkError` driven directly. The HTTP suite in
// framework-error.integration.test.ts can only produce the one router-level
// failure Fastify actually raises (a malformed URL, 400); the branches that
// matter most — a 5xx, and an error with no `statusCode` at all — are reachable
// only from here.
import { Logger } from '@nestjs/common';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleFrameworkError } from '../src/shared/errors/framework-error.handler.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The handler takes real `FastifyRequest`/`FastifyReply` — that annotation is
 * what lets `bootstrap.ts` pass it to the hook with no type assertion — so the
 * fixtures are cast rather than structurally typed. The cast is confined to
 * these two factories, and what it stands in for is exercised for real by
 * framework-error.integration.test.ts against the composed app.
 */
interface Sent {
  readonly reply: FastifyReply;
  readonly headers: Map<string, string>;
  payload: unknown;
}

function fakeReply(): Sent {
  const headers = new Map<string, string>();
  let statusCode = 0;
  const reply = {
    get statusCode(): number {
      return statusCode;
    },
    // A SETTER that throws outside 100–599, because the real one does:
    // `FastifyReply.statusCode`'s setter routes through `Reply.prototype.code`
    // (fastify/lib/reply.js:334), which raises FST_ERR_BAD_STATUS_CODE. As a
    // plain writable property — which is what this fixture had — assigning 0
    // silently succeeded, and that single divergence is exactly what made a
    // process-killing throw invisible at this boundary. A cast fixture can make
    // a test pass that should fail; this is the instance.
    set statusCode(value: number) {
      if (!Number.isInteger(value) || value < 100 || value > 599) {
        throw new Error(`FST_ERR_BAD_STATUS_CODE: ${String(value)}`);
      }
      statusCode = value;
    },
    header: (name: string, value: string) => headers.set(name, value),
    send: (payload: unknown) => (sent.payload = payload),
  };
  const sent: Sent = { headers, payload: undefined, reply: reply as unknown as FastifyReply };
  return sent;
}

function fakeRequest(headers: Record<string, string> = {}): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

/** A request object with no `headers` at all — the shape that throws a TypeError. */
function headerlessRequest(): FastifyRequest {
  return {} as unknown as FastifyRequest;
}

function fastifyError(message: string, statusCode?: number): FastifyError {
  const error = new Error(message) as FastifyError;
  error.code = 'FST_ERR_TEST';
  if (statusCode !== undefined) error.statusCode = statusCode;
  return error;
}

interface Envelope {
  readonly error: { readonly code: string; readonly message: string; readonly requestId: string };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleFrameworkError', () => {
  it('keeps a 4xx at its own status and names the mapped code', () => {
    const sent = fakeReply();
    handleFrameworkError(fastifyError('too big', 413), fakeRequest(), sent.reply);

    expect(sent.reply.statusCode).toBe(413);
    expect((sent.payload as Envelope).error.code).toBe('FILE_TOO_LARGE');
  });

  it('keeps a 4xx with no mapped code at its own status too', () => {
    // The status collapse, at the unit boundary: 415 has no row, so it takes the
    // fallback CODE but must not take the fallback's 400.
    const sent = fakeReply();
    handleFrameworkError(fastifyError('unsupported', 415), fakeRequest(), sent.reply);

    expect(sent.reply.statusCode).toBe(415);
    expect((sent.payload as Envelope).error.code).toBe('VALIDATION_FAILED');
  });

  it('never describes a 5xx, and logs it instead', () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const sent = fakeReply();

    handleFrameworkError(fastifyError('upstream pod slicer-7f2', 503), fakeRequest(), sent.reply);

    expect(sent.reply.statusCode).toBe(500);
    const body = sent.payload as Envelope;
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('slicer-7f2');
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('treats an error with no statusCode as ours', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const sent = fakeReply();

    handleFrameworkError(fastifyError('no status at all'), fakeRequest(), sent.reply);

    expect(sent.reply.statusCode).toBe(500);
    expect((sent.payload as Envelope).error.code).toBe('INTERNAL_ERROR');
  });

  it('refuses to describe a status that is not a 4xx at all', () => {
    // The missing lower bound. A `statusCode` of 200 or 302 — any library can
    // throw one — used to emit a full error envelope AT 200/302. Neither is a
    // status a client branches on as an error, so the response was unreadable
    // by anything.
    for (const statusCode of [200, 302, 399]) {
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const sent = fakeReply();

      handleFrameworkError(
        fastifyError('not an error status', statusCode),
        fakeRequest(),
        sent.reply,
      );

      expect(sent.reply.statusCode, `statusCode ${String(statusCode)}`).toBe(500);
      expect((sent.payload as Envelope).error.code).toBe('INTERNAL_ERROR');
    }
  });

  it('survives a status outside 100–599 instead of killing the process', () => {
    // `reply.statusCode = 0` throws FST_ERR_BAD_STATUS_CODE, and a throw from
    // this hook escapes Fastify's request listener — MEASURED against
    // standalone fastify@5.10.0: `UNCAUGHT`, process exit 7. The 4xx bound keeps
    // these away from the assignment; the try/catch is what stops that being a
    // property of Fastify's error set rather than of our file.
    for (const statusCode of [0, 99, 600, 999, Number.NaN]) {
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const sent = fakeReply();

      expect(
        () => {
          handleFrameworkError(
            fastifyError('hostile status', statusCode),
            fakeRequest(),
            sent.reply,
          );
        },
        `statusCode ${String(statusCode)}`,
      ).not.toThrow();

      expect(sent.reply.statusCode, `statusCode ${String(statusCode)}`).toBe(500);
    }
  });

  it('survives a request with no headers at all', () => {
    // The shape the 4xx bound does NOT cover: reading `request.headers[…]`
    // throws a TypeError. Answers with the generic 500 and the no-context
    // sentinel rather than taking the process down.
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const sent = fakeReply();

    expect(() => {
      handleFrameworkError(fastifyError('bad url', 400), headerlessRequest(), sent.reply);
    }).not.toThrow();

    expect(sent.reply.statusCode).toBe(500);
    const body = sent.payload as Envelope;
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.requestId).toBe('unknown');
    expect(logged).toHaveBeenCalled();
  });

  it('puts the same minted id on the header and in the body', () => {
    const sent = fakeReply();
    handleFrameworkError(fastifyError('bad url', 400), fakeRequest(), sent.reply);

    const { requestId } = (sent.payload as Envelope).error;
    expect(requestId).toMatch(UUID);
    expect(sent.headers.get('x-request-id')).toBe(requestId);
  });

  it('echoes a well-formed client id but refuses the no-context sentinel', () => {
    const echoed = fakeReply();
    handleFrameworkError(
      fastifyError('bad url', 400),
      fakeRequest({ 'x-request-id': 'client-id' }),
      echoed.reply,
    );
    expect((echoed.payload as Envelope).error.requestId).toBe('client-id');

    const forged = fakeReply();
    handleFrameworkError(
      fastifyError('bad url', 400),
      fakeRequest({ 'x-request-id': 'unknown' }),
      forged.reply,
    );
    expect((forged.payload as Envelope).error.requestId).toMatch(UUID);
  });
});
