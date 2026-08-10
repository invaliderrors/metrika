/**
 * The locale list, and NOTHING ELSE THAT RUNS. This module must stay free of
 * imports from `../config/env`, and that is a build constraint rather than a
 * preference.
 *
 * `config/env.ts` parses `clientEnv` at MODULE SCOPE, deliberately, so a
 * misconfigured deployment fails at build rather than on a user's first render.
 * The consequence is that anything reachable from the App Router which imports
 * that module drags the parse into `next build`. MEASURED: with
 * `SUPPORTED_LOCALES` imported from there, `next build` aborts with
 * "Failed to collect page data for /" and a ZodError naming both
 * `NEXT_PUBLIC_` keys — because a bare `next build` has no environment, no
 * `.env` is committed, and turbo does not forward one. A locale list is not
 * environment configuration; it is a domain constant that the environment
 * schema happens to validate against, so it lives here and `config/env.ts`
 * imports it in that direction.
 *
 * `config/env.ts` re-exports both names, so its own API is unchanged and either
 * import path is correct.
 */
export const SUPPORTED_LOCALES = ['es-CO', 'en-US'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * `es-CO` is the only locale with real copy at MVP. `en-US` exists so the
 * catalogue structure is exercised from day one — retrofitting message
 * extraction across a built UI is far more expensive than this tax.
 *
 * A literal, not `clientEnv.NEXT_PUBLIC_DEFAULT_LOCALE`. That key configures
 * which locale a DEPLOYMENT serves; this constant is the fallback the
 * catalogues are guaranteed to be complete for. Reading the env here would also
 * reintroduce the import this file's header exists to forbid.
 */
export const DEFAULT_LOCALE: SupportedLocale = 'es-CO';
