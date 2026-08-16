import { defineConfig } from '@playwright/test';

/**
 * `process.env['CI']`, in bracket form and read outside `src/config/env.ts`.
 * Both halves need saying, because both look like rule violations and neither
 * is:
 *
 *   - BRACKET FORM because `noPropertyAccessFromIndexSignature` is on
 *     repo-wide and `NodeJS.ProcessEnv` reaches every key through an index
 *     signature. `process.env.CI` is TS4111 here. The dotted form is only
 *     available for the two `NEXT_PUBLIC_` keys, which
 *     `src/config/process-env.d.ts` declares as real properties precisely
 *     because Next's build-time substitution is textual — a reason that does
 *     not apply to a variable Next never sees.
 *   - OUTSIDE `env.ts` because this file must load with no environment at all.
 *     `src/config/env.ts` parses `clientEnv` at module scope, so importing it
 *     here would make `playwright test` fail to start unless the two
 *     `NEXT_PUBLIC_` keys were already exported — and the whole point of
 *     `webServer.env` below is that they are supplied to the SERVER, not to the
 *     test runner. `eslint.config.js` carries the matching narrow exemption and
 *     the same reasoning; apps/api's integration-test exemption is the
 *     precedent.
 */
const isCI = Boolean(process.env['CI']);

/**
 * The port the server under test binds and this config polls, defaulted to the
 * same number `scripts/next.mjs` uses. Read from the ambient environment for the
 * same reason `CI` is — nothing here may import `src/config/env.ts`.
 *
 * A variable rather than a literal because 3000 is an ordinary port that another
 * project on the same machine may already own, and the failure that produces is
 * silent rather than loud: `reuseExistingServer` is on outside CI, so a FOREIGN
 * server answering on 3000 is adopted and the suite grades somebody else's
 * application. Moving `WEB_PORT` is the fix, and it only works if this file
 * follows it.
 *
 * It is passed to the server through `webServer.env` below rather than relied on
 * ambiently, so the port this config polls and the port the server binds cannot
 * disagree. Note that neither `pnpm` nor Playwright reads the root `.env`: a
 * non-default port has to be EXPORTED in the shell that runs
 * `pnpm --filter @metrika/web test:e2e`.
 *
 * `API_PORT` gets NO equivalent, deliberately. Nothing listens on the API origin
 * during this suite — `NEXT_PUBLIC_API_BASE_URL` below is a fixture value that
 * must reach the document, not an address anything dials — so there is no port
 * to collide with, and `e2e/shell.spec.ts` pins the same string a second time on
 * purpose so that the two drifting apart fails loudly.
 */
const webPort = process.env['WEB_PORT'] ?? '3000';

export default defineConfig({
  testDir: './e2e',

  /**
   * A production build, not `next dev`: dev-mode behaviour differs enough on
   * hydration and CSS delivery that a green dev run is not evidence about what
   * ships.
   *
   * `pnpm build` here is apps/web's own script — a bare `next build` — not the
   * repository root's `node --env-file-if-exists=.env scripts/turbo.mjs run
   * build`. So nothing loads the root `.env` for it, and `env` below is what
   * supplies the two keys `src/config/env.ts` parses at module scope. Playwright
   * merges these over the ambient environment rather than replacing it, so a
   * shell that already exports them is not clobbered — and if it exports a
   * DIFFERENT api base url, the preconnect assertion in `e2e/shell.spec.ts`
   * fails loudly rather than passing against the wrong origin.
   *
   * `reuseExistingServer` outside CI is a real hazard worth knowing about: a
   * server left running from an earlier run serves an OLD build, which makes a
   * source mutation look green. If a mutation does not go red, kill whatever is
   * on `webPort` before believing it — and see the note on `webPort` for the
   * nastier version, where the server it adopts is not even this application.
   */
  webServer: {
    command: 'pnpm build && pnpm start',
    url: `http://127.0.0.1:${webPort}`,
    reuseExistingServer: !isCI,
    timeout: 180_000,
    env: {
      WEB_PORT: webPort,
      NEXT_PUBLIC_API_BASE_URL: 'http://127.0.0.1:3001',
      NEXT_PUBLIC_DEFAULT_LOCALE: 'es-CO',
    },
  },

  use: { baseURL: `http://127.0.0.1:${webPort}` },

  forbidOnly: isCI,

  // Zero retries deliberately: a retried e2e test hides flake, and this suite is
  // small enough that flake should be fixed rather than absorbed.
  retries: 0,
});
