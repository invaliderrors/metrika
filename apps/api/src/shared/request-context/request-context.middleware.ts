import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { normaliseRequestId, runWithRequestContext } from './request-context.js';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Registered exactly ONE of two ways, never both:
 *
 * - the composed app — `bootstrap.ts`, via `app.use()`, because it sets a global
 *   prefix and `MiddlewareConsumer` cannot escape one on platform-fastify;
 * - a prefix-free standalone module tree — `RequestContextModule`, via
 *   `MiddlewareConsumer`, which is what test module trees use.
 *
 * `@Injectable()` is load-bearing for the second: Nest resolves the class
 * through the injector when `consumer.apply()` names it. `bootstrap.ts`
 * constructs it by hand, which is why the decorator can look decorative there.
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
