// The request shapes Node's HTTP parser rejects before Fastify can build a
// request object. They reach neither the exception filter, nor the
// request-context middleware, nor the `frameworkErrors` hook — Fastify forwards
// them to `options.clientErrorHandler` with a raw socket instead — so this suite
// boots the REAL bootstrap and speaks raw HTTP at it. `fetch` cannot produce any
// of these: it will not send an invalid method token or an obs-fold header, and
// it rejects an oversized header block client-side.
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainErrorCode } from '@metrika/contracts';
import { bootApiForTest, stopDatabase } from './support.js';
import { API_PREFIX } from '../src/bootstrap.js';

let host: string;
let port: number;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const booted = await bootApiForTest();
  close = booted.close;
  const url = new URL(booted.baseUrl);
  host = url.hostname;
  port = Number(url.port);
});

afterAll(async () => {
  await close?.();
  await stopDatabase();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Larger than Node's 16 KB default `maxHeaderSize`. */
const OVERSIZED_HEADER_VALUE = 'x'.repeat(20 * 1024);

interface RawResponse {
  readonly raw: string;
  readonly statusLine: string;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
}

/** Writes `payload` verbatim and collects everything the server writes back. */
async function speak(payload: string): Promise<RawResponse> {
  const raw = await new Promise<string>((resolve) => {
    const socket: Socket = connect(port, host);
    let out = '';
    const finish = (): void => {
      socket.destroy();
      resolve(out);
    };
    socket.setTimeout(10_000);
    socket.on('connect', () => socket.write(payload, 'latin1'));
    socket.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    socket.on('close', finish);
    socket.on('timeout', finish);
    socket.on('error', finish);
  });

  const separator = raw.indexOf('\r\n\r\n');
  const head = separator === -1 ? raw : raw.slice(0, separator);
  const body = separator === -1 ? '' : raw.slice(separator + 4);
  const [statusLine = '', ...lines] = head.split('\r\n');
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { raw, statusLine, headers, body };
}

interface Envelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly retryable: boolean;
  };
}

/**
 * Every shape MEASURED escaping the envelope against the real `dist/main.js`,
 * with the response each one produced before `clientErrorHandler` was wired.
 * All three carried ZERO `x-request-id` headers.
 */
const ESCAPING_SHAPES: ReadonlyArray<{
  readonly name: string;
  readonly request: string;
  readonly status: number;
  readonly reason: string;
  /** Fastify's own body for this shape, which a client could not parse. */
  readonly wasBody: string;
}> = [
  {
    name: 'header block over the parser limit',
    request:
      `GET /health/live HTTP/1.1\r\nHost: localhost\r\n` +
      `X-Big: ${OVERSIZED_HEADER_VALUE}\r\n\r\n`,
    status: 431,
    reason: 'Request Header Fields Too Large',
    wasBody:
      '{"error":"Request Header Fields Too Large",' +
      '"message":"Exceeded maximum allowed HTTP header size","statusCode":431}',
  },
  {
    name: 'malformed method token',
    request: `G@T /health/live HTTP/1.1\r\nHost: localhost\r\n\r\n`,
    status: 400,
    reason: 'Bad Request',
    wasBody: '{"error":"Bad Request","message":"Client Error","statusCode":400}',
  },
  {
    name: 'obs-fold continuation line',
    request: `GET /health/live HTTP/1.1\r\nHost: localhost\r\nX-Fold: a\r\n b\r\n\r\n`,
    status: 400,
    reason: 'Bad Request',
    wasBody: '{"error":"Bad Request","message":"Client Error","statusCode":400}',
  },
];

describe('parser-level failures', () => {
  for (const shape of ESCAPING_SHAPES) {
    it(`answers a ${shape.name} in the documented envelope`, async () => {
      const response = await speak(shape.request);

      expect(response.statusLine).toBe(`HTTP/1.1 ${String(shape.status)} ${shape.reason}`);

      const body = JSON.parse(response.body) as Envelope;
      expect(DomainErrorCode.parse(body.error.code)).toBe('VALIDATION_FAILED');
      expect(body.error.retryable).toBe(false);
      expect(typeof body.error.message).toBe('string');

      // The exact response this used to be. A client parsing with
      // `ApiErrorResponse` fails outright on it: `error` is a string where the
      // contract declares an object, and there is no `code` and no `requestId`.
      expect(response.body).not.toBe(shape.wasBody);
      expect(response.body).not.toContain('statusCode');
      expect(response.body).not.toContain(`"error":"${shape.reason}"`);
    });

    it(`carries a request id in the body AND on the header for a ${shape.name}`, async () => {
      // ZERO x-request-id headers before this handler existed, on all three.
      const response = await speak(shape.request);
      const body = JSON.parse(response.body) as Envelope;

      expect(body.error.requestId).toMatch(UUID);
      expect(response.headers.get('x-request-id')).toBe(body.error.requestId);
    });

    it(`states its framing on a ${shape.name}`, async () => {
      // Written by hand onto a raw socket, so nothing computes these but us.
      const response = await speak(shape.request);

      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(response.headers.get('connection')).toBe('close');
      expect(response.headers.get('content-length')).toBe(
        String(Buffer.byteLength(response.body, 'utf8')),
      );
    });

    it(`leaks no parser internals through a ${shape.name}`, async () => {
      const { raw } = await speak(shape.request);

      // llhttp's own wording, and the shape Fastify would have sent.
      expect(raw).not.toContain('Parse Error');
      expect(raw).not.toContain('HPE_');
      expect(raw).not.toContain('rawPacket');

      // And the stack, which none of the above can see — the same four
      // assertions framework-error.integration.test.ts needed after forwarding
      // `error.stack` left its suite green while the wire carried absolute paths
      // and pinned dependency versions.
      expect(raw).not.toContain('stack');
      expect(raw).not.toContain('.js:');
      expect(raw).not.toContain('node_modules');
      expect(raw).not.toContain('\n    at ');
    });
  }

  it('does not echo a client id it would have had to parse rejected bytes to read', async () => {
    // The id IS in `err.rawPacket` — MEASURED — and this handler deliberately
    // does not go looking. Running a header parser over input Node's own parser
    // has just rejected is how header injection and request smuggling get in.
    // The consequence is stated here so that "the client id was ignored" reads
    // as a decision rather than an oversight.
    const response = await speak(
      `GET /health/live HTTP/1.1\r\nHost: localhost\r\n` +
        `X-Request-Id: client-supplied-parser-probe\r\nX-Fold: a\r\n b\r\n\r\n`,
    );

    const body = JSON.parse(response.body) as Envelope;
    expect(body.error.requestId).not.toBe('client-supplied-parser-probe');
    expect(body.error.requestId).toMatch(UUID);
  });

  it('never hands back the no-context sentinel, however the id was obtained', async () => {
    // `unknown` is what getRequestId() reports when there is genuinely no
    // context — which is exactly the situation here. A response carrying it
    // would make "no context" and "this request" indistinguishable in the one
    // place a support conversation has nothing else to go on.
    const response = await speak(
      `GET /health/live HTTP/1.1\r\nHost: localhost\r\n` +
        `X-Request-Id: unknown\r\nX-Fold: a\r\n b\r\n\r\n`,
    );

    expect((JSON.parse(response.body) as Envelope).error.requestId).toMatch(UUID);
  });

  it('leaves the router-level and ordinary paths exactly as they were', async () => {
    // `clientErrorHandler` and `frameworkErrors` are separate hooks on separate
    // parts of the connection lifecycle. Wiring the first must not move the
    // second, and this is the assertion that would notice if it did.
    const badUrl = await fetch(`http://${host}:${String(port)}/${API_PREFIX}/%zz`);
    expect(badUrl.status).toBe(400);
    const badUrlBody = (await badUrl.json()) as Envelope;
    expect(DomainErrorCode.parse(badUrlBody.error.code)).toBe('VALIDATION_FAILED');
    expect(badUrl.headers.get('x-request-id')).toBe(badUrlBody.error.requestId);

    const missing = await fetch(`http://${host}:${String(port)}/nope`);
    expect(missing.status).toBe(404);
    expect(DomainErrorCode.parse(((await missing.json()) as Envelope).error.code)).toBe(
      'ROUTE_NOT_FOUND',
    );

    const live = await fetch(`http://${host}:${String(port)}/health/live`);
    expect(live.status).toBe(200);
    expect(live.headers.get('x-request-id')).toMatch(UUID);
  });

  it('keeps serving after a connection is rejected at the parser', async () => {
    // The handler destroys the socket it was handed. If it took the listener
    // with it — or threw, which for a `clientError` listener is an uncaught
    // exception and process death rather than a 500 — this is what would notice.
    await speak(ESCAPING_SHAPES[0]?.request ?? '');
    await speak(ESCAPING_SHAPES[1]?.request ?? '');

    const live = await fetch(`http://${host}:${String(port)}/health/live`);
    expect(live.status).toBe(200);
  });
});
