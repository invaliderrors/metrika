import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { isDomainError } from './domain-error.js';
import {
  domainErrorResponse,
  frameworkErrorResponse,
  internalErrorResponse,
  isFrameworkRejection,
  type ErrorResponse,
} from './error-response.js';
import { getRequestId } from '../request-context/request-context.js';

/**
 * What goes in the LOG. Never in the response, and never in the same string as
 * anything the client sees.
 *
 * NOTE FOR PLAN 0C: an `Error`'s stack carries its message, so the DSN this
 * filter now keeps out of the response is still written here. That is acceptable
 * only while the sink is stdout on a machine an operator already owns. Before 0C
 * ships a log sink or a Sentry DSN, this needs redaction — do not inherit it
 * silently on the grounds that it was "already like that".
 */
function describeCause(exception: unknown): string {
  if (exception instanceof Error) {
    return exception.stack ?? `${exception.name}: ${exception.message}`;
  }
  // A thrown non-Error is arbitrary data — a plain object carrying a password is
  // a real shape this has been probed with — so it is described, not
  // stringified.
  return `non-Error thrown (typeof ${typeof exception})`;
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const requestId = getRequestId();

    if (isDomainError(exception)) {
      send(
        reply,
        domainErrorResponse(exception.code, exception.message, requestId, exception.details),
      );
      return;
    }

    // A FRAMEWORK 4xx: an unmatched route, a guard, a body over the limit. Its
    // message is the framework's own and is safe to forward at this level, and
    // its STATUS is the framework's decision — see `frameworkErrorResponse`.
    //
    // The `< 500` is load-bearing and is why this branch is not simply "is an
    // HttpException". MEASURED: `HttpException` is the class every Nest library
    // throws, and its `message` was going out verbatim — an
    // InternalServerErrorException carrying a DSN put
    // `postgres://user:PASSWORD@host/db` on the wire, and a
    // ServiceUnavailableException named an unreachable internal pod. The
    // concrete near-term case is @nestjs/terminus, which signals an unhealthy
    // check by throwing ServiceUnavailableException carrying per-indicator
    // detail. A 5xx from any library is a condition WE failed at, so it falls
    // through to the generic branch below and is logged rather than described to
    // the client.
    // Both bounds, not just `< 500`: MEASURED, with only an upper bound a
    // `new HttpException('x', 302)` from any library produced a full error
    // envelope at 302 — a status no client branches on as an error.
    if (exception instanceof HttpException && isFrameworkRejection(exception.getStatus())) {
      send(reply, frameworkErrorResponse(exception.getStatus(), exception.message, requestId));
      return;
    }

    // Everything else, plus every 5xx above. The original message and stack stay
    // on this side of the boundary; `requestId` is what ties this log line to
    // the response the client is holding.
    //
    // Logged HERE rather than left to Nest: `ExceptionsHandler` logs an
    // unhandled exception only when no custom filter handles it, and this filter
    // handles everything, so without this line an unexpected 500 produced
    // literally zero bytes of output. MEASURED at 0. This is a deliberately
    // plain `Logger.error`; structured logging, Sentry and redaction arrive with
    // the telemetry bootstrap in Plan 0C.
    this.logger.error(`Unhandled exception (requestId=${requestId})`, describeCause(exception));
    send(reply, internalErrorResponse(requestId));
  }
}

function send(reply: FastifyReply, { status, body }: ErrorResponse): void {
  void reply.status(status).send(body);
}
