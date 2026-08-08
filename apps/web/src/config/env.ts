import { z } from 'zod';

/**
 * Web env. Only file allowed to read `process.env`.
 * `NEXT_PUBLIC_*` values are baked into the client bundle — never put secrets here.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:3001'),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse({
    NODE_ENV: process.env['NODE_ENV'],
    NEXT_PUBLIC_API_URL: process.env['NEXT_PUBLIC_API_URL'],
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'],
  });
  if (!parsed.success) {
    throw new Error(`Invalid web env: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}
