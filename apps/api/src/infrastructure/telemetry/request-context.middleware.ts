import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { newCorrelationId } from '../../config/env.js';
import { requestContext } from '../telemetry/request-context.js';

/**
 * Reads or generates the correlation ID, plants it in AsyncLocalStorage,
 * echoes it on the response header so clients can quote it in support tickets.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: FastifyRequest['raw'], res: FastifyReply['raw'], next: () => void): void {
    const header = req.headers['x-metrika-correlation-id'];
    const correlationId =
      typeof header === 'string' && header.length > 0 ? header : newCorrelationId();
    res.setHeader('x-metrika-correlation-id', correlationId);
    requestContext.run({ correlationId }, next);
  }
}
