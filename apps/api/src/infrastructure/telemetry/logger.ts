import pino from 'pino';

import type { Env } from '../../config/env.js';
import { currentCorrelationId } from './request-context.js';

/**
 * Secrets and auth headers that must never land in logs.
 * Extend when a new credential-bearing field appears.
 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'clientSecret',
  'webhookSecret',
  'DATABASE_URL',
  'CLERK_SECRET_KEY',
  'S3_SECRET_ACCESS_KEY',
];

export function createLogger(env: Env): pino.Logger {
  return pino({
    name: env.serviceName,
    level: env.LOG_LEVEL,
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
    mixin() {
      const correlationId = currentCorrelationId();
      return correlationId !== undefined ? { correlationId } : {};
    },
    ...(env.NODE_ENV === 'development' && {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l' },
      },
    }),
  });
}
