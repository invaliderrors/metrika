import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { DomainErrorCode } from '@metrika/contracts';

import { currentCorrelationId } from '../infrastructure/telemetry/request-context.js';

/**
 * One translation point from domain exceptions to HTTP. Nothing else in the
 * codebase writes a non-2xx response directly.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const correlationId = currentCorrelationId();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      void reply.status(status).send({
        statusCode: status,
        error: typeof response === 'string' ? response : (response as { message?: string }).message,
        code: mapStatusToCode(status),
        correlationId,
        path: request.url,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    this.logger.error({ err: exception, correlationId }, 'unhandled exception');
    void reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal server error',
      code: DomainErrorCode.INTERNAL,
      correlationId,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}

function mapStatusToCode(status: number): DomainErrorCode {
  switch (status) {
    case 400:
      return DomainErrorCode.VALIDATION_FAILED;
    case 401:
      return DomainErrorCode.UNAUTHENTICATED;
    case 403:
      return DomainErrorCode.FORBIDDEN;
    case 404:
      return DomainErrorCode.NOT_FOUND;
    case 409:
      return DomainErrorCode.CONFLICT;
    default:
      return DomainErrorCode.INTERNAL;
  }
}
