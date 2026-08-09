// `handleFrameworkError` driven directly. The HTTP suite in
// framework-error.integration.test.ts can only produce the one router-level
// failure Fastify actually raises (a malformed URL, 400); the branches that
// matter most — a 5xx, and an error with no `statusCode` at all — are reachable
// only from here.
import { Logger } from '@nestjs/common';
import type { FastifyError } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleFrameworkError,
  type FrameworkErrorReply,
} from '../src/shared/errors/framework-error.handler.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Sent {
  readonly reply: FrameworkErrorReply;
  readonly headers: Map<string, string>;
  payload: unknown;
}

function fakeReply(): Sent {
  const headers = new Map<string, string>();
  const sent: Sent = {
    headers,
    payload: undefined,
    reply: {
      statusCode: 0,
      header: (name: string, value: string) => headers.set(name, value),
      send: (payload: unknown) => (sent.payload = payload),
    },
  };
  return sent;
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
    handleFrameworkError(fastifyError('too big', 413), { headers: {} }, sent.reply);

    expect(sent.reply.statusCode).toBe(413);
    expect((sent.payload as Envelope).error.code).toBe('FILE_TOO_LARGE');
  });

  it('keeps a 4xx with no mapped code at its own status too', () => {
    // The status collapse, at the unit boundary: 415 has no row, so it takes the
    // fallback CODE but must not take the fallback's 400.
    const sent = fakeReply();
    handleFrameworkError(fastifyError('unsupported', 415), { headers: {} }, sent.reply);

    expect(sent.reply.statusCode).toBe(415);
    expect((sent.payload as Envelope).error.code).toBe('VALIDATION_FAILED');
  });

  it('never describes a 5xx, and logs it instead', () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const sent = fakeReply();

    handleFrameworkError(fastifyError('upstream pod slicer-7f2', 503), { headers: {} }, sent.reply);

    expect(sent.reply.statusCode).toBe(500);
    const body = sent.payload as Envelope;
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('slicer-7f2');
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('treats an error with no statusCode as ours', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const sent = fakeReply();

    handleFrameworkError(fastifyError('no status at all'), { headers: {} }, sent.reply);

    expect(sent.reply.statusCode).toBe(500);
    expect((sent.payload as Envelope).error.code).toBe('INTERNAL_ERROR');
  });

  it('puts the same minted id on the header and in the body', () => {
    const sent = fakeReply();
    handleFrameworkError(fastifyError('bad url', 400), { headers: {} }, sent.reply);

    const { requestId } = (sent.payload as Envelope).error;
    expect(requestId).toMatch(UUID);
    expect(sent.headers.get('x-request-id')).toBe(requestId);
  });

  it('echoes a well-formed client id but refuses the no-context sentinel', () => {
    const echoed = fakeReply();
    handleFrameworkError(
      fastifyError('bad url', 400),
      { headers: { 'x-request-id': 'client-id' } },
      echoed.reply,
    );
    expect((echoed.payload as Envelope).error.requestId).toBe('client-id');

    const forged = fakeReply();
    handleFrameworkError(
      fastifyError('bad url', 400),
      { headers: { 'x-request-id': 'unknown' } },
      forged.reply,
    );
    expect((forged.payload as Envelope).error.requestId).toMatch(UUID);
  });
});
