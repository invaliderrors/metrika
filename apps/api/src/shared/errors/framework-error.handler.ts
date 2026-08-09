import type { IncomingHttpHeaders } from 'node:http';
import { Logger } from '@nestjs/common';
import type { FastifyError } from 'fastify';
import { frameworkErrorResponse, internalErrorResponse } from './error-response.js';
import { normaliseRequestId } from '../request-context/request-context.js';
import { REQUEST_ID_HEADER } from '../request-context/request-context.middleware.js';

const logger = new Logger('FrameworkError');

/**
 * The request and reply are typed by what this handler TOUCHES rather than as
 * `FastifyRequest`/`FastifyReply`, and that is load-bearing rather than
 * fastidious. Fastify declares `frameworkErrors` as a GENERIC function type
 * whose request parameter is `FastifyRequest<RequestGenericInterface, …>`, while
 * `FastifyRequest`'s own default first type argument is `RouteGenericInterface`
 * — so a handler annotated with the plain aliases is not assignable to the hook
 * (TS2322), and an inline arrow gets no contextual type at all because
 * `FastifyAdapter`'s constructor takes a UNION of option shapes (TS7006).
 * Narrow structural parameters are contravariantly satisfied by the real
 * objects, so this function can simply be passed by reference — and they make
 * the unit test a plain object literal instead of a cast.
 */
export interface FrameworkErrorRequest {
  readonly headers: IncomingHttpHeaders;
}

export interface FrameworkErrorReply {
  statusCode: number;
  header: (name: string, value: string) => unknown;
  send: (payload: unknown) => unknown;
}

/**
 * The failures that never reach the exception filter, because find-my-way raises
 * them before Nest's pipeline exists.
 *
 * MEASURED on the real bootstrap, prefixed and unprefixed, before this handler:
 *
 *   GET /api/v1/%zz
 *     400 {"error":"Bad Request","code":"FST_ERR_BAD_URL",
 *          "message":"'/api/v1/%zz' is not a valid url component","statusCode":400}
 *     x-request-id: null
 *
 * Three separate breakages in one response: `error` is a string where
 * `ApiErrorResponse` declares an object, so a client parsing the contract fails
 * outright; `code` is a Fastify constant and not a `DomainErrorCode`; and there
 * is no request id in the body OR on the header, so a support conversation about
 * it has nothing to trace. The request-context middleware is skipped for the
 * same reason the filter is, which is why this mints its own id rather than
 * calling `getRequestId()` — there is no async-local context here to read.
 *
 * Wired through Fastify's `frameworkErrors` option in `bootstrap.ts`. That hook,
 * rather than `setErrorHandler`, because this class of error is precisely what
 * it exists for; `setErrorHandler` sits at a different point and Nest's adapter
 * already owns it.
 */
export function handleFrameworkError(
  error: FastifyError,
  request: FrameworkErrorRequest,
  reply: FrameworkErrorReply,
): void {
  const requestId = normaliseRequestId(request.headers[REQUEST_ID_HEADER]);
  reply.header(REQUEST_ID_HEADER, requestId);

  const status = typeof error.statusCode === 'number' ? error.statusCode : 500;

  // Same rule as the filter: a 4xx is the framework rejecting the request and
  // may describe itself; a 5xx is ours, so it is logged and never described.
  if (status < 500) {
    const response = frameworkErrorResponse(status, error.message, requestId);
    reply.statusCode = response.status;
    reply.send(response.body);
    return;
  }

  logger.error(`Framework error (requestId=${requestId})`, error.stack ?? error.message);
  const response = internalErrorResponse(requestId);
  reply.statusCode = response.status;
  reply.send(response.body);
}
