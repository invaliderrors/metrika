import { z } from 'zod';

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().regex(/^postgresql:\/\//, 'must be a postgresql:// connection string'),
  HEALTH_DEEP_TOKEN: z.string().min(16, 'must be at least 16 characters'),
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
