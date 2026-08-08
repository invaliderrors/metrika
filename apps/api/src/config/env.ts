import { randomUUID } from 'node:crypto';

import { z } from 'zod';

/**
 * Single source of truth for API env.
 * `process.env` is read here and only here (enforced by lint rule).
 * Missing/invalid values crash the process at startup with a readable list.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),

  TEMPORAL_ADDRESS: z.string().min(1),
  TEMPORAL_NAMESPACE: z.string().min(1).default('default'),
  TEMPORAL_TLS_CERT_PATH: z.string().optional(),
  TEMPORAL_TLS_KEY_PATH: z.string().optional(),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_JWKS_URL: z.string().url().optional(),

  // Correlation ID header — must match web + worker convention.
  CORRELATION_HEADER: z.string().default('x-metrika-correlation-id'),
});

export type Env = z.infer<typeof EnvSchema> & { serviceName: string };

export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console -- startup crash report
    console.error('Invalid environment configuration:');
    for (const issue of parsed.error.issues) {
      // eslint-disable-next-line no-console -- startup crash report
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return {
    ...parsed.data,
    serviceName: 'metrika-api',
  };
}

export const newCorrelationId = (): string => randomUUID();
