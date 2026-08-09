import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { normaliseRequestId, runWithRequestContext } from './request-context.js';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Registered globally from bootstrap.ts via `app.use()`, not through a module's
 * `MiddlewareConsumer` — see the measured explanation there. It keeps the
 * `NestMiddleware` shape so it can move back to a consumer unchanged if the
 * adapter's prefix handling is ever fixed.
 *
 * If anything is ever added here that needs the request path, read
 * `request.originalUrl`, not `request.url`. Nest's Fastify adapter runs
 * middleware through its bundled `middie` clone, which rewrites `req.url` to be
 * relative to the mount match for the duration of the middleware call and
 * restores it afterwards. A request-context middleware is the single most
 * likely place for that to be stamped into a log line, where it would be
 * silently wrong on every entry.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: FastifyRequest['raw'], response: FastifyReply['raw'], next: () => void): void {
    const requestId = normaliseRequestId(request.headers[REQUEST_ID_HEADER]);
    // Set before next(): the header has to be on the response even when the
    // handler throws, and an exception filter runs after the headers object
    // has already been handed to Fastify.
    response.setHeader(REQUEST_ID_HEADER, requestId);
    runWithRequestContext({ requestId }, next);
  }
}
