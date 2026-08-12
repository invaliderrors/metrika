import { withSentryConfig } from '@sentry/nextjs';
import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // ADR-0021 obligation 2. Next 16's `next dev` otherwise writes `AGENTS.md`
  // and an 11-byte `CLAUDE.md` containing `@AGENTS.md` into this directory on
  // every start, announced as "Generated AGENTS.md and CLAUDE.md for AI
  // agents". This repository's CLAUDE.md is hand-authored and its rules say not
  // to leave the tree dirty, so a dev server that generates one is
  // unacceptable. `next build` does not do it, which is exactly why this needs
  // to be written down rather than discovered.
  agentRules: false,
  // `pnpm verify` must fail on a type error rather than letting `next build`
  // skip its own check. This is Next's default today; it is stated so a future
  // `ignoreBuildErrors: true` is a visible edit.
  //
  // There is deliberately no sibling `eslint: { ignoreDuringBuilds: false }`.
  // MEASURED: `NextConfig` in next@16.3.0 has no `eslint` key at all — the
  // string does not appear in `dist/server/config-shared.d.ts` — and writing
  // one fails `tsc` with TS2353. Next 16 removed `next lint` and build-time
  // ESLint; linting is `pnpm lint` / CI's `pnpm lint -- --max-warnings=0`,
  // which is the gate that actually runs. Do not re-add the key from a Next 15
  // example: it will not compile, and if a future major restores it as an
  // untyped passthrough it would read as a control that nothing enforces.
  typescript: { ignoreBuildErrors: false },
};

/**
 * The path is passed explicitly. `createNextIntlPlugin()` defaults to probing
 * `./i18n/request.ts` and `./src/i18n/request.ts`, so naming it is not
 * redundant: it turns a moved or misnamed file into a build error instead of a
 * silent fallback to next-intl's built-in empty config, under which every
 * `useTranslations` call renders its own key.
 *
 * Wrapping happens LAST, so `agentRules: false` above survives. The plugin
 * returns a shallow-merged config; anything set after this line would be
 * setting it on the wrong object.
 */
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/**
 * Sentry OUTERMOST, wrapping the already-wrapped config.
 *
 * `withSentryConfig` is what injects the release identifier and the build-time
 * constants the client SDK reads (`_sentryRelease`,
 * `_sentryRewriteFramesDistDir`); without it `src/instrumentation-client.ts`
 * still initialises, and still reports errors, but every event is release-less
 * and its stack frames are not rewritten to the paths a source map would match.
 *
 * Both options below are denials, and they are what makes ADR-0029 obligation
 * 12 coherent. That obligation adds `'@sentry/cli': false` to
 * `pnpm-workspace.yaml` — the CLI's install script is denied, so the binary is
 * not there — and `@sentry/cli` is exactly what a release creation or a
 * source-map upload would shell out to. Turning both off here means the build
 * never reaches for a tool this repository has decided not to install, rather
 * than discovering it at the first deployment.
 *
 *   - `sourcemaps.disable`: no upload, and therefore no auth token, no
 *     organisation slug and no network call in CI. Symbolicated stack traces
 *     are a real loss and a deliberate one — they belong to the phase that
 *     provisions a Sentry project, alongside the DSN this ships without.
 *   - `release.create: false`: no release is created either, for the same
 *     reason. It does NOT silence the warning on its own — see below.
 *   - `useRunAfterProductionCompileHook: false`: the post-compile step, which
 *     under Turbopack (Next 16's default) is where the plugin creates the
 *     release, injects debug IDs and uploads maps. With the two denials above,
 *     all three are skipped and the step's only remaining effect is a warning
 *     on EVERY production build: "No auth token provided. Will not create
 *     release", plus a line asking whether `SENTRY_AUTH_TOKEN` was forgotten in
 *     turbo's `passThroughEnv`.
 *
 *     MEASURED, and worth recording because it is upstream behaviour that reads
 *     like a misconfiguration: `release.create: false` does not stop it.
 *     `@sentry/bundler-plugin-core` defaults `release.name` from the git
 *     revision during normalisation, and `createRelease()` checks the auth
 *     token BEFORE it checks `create` — so the warning fires about a release it
 *     has already been told not to create. Not silenced with `silent: true`,
 *     which would hide every future plugin warning as well; disabling the step
 *     that has nothing left to do is the narrower fix. The phase that turns
 *     source-map upload on turns this back on with it.
 *   - `telemetry: false`: the bundler plugin otherwise reports build metadata
 *     to Sentry on every build, including CI. This repository already denies
 *     `@scarf/scarf`'s install script for exactly that behaviour
 *     (`pnpm-workspace.yaml`), and a build-time phone-home is the same trade.
 */
export default withSentryConfig(withNextIntl(config), {
  sourcemaps: { disable: true },
  release: { create: false },
  useRunAfterProductionCompileHook: false,
  telemetry: false,
});
