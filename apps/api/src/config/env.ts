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
   * project boots without a transport.
   *
   * **It disables more than the transport, and that is worth knowing before
   * concluding anything from a local run.** `@sentry/node` does not reach
   * `_setupIntegrations()` for a client with no DSN, so with this empty the
   * process constructs ZERO Sentry integrations — the allowlist below it is
   * subtracted from an empty set, and the decorator collision that exits 1 with
   * the defaults left on cannot happen. ADR-0034 records a whole ADR written from
   * a measurement taken in that state. `test/telemetry.integration.test.ts` sets
   * a real DSN against a local sink for exactly this reason.
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
   *
   * **The default is `1`, and a deployment that leaves it there samples
   * everything.** Kept, on the grounds that it is inert until somebody
   * configures a sink — no OTLP endpoint and no DSN means nothing is sent at any
   * rate — and that the act of configuring one is the moment to choose a rate.
   * The trigger for making it required instead: the first deployment that sets
   * `SENTRY_DSN` or `OTLP_TRACES_ENDPOINT` without setting this.
   *
   * **It is a FLOOR, not a ceiling, and that is measured in both directions.**
   * A `traceparent` arriving with the sampled flag SET is always honoured —
   * exported even at `0` — because `getSamplingDecision` returns `true` for a set
   * flag and `sampleSpan` inherits a defined `parentSampled` before it ever looks
   * at this value. A CLEARED flag is not honoured: it reads as `undefined` and
   * falls through to this rate. MEASURED at `0`: the `-01` traces exported in
   * full (6 and 8 spans), the `-00` traces exported nothing.
   *
   * So this cannot hold sampling DOWN. Any caller that sends `-01` pins this API
   * at 100%, and the header is caller-supplied. What it cannot do is drop a
   * caller's sampled trace, so there is no orphaned-child failure here — which is
   * the opposite of what this comment said before the measurement was taken
   * (ADR-0034). Both directions are asserted in
   * `test/telemetry.integration.test.ts`, the rate-0 half in its own child.
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
