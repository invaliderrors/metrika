import { Catch, type ArgumentsHost, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { isDomainError } from './domain-error.js';
import { DOMAIN_ERROR_RESPONSE } from './error-mapping.js';
import { getRequestId } from '../request-context/request-context.js';

interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly requestId: string;
    readonly retryable: boolean;
  };
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const requestId = getRequestId();

    if (isDomainError(exception)) {
      const { status, retryable } = DOMAIN_ERROR_RESPONSE[exception.code];
      const envelope: ErrorEnvelope = {
        error: {
          code: exception.code,
          message: exception.message,
          ...(exception.details !== undefined && { details: exception.details }),
          requestId,
          retryable,
        },
      };
      void reply.status(status).send(envelope);
      return;
    }

    if (exception instanceof HttpException) {
      const envelope: ErrorEnvelope = {
        error: {
          code: 'VALIDATION_FAILED',
          message: exception.message,
          requestId,
          retryable: false,
        },
      };
      void reply.status(exception.getStatus()).send(envelope);
      return;
    }

    // Everything else. The original message and stack stay on this side of the
    // boundary; `requestId` is the only thing a support conversation needs to
    // find the full trace. Structured logging of the cause lands with the
    // telemetry bootstrap in Plan 0C.
    const envelope: ErrorEnvelope = {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Ha ocurrido un error inesperado.',
        requestId,
        retryable: false,
      },
    };
    void reply.status(DOMAIN_ERROR_RESPONSE.INTERNAL_ERROR.status).send(envelope);
  }
}
