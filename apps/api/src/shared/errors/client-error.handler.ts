import { STATUS_CODES } from 'node:http';
import type { Socket } from 'node:net';
import { Logger } from '@nestjs/common';
import type { ConnectionError } from 'fastify';
import { frameworkErrorResponse } from './error-response.js';
import { normaliseRequestId } from '../request-context/request-context.js';
import { REQUEST_ID_HEADER } from '../request-context/request-context.middleware.js';

const logger = new Logger('ClientError');

/**
 * The failures that never reach a `FastifyRequest` at all, because Node's HTTP
 * parser rejected the bytes before a request object could be built. They are
 * delivered on the server's `clientError` event, which Fastify forwards to
 * `options.clientErrorHandler` (fastify.js:448) — a hook `frameworkErrors` does
 * not cover and cannot, since there is nothing to reply to yet.
 *
 * MEASURED against the real `dist/main.js` before this handler existed, over a
 * raw socket:
 *
 *   header block > 16 KB
 *     431 {"error":"Request Header Fields Too Large",
 *          "message":"Exceeded maximum allowed HTTP header size","statusCode":431}
 *   `G@T /health/live HTTP/1.1`   (invalid method token)
 *     400 {"error":"Bad Request","message":"Client Error","statusCode":400}
 *   `X-Fold: a\r\n b`             (obs-fold continuation line)
 *     400, same body
 *
 *   ...and ZERO `x-request-id` headers on any of the three.
 *
 * That is byte-for-byte the defect already fixed for `FST_ERR_BAD_URL`: `error`
 * is a STRING where `ApiErrorResponse` declares an object, `code` is absent
 * entirely, and there is no request id in the body or on the header. A client
 * parsing with the published contract fails outright.
 *
 * ## Why this is written by hand
 *
 * The hook receives a raw `net.Socket`, not a `FastifyReply`. There is no
 * serialiser, no `reply.header()`, no automatic `Content-Length` — the status
 * line and every header below are ours to get right. `Content-Length` is
 * therefore computed in BYTES from the encoded buffer, not from `body.length`:
 * Fastify's own default uses the string length, which is only correct while the
 * body stays ASCII, and `INTERNAL_ERROR_MESSAGE` is Spanish.
 *
 * `Connection: close` is stated explicitly because the socket is destroyed
 * immediately afterwards; without it a keep-alive client is told nothing and
 * discovers the close as a transport error rather than as the end of a response.
 *
 * ## Why the request id is always minted
 *
 * A 431 means the header block was never parsed, so there is no
 * `request.headers` to read a client value from. `err.rawPacket` does hold the
 * raw bytes (MEASURED: present on all three shapes, `HPE_HEADER_OVERFLOW`,
 * `HPE_INVALID_METHOD`, `HPE_INVALID_HEADER_TOKEN`) and a client-supplied
 * `X-Request-Id` is often visible in it — but recovering it would mean running a
 * header parser over input that Node's own parser has just rejected, which is
 * how header injection and request smuggling get in. Deliberately not done.
 *
 * `normaliseRequestId(undefined)` rather than `randomUUID()` so that
 * `normaliseRequestId` stays the ONLY thing in this app that decides whether a
 * request id is acceptable and what to do when there is none. If a future change
 * ever does obtain a client value here, it goes through that same function, and
 * its allowlist (`[A-Za-z0-9._-]{1,128}`) is what keeps a CR or LF out of the
 * header block written below.
 */
export function handleClientError(error: ConnectionError, socket: Socket): void {
  try {
    respond(error, socket);
  } catch (cause: unknown) {
    // A throw here is an unhandled `clientError` listener, which is an uncaught
    // exception and takes the process down — the same class of hazard as a throw
    // out of the `frameworkErrors` hook, which MEASURED as process exit 7. The
    // catch is what makes this handler's safety a property of this file rather
    // than of Node's parse-error set.
    //
    // The irreducible floor, as in framework-error.handler.ts: if `logger.error`
    // or `socket.destroy` themselves throw, there is nothing left to report with.
    logger.error('Client error handler failed', cause instanceof Error ? cause.stack : undefined);
    socket.destroy();
  }
}

/**
 * llhttp's parse-failure code to the status Fastify's own default answers with.
 * Kept identical on purpose: this change is about the ENVELOPE and the request
 * id, and a status that moved with it would be a second, unrelated wire change
 * hidden inside a bug fix.
 */
const CLIENT_ERROR_STATUS: Readonly<Record<string, number>> = {
  ERR_HTTP_REQUEST_TIMEOUT: 408,
  HPE_HEADER_OVERFLOW: 431,
};

/** Everything else Node's parser rejects. */
const CLIENT_ERROR_FALLBACK_STATUS = 400;

/**
 * Fastify's own wording for each class, preserved. These are `message` in the
 * envelope, which `ApiErrorResponse` documents as localised — the same gap the
 * router-level 4xx path already has, tracked once rather than twice.
 *
 * Fixed strings, never `error.message`: llhttp's text ("Parse Error: Header
 * overflow") describes Node's parser rather than the request, and nothing in it
 * helps a caller.
 */
const CLIENT_ERROR_MESSAGE: Readonly<Record<number, string>> = {
  408: 'Client Timeout',
  431: 'Exceeded maximum allowed HTTP header size',
};

/** The wording for {@link CLIENT_ERROR_FALLBACK_STATUS}. */
const CLIENT_ERROR_FALLBACK_MESSAGE = 'Client Error';

function respond(error: ConnectionError, socket: Socket): void {
  // Node's documented guidance for `clientError`, and Fastify's default: a reset
  // connection has nothing left to answer on. Load-bearing beyond politeness —
  // `socket.destroy(error)` below re-emits `error` on the socket, Node's HTTP
  // server turns that back into a `clientError`, and this early return is what
  // makes the second pass a no-op instead of a loop.
  if (error.code === 'ECONNRESET' || socket.destroyed) return;

  const status = CLIENT_ERROR_STATUS[error.code] ?? CLIENT_ERROR_FALLBACK_STATUS;
  const requestId = normaliseRequestId(undefined);
  const message = CLIENT_ERROR_MESSAGE[status] ?? CLIENT_ERROR_FALLBACK_MESSAGE;

  // All three statuses are 4xx by construction, so this always takes the
  // describable branch and the body is the same envelope every other 4xx in this
  // API produces. 408 and 431 have no row in FRAMEWORK_ERROR_CODE and so take
  // the sanctioned fallback code at their own status.
  const { body } = frameworkErrorResponse(status, message, requestId);
  const payload = Buffer.from(JSON.stringify(body), 'utf8');

  const head = Buffer.from(
    `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? 'Bad Request'}\r\n` +
      `${REQUEST_ID_HEADER}: ${requestId}\r\n` +
      `content-type: application/json; charset=utf-8\r\n` +
      `content-length: ${String(payload.byteLength)}\r\n` +
      `connection: close\r\n\r\n`,
    'utf8',
  );

  // One write, so the response cannot be torn in half by the destroy below.
  if (socket.writable) socket.write(Buffer.concat([head, payload]));
  socket.destroy(error);
}
