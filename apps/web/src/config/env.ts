import { z } from 'zod';
import { SUPPORTED_LOCALES } from '../i18n/routing';

/**
 * Re-exported, not declared here. The list itself lives in `../i18n/routing.ts`
 * so that a module wanting only the locales does not have to import THIS file,
 * whose `clientEnv` parse at the bottom runs on import and therefore demands a
 * populated environment from `next build`. That header explains the failure in
 * full. Every existing importer of `SUPPORTED_LOCALES` / `SupportedLocale` from
 * here keeps working.
 */
export { SUPPORTED_LOCALES };
export type { SupportedLocale } from '../i18n/routing';

const PublicKeys = {
  NEXT_PUBLIC_API_BASE_URL: z.string().regex(/^https?:\/\//, 'must be an http:// or https:// URL'),
  NEXT_PUBLIC_DEFAULT_LOCALE: z.enum(SUPPORTED_LOCALES),
};

export const ClientEnvSchema = z.object(PublicKeys);
export type ClientEnv = z.infer<typeof ClientEnvSchema>;

export const ServerEnvSchema = z.object({
  ...PublicKeys,
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});
export type ServerEnv = z.infer<typeof ServerEnvSchema>;

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

/** Pure, so it can be unit-tested without touching the ambient environment. */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = ServerEnvSchema.safeParse(source);
  if (!result.success) throw new EnvValidationError(result.error.issues);
  return result.data;
}

export function loadServerEnv(): ServerEnv {
  return parseServerEnv(process.env);
}

/**
 * Each key is read by its FULL LITERAL TEXT, and the object is built by hand.
 *
 * Next's `NEXT_PUBLIC_` support is a textual substitution performed at build
 * time on the exact string `process.env.NEXT_PUBLIC_WHATEVER`. Any indirection
 * — a computed member access with the key in a variable, destructuring
 * `process.env`, spreading it, aliasing it to a local — is not substituted,
 * type-checks cleanly, passes every server-side test, and evaluates to
 * `undefined` in the browser. A loop over a key list would be tidier and would
 * silently ship a broken client bundle.
 *
 * Note the phrasing above avoids writing the computed form out. That is not
 * squeamishness: `test/env-inlining.test.ts` greps THIS FILE's text for it, and
 * a regex over source cannot tell a comment from code. Describing the banned
 * form in prose is the cost of a check cheap enough to actually run.
 *
 * The two accesses below compile only because `./process-env.d.ts` declares
 * these keys on `NodeJS.ProcessEnv`; without it `noPropertyAccessFromIndexSignature`
 * rejects both with TS4111 and pushes you toward the one form Next will not
 * substitute. That file carries the full reasoning.
 *
 * Parsed at module scope so a misconfigured deployment fails at build, not on
 * a user's first render. `vitest.config.ts` supplies both keys for the same
 * reason: importing this module runs this parse.
 *
 * THAT SENTENCE IS ONLY TRUE WHILE SOMETHING THE APP ROUTER REACHES IMPORTS
 * `clientEnv`, and for a while nothing did. A module-scope parse in a module
 * nobody imports runs at no scope at all: MEASURED, with both keys unset,
 * `turbo run build` exited 0 and inlined neither value. `src/app/layout.tsx` is
 * the importer that closes that — it derives the API origin it preconnects to
 * from `NEXT_PUBLIC_API_BASE_URL` — and with it in place the same command exits
 * 1 with this schema's ZodError naming both keys.
 *
 * So the guarantee is a property of the import graph, not of this file. If the
 * layout ever stops consuming the value, restore the guarantee somewhere else
 * on the same path rather than assuming this comment still holds.
 */
export const clientEnv: ClientEnv = ClientEnvSchema.parse({
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  NEXT_PUBLIC_DEFAULT_LOCALE: process.env.NEXT_PUBLIC_DEFAULT_LOCALE,
});
