import { Logger } from '@nestjs/common';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { frameworkErrorResponse, internalErrorResponse } from './error-response.js';
import { normaliseRequestId } from '../request-context/request-context.js';
import { REQUEST_ID_HEADER } from '../request-context/request-context.middleware.js';

const logger = new Logger('FrameworkError');

/**
 * Passed to Fastify's `frameworkErrors` hook BY REFERENCE, with no type
 * assertion — worth stating, because it did not compile that way until the two
 * Fastify copies in this tree were deduplicated. `apps/api` pinned 5.6.1 while
 * `@nestjs/platform-fastify@11.1.28` resolved 5.10.0, so these
 * identically-named types came from different packages and were not assignable
 * to one another; the diagnostic named both `.pnpm` paths, which is the only
 * reason it was diagnosable at all.
 *
 * RE-MEASURED after the dedupe: the plain `FastifyRequest`/`FastifyReply`
 * annotation is assignable to the hook, and the assertion that used to stand at
 * the wiring point in bootstrap.ts is gone. If it ever comes back, look for a
 * second `fastify` under node_modules/.pnpm before anything else.
 */

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
  request: FastifyRequest,
  reply: FastifyReply,
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
