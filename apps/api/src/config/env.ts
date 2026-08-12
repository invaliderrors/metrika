import { z } from 'zod';

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().regex(/^postgresql:\/\//, 'must be a postgresql:// connection string'),
  /**
   * A LENGTH floor, not an entropy floor — `'aaaaaaaaaaaaaaaa'` validates, and
   * so does any sixteen-character word. Zod cannot measure entropy and a schema
   * that tried would reject legitimate high-entropy secrets, so the requirement
   * lives where the value is generated: use `openssl rand -hex 32`. Treat 16
   * characters as the point below which the value is definitely wrong, not the
   * point above which it is right.
   *
   * The floor is still load-bearing rather than cosmetic: MEASURED, with no
   * minimum an empty configured token plus a bare `Authorization: Bearer `
   * header hash-matches in DeepHealthGuard and /health/deep answers 200.
   */
  HEALTH_DEEP_TOKEN: z.string().min(16, 'must be at least 16 characters'),
  /**
   * Where this process sends error events. **Empty disables Sentry**, and that
   * is the local default rather than a placeholder: a developer with no Sentry
   * project boots with the same code path a deployment runs, minus a transport.
   *
   * Not `z.url()`: a DSN is a URL with structure Sentry itself validates, and a
   * second, weaker statement of that rule here would reject a valid DSN shape we
   * had not thought of while accepting a malformed one we had.
   */
  SENTRY_DSN: z.string().default(''),
  /**
   * The full OTLP/HTTP **traces** endpoint — `.../v1/traces`, not a base URL.
   *
   * Deliberately NOT spelled `OTEL_EXPORTER_OTLP_ENDPOINT`: that name belongs to
   * the OpenTelemetry SDK, which reads it from the environment itself and
   * appends the signal path to it. Two different meanings under one name is how
   * an endpoint ends up pointing one path segment away from a collector.
   *
   * Empty means no exporter is constructed at all, which is what a developer
   * without a collector wants — the correlation fields still reach every log
   * line, because they come from the live trace context rather than from the
   * exporter. `apps/workers` carries the same switch as
   * `METRIKA_WORKER_OTLP_ENDPOINT`.
   */
  OTLP_TRACES_ENDPOINT: z.string().default(''),
  /**
   * Head-based sampling, for BOTH sinks — it reaches OpenTelemetry through
   * `SentrySampler`, which is the one sampler on the shared provider.
   *
   * `0` is not "off with the correlation intact": a dropped span still has a
   * valid trace ID, so log lines keep `traceId` and `spanId` while nothing is
   * ever exported. Set it to `0` only when that is what is wanted.
   */
  TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),
});

export type Env = z.infer<typeof EnvSchema>;

export class EnvValidationError extends Error {
  constructor(issues: readonly z.core.$ZodIssue[]) {
    super(
      [
        'Environment configuration is invalid. Every problem, not just the first:',
        ...issues.map((issue) => {
          const path = issue.path.join('.');
          return `  ${path !== '' ? path : '(root)'}: ${issue.message}`;
        }),
        '',
        'Copy .env.example to .env and fill in the values it names.',
      ].join('\n'),
    );
    this.name = 'EnvValidationError';
  }
}

/**
 * Pure, so it can be unit-tested without touching the ambient environment.
 * Crashing at startup with a readable list beats a mysterious `undefined`
 * three layers into a request.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(result.error.issues);
  }
  return result.data;
}

export function loadEnv(): Env {
  return parseEnv(process.env);
}
