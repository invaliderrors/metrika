import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { withRequestBaggage } from '../../infrastructure/telemetry/index.js';
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
  /**
   * TWO bindings, because the request ID has to reach two different kinds of
   * reader and they fail separately.
   *
   * `runWithRequestContext` is Plan 0B-1's `AsyncLocalStorage`, which is what
   * this process reads — the exception filter's `getRequestId()`, the error body,
   * and the `logHook` that puts `requestId` on every Pino line.
   * `withRequestBaggage` is OpenTelemetry baggage, which is what the NEXT process
   * reads: `apps/workers` pulls `metrika.request_id` off the wire and binds it to
   * every structlog line. Neither substitutes for the other, and a fixture that
   * asserts one is blind to the other going missing.
   *
   * Baggage is set INSIDE the ALS scope so the two nest rather than race; both
   * wrap `next()`, and the rest of the request runs inside that call, which is
   * what carries both bindings across the `await`s in a handler.
   *
   * This runs after `@fastify/otel`'s `onRequest` hook — that plugin is
   * registered through the `fastify.initialization` diagnostics channel while
   * `new FastifyAdapter()` is still constructing the instance, i.e. before Nest
   * flushes middie — so `context.active()` here already carries the request span
   * and the baggage lands on the context the handler sees rather than on a
   * detached root.
   */
  use(request: FastifyRequest['raw'], response: FastifyReply['raw'], next: () => void): void {
    const requestId = normaliseRequestId(request.headers[REQUEST_ID_HEADER]);
    // Set before next(): the header has to be on the response even when the
    // handler throws, and an exception filter runs after the headers object
    // has already been handed to Fastify.
    response.setHeader(REQUEST_ID_HEADER, requestId);
    runWithRequestContext({ requestId }, () => {
      withRequestBaggage(requestId, next);
    });
  }
}
