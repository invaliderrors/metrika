import { Logger } from '@nestjs/common';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  frameworkErrorResponse,
  internalErrorResponse,
  isFrameworkRejection,
} from './error-response.js';
import { NO_REQUEST_ID, normaliseRequestId } from '../request-context/request-context.js';
import { REQUEST_ID_HEADER } from '../request-context/request-context.middleware.js';

const logger = new Logger('FrameworkError');

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
 * 400 is not the only status that arrives here with no application code
 * involved: `FST_ERR_MAX_PARAM_LENGTH` produces a 414 on any route with a
 * `:param`.
 *
 * Wired through Fastify's `frameworkErrors` option in `bootstrap.ts`. That hook,
 * rather than `setErrorHandler`, because this class of error is precisely what
 * it exists for; `setErrorHandler` sits at a different point and Nest's adapter
 * already owns it.
 *
 * Passed to the hook BY REFERENCE, with no type assertion — worth stating,
 * because it did not compile that way until the two Fastify copies in this tree
 * were deduplicated. `apps/api` pinned 5.6.1 while
 * `@nestjs/platform-fastify@11.1.28` resolved 5.10.0, so these identically-named
 * types came from different packages and were not assignable to one another.
 * RE-MEASURED after the dedupe: the plain annotation is assignable. If the
 * assertion ever comes back, look for a second `fastify` under
 * node_modules/.pnpm before anything else.
 */
export function handleFrameworkError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  try {
    respond(error, request, reply);
  } catch (cause: unknown) {
    // A throw from this hook escapes Fastify's HTTP request listener entirely —
    // MEASURED against standalone fastify@5.10.0, `UNCAUGHT: hook exploded` and
    // process exit 7. Not a 500, not a hung socket: the process is gone.
    //
    // Two shapes reach it. `error.statusCode` outside 100–599 makes
    // `reply.statusCode = …` throw FST_ERR_BAD_STATUS_CODE, which the 4xx bound
    // in `respond` now prevents; and a request with no `headers` at all throws a
    // TypeError, which nothing prevents. Neither is reachable through Fastify
    // 5.10.0's three `frameworkErrors` call sites TODAY — which is exactly the
    // problem, because that makes this handler's safety a property of somebody
    // else's error set rather than of this file. The catch is what makes it a
    // property of this file.
    //
    // The one floor left is `reply.send` itself throwing, which cannot be
    // handled from inside the thing that would have to report it.
    logger.error(
      'Framework error handler failed',
      cause instanceof Error ? cause.stack : undefined,
    );
    reply.statusCode = 500;
    reply.send(internalErrorResponse(NO_REQUEST_ID).body);
  }
}

function respond(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  const requestId = normaliseRequestId(request.headers[REQUEST_ID_HEADER]);
  const status = typeof error.statusCode === 'number' ? error.statusCode : 500;

  // Same rule as the filter: a 4xx is the framework rejecting the request and
  // may describe itself; anything else is ours, so it is logged and never
  // described. "Anything else" is both ends deliberately — MEASURED, with only
  // an upper bound a `statusCode` of 200 or 302 emitted a full error envelope AT
  // 200/302, a shape no client branches on as an error.
  const describable = isFrameworkRejection(status);

  if (!describable) {
    logger.error(`Framework error (requestId=${requestId})`, error.stack ?? error.message);
  }

  const response = describable
    ? frameworkErrorResponse(status, error.message, requestId)
    : internalErrorResponse(requestId);

  // Everything above is computed before the reply is touched, so a failure
  // cannot leave a half-written response behind.
  reply.header(REQUEST_ID_HEADER, requestId);
  reply.statusCode = response.status;
  reply.send(response.body);
}
