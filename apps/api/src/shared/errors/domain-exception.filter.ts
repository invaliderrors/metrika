import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Logger } from 'pino';
import { toLoggableError } from '../../infrastructure/telemetry/logger.js';
import { isDomainError } from './domain-error.js';
import {
  domainErrorResponse,
  frameworkErrorResponse,
  internalErrorResponse,
  isFrameworkRejection,
  type ErrorResponse,
} from './error-response.js';
import { getRequestId } from '../request-context/request-context.js';

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger: Logger;

  /**
   * Takes the sink rather than reaching for one, and is constructed by hand in
   * `bootstrap.ts` rather than by DI — which is what makes `import type
   * { Logger } from 'pino'` above safe. CLAUDE.md bans `import type` on a class
   * used in Nest constructor injection because it erases `design:paramtypes`;
   * nothing resolves this constructor, and pino's `Logger` is an interface with
   * no runtime value to import in the first place.
   *
   * The `context` binding is what Nest's own `ConsoleLogger` and `nestjs-pino`
   * both call the component that wrote a line, so it stays under that name. It
   * is a CHILD binding, which `formatters.log` never sees — `REDACTION_PATHS`
   * is what covers this shape, and `test/redaction.test.ts` asserts through it
   * for that reason.
   */
  constructor(logger: Logger) {
    this.logger = logger.child({ context: DomainExceptionFilter.name });
  }

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
    // literally zero bytes of output. MEASURED at 0.
    //
    // `error({ err }, message)` — ADR-0030, and the shape matters more than it
    // looks. The three-argument `Logger.error(message, stack, context)` that
    // ADR-0029 originally recommended DISCARDS the cause entirely at this call
    // site, and a raw-pino `LoggerService` discards the two-argument form's
    // cause too; both exit 0 and emit a plausible-looking line. `{ err }` with
    // an Error INSTANCE is the one shape measured clean under both candidate
    // adapters — a STRING in `err` serialises as a scalar, which `err.message`
    // and `err.stack` cannot match, and leaks with redaction on.
    //
    // `requestId` goes in the MESSAGE and not only in the field because it is
    // the string a support ticket carries; nothing else about this exception is
    // in `msg`, which is the rule that keeps untrusted text out of a field
    // redaction can only censor wholesale.
    this.logger.error(
      { err: toLoggableError(exception) },
      `Unhandled exception (requestId=${requestId})`,
    );
    send(reply, internalErrorResponse(requestId));
  }
}

function send(reply: FastifyReply, { status, body }: ErrorResponse): void {
  void reply.status(status).send(body);
}
