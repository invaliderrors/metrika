// `handleClientError` driven directly, over a REAL `net.Socket` pair. The HTTP
// suite in client-error.integration.test.ts can only produce the shapes Node's
// parser actually rejects; the branches that matter most — a reset connection,
// an unwritable socket, and a hostile error object — are reachable only from
// here.
//
// A real socket rather than a cast fixture, on purpose. Task 11's round-4
// finding was that a hand-rolled `fakeReply()` whose `statusCode` was a plain
// property instead of the real throwing SETTER made a process-killing throw
// invisible at exactly this boundary. There is no equivalent hiding place below:
// `write`, `writable`, `destroyed` and `destroy` are Node's own.
import { Logger } from '@nestjs/common';
import { connect, createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainErrorCode } from '@metrika/contracts';
import { handleClientError } from '../src/shared/errors/client-error.handler.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Envelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly retryable: boolean;
  };
}

interface Exchange {
  /** Everything the peer received, verbatim. */
  readonly raw: string;
  readonly headers: ReadonlyMap<string, string>;
  readonly statusLine: string;
  readonly body: string;
}

function parse(raw: string): Exchange {
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
  return { raw, headers, statusLine, body };
}

/**
 * A real connected pair: `[serverSide, clientSide]`. Both are genuine
 * `net.Socket`s, so `writable`, `destroyed`, `write` and `destroy` behave
 * exactly as they do under Node's HTTP server.
 */
async function socketPair(server: Server): Promise<{ serverSide: Socket; clientSide: Socket }> {
  const { port } = server.address() as AddressInfo;
  const accepted = new Promise<Socket>((resolve) => server.once('connection', resolve));
  const clientSide = connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    clientSide.once('connect', () => {
      resolve();
    });
    clientSide.once('error', reject);
  });
  const serverSide = await accepted;
  // Stands in for Node's `socketOnError`, which the real HTTP server has
  // attached by the time `clientError` fires. `socket.destroy(err)` re-emits
  // `err`, and an unhandled `error` event is an uncaught exception.
  serverSide.on('error', () => undefined);
  return { serverSide, clientSide };
}

function connectionError(code: string): Error & { code: string } {
  const error = new Error(`Parse Error: ${code}`) as Error & { code: string };
  error.code = code;
  return error;
}

/** Drives the handler and returns what the peer actually received off the wire. */
async function respondTo(
  code: string,
  before?: (pair: { serverSide: Socket; clientSide: Socket }) => void,
): Promise<Exchange> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const pair = await socketPair(server);
    let raw = '';
    pair.clientSide.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    const closed = new Promise<void>((resolve) => {
      pair.clientSide.once('close', () => {
        resolve();
      });
    });

    before?.(pair);
    handleClientError(connectionError(code) as never, pair.serverSide);

    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
    pair.clientSide.destroy();
    return parse(raw);
  } finally {
    server.close();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleClientError', () => {
  it('answers an oversized header block as 431 in the documented envelope', async () => {
    // MEASURED before this handler was wired, against the real dist/main.js:
    //   431 {"error":"Request Header Fields Too Large",
    //        "message":"Exceeded maximum allowed HTTP header size","statusCode":431}
    // `error` a string where ApiErrorResponse declares an object, no `code`, no
    // request id anywhere.
    const sent = await respondTo('HPE_HEADER_OVERFLOW');

    expect(sent.statusLine).toBe('HTTP/1.1 431 Request Header Fields Too Large');
    const body = JSON.parse(sent.body) as Envelope;
    expect(DomainErrorCode.parse(body.error.code)).toBe('VALIDATION_FAILED');
    expect(body.error.retryable).toBe(false);
    expect(body.error.message).toBe('Exceeded maximum allowed HTTP header size');
  });

  it('answers every other parse failure as 400 in the same envelope', async () => {
    // The malformed method token and the obs-fold continuation line both arrive
    // here; Node distinguishes them by `code` and Fastify answers both with 400.
    for (const code of ['HPE_INVALID_METHOD', 'HPE_INVALID_HEADER_TOKEN', 'HPE_INVALID_VERSION']) {
      const sent = await respondTo(code);

      expect(sent.statusLine, code).toBe('HTTP/1.1 400 Bad Request');
      const body = JSON.parse(sent.body) as Envelope;
      expect(DomainErrorCode.parse(body.error.code), code).toBe('VALIDATION_FAILED');
      expect(body.error.message, code).toBe('Client Error');
    }
  });

  it('answers a request timeout as 408', async () => {
    const sent = await respondTo('ERR_HTTP_REQUEST_TIMEOUT');

    expect(sent.statusLine).toBe('HTTP/1.1 408 Request Timeout');
    expect((JSON.parse(sent.body) as Envelope).error.message).toBe('Client Timeout');
  });

  it('puts the same minted id on the header and in the body', async () => {
    const sent = await respondTo('HPE_HEADER_OVERFLOW');

    const { requestId } = (JSON.parse(sent.body) as Envelope).error;
    expect(requestId).toMatch(UUID);
    expect(sent.headers.get('x-request-id')).toBe(requestId);
  });

  it('mints rather than reading the rejected bytes, so no two responses share an id', async () => {
    // `err.rawPacket` does carry the client's `X-Request-Id` — MEASURED, present
    // on all three shapes — and this handler deliberately does not parse it. A
    // header parser run over input Node's own parser has just rejected is how
    // header injection gets in.
    const first = (JSON.parse((await respondTo('HPE_HEADER_OVERFLOW')).body) as Envelope).error;
    const second = (JSON.parse((await respondTo('HPE_HEADER_OVERFLOW')).body) as Envelope).error;

    expect(first.requestId).not.toBe(second.requestId);
  });

  it('states the framing a hand-written response has to state itself', async () => {
    // There is no FastifyReply here: no serialiser and no automatic
    // Content-Length. A wrong length hangs the client until it times out, and a
    // missing `connection: close` leaves a keep-alive client waiting on a socket
    // that is about to be destroyed.
    //
    // HONEST RESIDUAL, disclosed rather than dressed up: this cannot distinguish
    // `Buffer.byteLength(body)` from `body.length`. Every message this handler
    // can emit is ASCII today, so the two are equal, and no assertion reachable
    // from here can separate them. The handler uses `byteLength` because the day
    // one of those strings gains an accent — INTERNAL_ERROR_MESSAGE, one file
    // away, is already Spanish — `body.length` truncates the response by exactly
    // the number of multi-byte characters, and Fastify's own default has that
    // bug. What IS gated here is that the declared length matches the body at
    // all, which a wrong constant or an off-by-one would break.
    const sent = await respondTo('HPE_HEADER_OVERFLOW');

    expect(sent.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(sent.headers.get('connection')).toBe('close');
    expect(sent.headers.get('content-length')).toBe(String(Buffer.byteLength(sent.body, 'utf8')));
  });

  it('writes nothing on a connection the peer already reset', async () => {
    // Node's documented guidance, and Fastify's default. There is nothing to
    // answer on, and writing would raise EPIPE on a socket whose error listener
    // has already been removed.
    const sent = await respondTo('ECONNRESET');

    expect(sent.raw).toBe('');
  });

  it('writes nothing on an already-destroyed socket, which is what stops a loop', async () => {
    // `socket.destroy(error)` re-emits `error`, Node's HTTP server turns that
    // back into a `clientError`, and this handler is called a second time. The
    // `destroyed` guard is what makes that pass a no-op.
    const sent = await respondTo('HPE_HEADER_OVERFLOW', ({ serverSide }) => {
      serverSide.destroy();
    });

    expect(sent.raw).toBe('');
  });

  it('cannot take the process down when something in it throws', async () => {
    // A throw from a `clientError` listener is an uncaught exception, not a 500
    // — the same class of hazard as a throw out of the `frameworkErrors` hook,
    // which MEASURED as process exit 7. An error object whose `code` getter
    // throws stands in for the general case.
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const { serverSide, clientSide } = await socketPair(server);
      const hostile = new Error('hostile');
      Object.defineProperty(hostile, 'code', {
        get(): string {
          throw new Error('code getter exploded');
        },
      });

      expect(() => {
        handleClientError(hostile as never, serverSide);
      }).not.toThrow();

      expect(logged).toHaveBeenCalledTimes(1);
      expect(serverSide.destroyed).toBe(true);
      clientSide.destroy();
    } finally {
      server.close();
    }
  });
});
