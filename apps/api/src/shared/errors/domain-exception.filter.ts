import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { DomainErrorCode } from '@metrika/contracts';
import type { FastifyReply } from 'fastify';
import { isDomainError } from './domain-error.js';
import {
  DOMAIN_ERROR_RESPONSE,
  FRAMEWORK_ERROR_CODE,
  FRAMEWORK_FALLBACK_CODE,
} from './error-mapping.js';
import { getRequestId } from '../request-context/request-context.js';

interface ErrorEnvelope {
  readonly error: {
    /**
     * `DomainErrorCode`, not `string`. Typing it loosely is what let this filter
     * ship `VALIDATION_FAILED` at 404, 500 and 503 while the mapping table
     * pinned it at 400 — a response that contradicted the published contract and
     * that no test over the MAP could ever have caught.
     */
    readonly code: DomainErrorCode;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly requestId: string;
    readonly retryable: boolean;
  };
}

/** Localised and fixed. Never derived from the exception — see {@link describeCause}. */
const INTERNAL_ERROR_MESSAGE = 'Ha ocurrido un error inesperado.';

/**
 * What goes in the LOG. Never in the response, and never in the same string as
 * anything the client sees.
 */
function describeCause(exception: unknown): string {
  if (exception instanceof Error) {
    return exception.stack ?? `${exception.name}: ${exception.message}`;
  }
  // A thrown non-Error is arbitrary data — a plain object carrying a password is
  // a real shape this has been probed with — so it is described, not
  // stringified. Redaction belongs with Plan 0C's structured logging, and until
  // that exists the conservative choice is to write nothing that could contain a
  // secret.
  return `non-Error thrown (typeof ${typeof exception})`;
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const requestId = getRequestId();

    if (isDomainError(exception)) {
      this.send(reply, exception.code, exception.message, requestId, exception.details);
      return;
    }

    // A FRAMEWORK 4xx: an unmatched route, a guard, a body over the limit. Its
    // message is the framework's own and is safe to forward at this level.
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
    if (exception instanceof HttpException && exception.getStatus() < 500) {
      const status = exception.getStatus();
      this.send(
        reply,
        FRAMEWORK_ERROR_CODE[status] ?? FRAMEWORK_FALLBACK_CODE,
        exception.message,
        requestId,
      );
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
    this.send(reply, 'INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE, requestId);
  }

  /**
   * The ONE place a status or a `retryable` flag is chosen, and both are read
   * from `DOMAIN_ERROR_RESPONSE` for whatever code the caller picked.
   *
   * Every branch above goes through here on purpose. Writing `retryable: false`
   * by hand next to a lookup of `status` — which is what two of the three
   * branches used to do — makes the wire silently disagree with the mapping
   * table the moment that table changes, and the disagreement is invisible to
   * any test that only reads the table.
   */
  private send(
    reply: FastifyReply,
    code: DomainErrorCode,
    message: string,
    requestId: string,
    details?: Readonly<Record<string, unknown>>,
  ): void {
    const { status, retryable } = DOMAIN_ERROR_RESPONSE[code];
    const envelope: ErrorEnvelope = {
      error: {
        code,
        message,
        ...(details !== undefined && { details }),
        requestId,
        retryable,
      },
    };
    void reply.status(status).send(envelope);
  }
}
