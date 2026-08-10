/**
 * Declares the two `NEXT_PUBLIC_` keys on `NodeJS.ProcessEnv`, so that the
 * literal accesses at the bottom of `./env.ts` compile.
 *
 * This exists because of a head-on collision between two requirements that are
 * both non-negotiable:
 *
 *   - `noPropertyAccessFromIndexSignature` is on repo-wide
 *     (packages/typescript-config/base.json), and `ProcessEnv` reaches every
 *     key through `[key: string]: string | undefined`. So
 *     `process.env.NEXT_PUBLIC_API_BASE_URL` is TS4111 — "must be accessed
 *     with" the bracket form. MEASURED: both lines in `./env.ts` fail
 *     `tsc -b --force` without this file.
 *   - The bracket form is precisely what Next's build-time substitution does
 *     NOT rewrite. Doing what the compiler asks would type-check, pass every
 *     server-side test, and ship a browser bundle where both values are
 *     `undefined`.
 *
 * Declaring the properties makes them real properties rather than
 * index-signature hits, which satisfies the compiler while leaving the exact
 * text Next substitutes intact. The alternative — a pair of per-line compiler
 * suppressions — would put suppressions on the two lines that most need to stay
 * readable.
 *
 * A `.d.ts`, not a `declare global` block inside `env.ts`, and that is
 * measured rather than stylistic: `@typescript-eslint/no-namespace` is an error
 * under `typeChecked()` and `NodeJS.ProcessEnv` can only be augmented through a
 * namespace. The rule's default `allowDefinitionFiles: true` sanctions exactly
 * this file, so the declaration lands here rather than behind a lint
 * suppression.
 *
 * Neither suppression form is named literally above, and that is deliberate:
 * CI greps this tree for both tokens and fails on any occurrence without a
 * `--` justification, and a grep over source cannot tell a comment from code.
 * Same constraint, same reason, as the prose in `./env.ts`.
 *
 * Optional, not required. These are `string | undefined` at the type level, and
 * `ClientEnvSchema` is what turns them into a guarantee — typing them as
 * `string` here would be a lie that the schema exists to prevent.
 *
 * This widens nothing in practice: `no-restricted-properties` still bans
 * `process.env` everywhere in `apps/web` except `src/config/env.ts`, which is
 * the control, and it is proven live rather than merely configured.
 */
declare namespace NodeJS {
  interface ProcessEnv {
    NEXT_PUBLIC_API_BASE_URL?: string;
    NEXT_PUBLIC_DEFAULT_LOCALE?: string;
  }
}
