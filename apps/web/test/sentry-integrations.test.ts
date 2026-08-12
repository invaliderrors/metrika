import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ALLOWED_INTEGRATION_NAMES, keepAllowedIntegrations } from '../src/lib/telemetry/sentry.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE INTEGRATION ALLOWLIST, GRADED AGAINST THE ARRAY `init` ACTUALLY PASSES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The first version of this fixture called the package's EXPORTED
 * `getDefaultIntegrations`, which is `@sentry/react`'s. `init` builds its own
 * array (`client/index.js:85`, `server/index.js:78`), and the difference is the
 * whole point: the real client array carries `BrowserTracing` and
 * `NextjsClientStackFrameNormalization`, and the exported one carries neither.
 * So "BrowserTracing is filtered out" was asserted against a list that never
 * contained it.
 *
 * Captured by calling the real `init` with an `integrations` CALLBACK, which is
 * exactly where Sentry hands the defaults to this application's filter. The
 * callback returns `[]`, so nothing is instantiated or installed.
 *
 * ONE CHILD PROCESS PER CAPTURE, and that is a measured requirement rather than
 * hygiene: `@sentry/nextjs`'s server `init` returns early when
 * `sdkAlreadyInitialized()`, so a second `init` in the same process is silently
 * skipped and the callback is never called. Measured — in-process, the second
 * and third captures came back empty.
 *
 * **THE EXACT COUNTS BELOW (11 / 13 / 17 / 18 / 44) ARE DELIBERATE, AND THEY
 * WILL REDDEN ON A BENIGN UPSTREAM PATCH.** That is the trade this file makes on
 * purpose, and it is the same one `redaction-corpus.json` makes: what a Sentry
 * release adds to the default set is precisely what an allowlist exists to keep
 * out, so "the set changed" has to reach a human rather than be absorbed. The
 * cost is a red test on a version bump that added something harmless; the
 * alternative is an upgrade that quietly starts producing spans from `apps/web`.
 * If that trade is ever judged wrong, replace the counts with named-membership
 * assertions — do not delete them.
 *
 * The CJS build, at an absolute path, because the ESM build imports
 * `next/constants` extensionlessly and Node's resolver rejects it
 * (`ERR_MODULE_NOT_FOUND`).
 *
 * `_sentryRewriteFramesDistDir` IS PASSED DELIBERATELY, and both settings are
 * exercised below. `withSentryConfig` injects it at BUILD time
 * (`server/index.js:88` gates on it), so the server default set is **17 without
 * it and 18 with it** — a fixture that asserted `DistDirRewriteFrames` survives
 * the filter while constructing the set outside a real build would be asserting
 * on an integration that is not there, and would pass for the wrong reason.
 */
const require_ = createRequire(import.meta.url);
const sentryCjs = path.join(
  path.dirname(require_.resolve('@sentry/nextjs/package.json')),
  'build/cjs',
);

interface SentryBuild {
  getDefaultIntegrations: (options: Record<string, unknown>) => { name: string }[];
}

/**
 * The package's EXPORTED helper — what a snapshot test would naturally reach
 * for, and what this fixture exists to avoid. Kept only so the test below can
 * assert that it disagrees with what `init` uses.
 */
function exportedDefaults(
  build: 'index.server.js' | 'index.client.js',
  options: Record<string, unknown>,
): string[] {
  const loaded = require_(path.join(sentryCjs, build)) as SentryBuild;
  return loaded.getDefaultIntegrations(options).map((integration) => integration.name);
}

const CAPTURE = `
  const mod = require(process.argv[1]);
  let captured = [];
  mod.init({
    ...JSON.parse(process.argv[2]),
    dsn: undefined,
    integrations: (defaults) => { captured = defaults.map((i) => i.name); return []; },
  });
  process.stdout.write('__INTEGRATIONS__' + JSON.stringify(captured));
`;

function realDefaults(
  build: 'index.server.js' | 'index.client.js',
  options: Record<string, unknown>,
  { injectDistDir = true }: { injectDistDir?: boolean } = {},
): string[] {
  // The child's environment is stated in full rather than inherited, and not
  // only because `process.env` is off limits outside `src/config/env.ts`: the
  // SDK reads `NEXT_PHASE`, `VERCEL_ENV`, `NODE_ENV` and `SENTRY_*` at init, so
  // an inherited environment would let a developer's shell change which
  // integrations this fixture grades.
  // The key is always PRESENT and empty when it is not wanted, rather than the
  // ternary producing two different object shapes: a union there widens `env`
  // enough that TypeScript stops matching `execFileSync`'s `encoding: 'utf8'`
  // overload and hands back `string | Buffer`. Empty is also exactly the SDK's
  // own gate — `server/index.js:88` tests the value for truthiness.
  const stdout = execFileSync(
    process.execPath,
    ['-e', CAPTURE, path.join(sentryCjs, build), JSON.stringify(options)],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // `NODE_ENV` is not optional here — Next augments `NodeJS.ProcessEnv` to
      // require it — and it is not inert either: the client SDK adds a
      // development-only symbolication processor when it reads `development`.
      env: {
        NODE_ENV: 'test',
        _sentryRewriteFramesDistDir: injectDistDir ? '.next' : '',
      },
    },
  );

  // Delimited rather than parsed whole, so anything the SDK decides to print
  // cannot turn a captured array into a parse error that reads like a defect.
  const marker = stdout.lastIndexOf('__INTEGRATIONS__');
  expect(marker, `no capture in child output: ${stdout}`).toBeGreaterThanOrEqual(0);
  const payload: unknown = JSON.parse(stdout.slice(marker + '__INTEGRATIONS__'.length));

  return z.array(z.string()).parse(payload);
}

describe('keepAllowedIntegrations', () => {
  it('drops an integration that did not exist when this list was written', () => {
    expect(keepAllowedIntegrations([{ name: 'SomeFutureTracingIntegration' }])).toStrictEqual([]);
  });

  /**
   * THE REASON THIS FILE SPAWNS PROCESSES, stated as an assertion rather than a
   * comment. `getDefaultIntegrations` is exported and is NOT the set `init`
   * uses, in both directions — so a snapshot over the export pins neither what
   * ships nor what an upgrade would change:
   *
   *   - client: the export omits `browserTracingIntegration` and
   *     `NextjsClientStackFrameNormalization`, both of which
   *     `client/index.js:85` pushes internally.
   *   - server: `init` REMOVES `Http` and substitutes
   *     `httpIntegration({ disableIncomingRequestSpans: true })`
   *     (`server/index.js:78`), and adds `DistDirRewriteFrames` when the build
   *     injected `_sentryRewriteFramesDistDir`.
   *
   * ADR-0029's snapshot suggestion is still right for `apps/api`'s
   * `@sentry/node`; it does not survive `@sentry/nextjs`.
   */
  it('is graded against a set the exported helper does not report', () => {
    const exportedClient = exportedDefaults('index.client.js', {});
    const realClient = realDefaults('index.client.js', {});

    expect(exportedClient.length).toBe(11);
    expect(realClient.length).toBe(13);
    expect(realClient.filter((name) => !exportedClient.includes(name)).sort()).toStrictEqual([
      'BrowserTracing',
      'NextjsClientStackFrameNormalization',
    ]);

    // The server difference is the build-time injection, and it is conditional:
    // 17 without it, 18 with it. `withSentryConfig` is what supplies it.
    expect(exportedDefaults('index.server.js', {}).length).toBe(17);
    expect(realDefaults('index.server.js', {}, { injectDistDir: false }).length).toBe(17);
    expect(realDefaults('index.server.js', {})).toContain('DistDirRewriteFrames');
    expect(realDefaults('index.server.js', {}).length).toBe(18);
  });

  /**
   * The exclusion, asserted against the array `Sentry.init` really builds. The
   * previous form of this — `expect(ALLOWED_INTEGRATION_NAMES).not.toContain(…)`
   * — is a string absence, and would pass just as happily if `BrowserTracing`
   * had been renamed upstream and were arriving under another name entirely.
   */
  it('drops BrowserTracing from the real client defaults, and nothing else', () => {
    const real = realDefaults('index.client.js', {});
    const kept = keepAllowedIntegrations(real.map((name) => ({ name }))).map((i) => i.name);

    expect(real).toContain('BrowserTracing');
    expect(real).toContain('NextjsClientStackFrameNormalization');
    expect(real.filter((name) => !kept.includes(name))).toStrictEqual(['BrowserTracing']);
  });

  /**
   * `NextjsClientStackFrameNormalization` and `DistDirRewriteFrames` have no
   * exported factory, so `defaultIntegrations: false` plus a list of
   * constructions — the other way to write an allowlist, and the one ADR-0029
   * obligation 2 asks for literally — cannot bring them back. Applying the
   * allowlist as a FILTER is what keeps them, and this is the assertion that
   * says so.
   */
  it('keeps the two SDK-internal integrations that have no exported factory', () => {
    // Neither has one: only `rewriteFramesIntegration` is public, and
    // `'distDirRewriteFramesIntegration' in Sentry` is false on both builds.
    const client = require_(path.join(sentryCjs, 'index.client.js')) as Record<string, unknown>;
    const server = require_(path.join(sentryCjs, 'index.server.js')) as Record<string, unknown>;

    expect('nextjsClientStackFrameNormalizationIntegration' in client).toBe(false);
    expect('distDirRewriteFramesIntegration' in server).toBe(false);

    const keptClient = keepAllowedIntegrations(
      realDefaults('index.client.js', {}).map((name) => ({ name })),
    ).map((i) => i.name);
    const keptServer = keepAllowedIntegrations(
      // The build-time injection is required for this one to exist at all.
      realDefaults('index.server.js', {}).map((name) => ({ name })),
    ).map((i) => i.name);

    expect(keptClient).toContain('NextjsClientStackFrameNormalization');
    expect(keptServer).toContain('DistDirRewriteFrames');
  });

  it('keeps every error-side default the server SDK ships with tracing off', () => {
    const real = realDefaults('index.server.js', {});
    const kept = keepAllowedIntegrations(real.map((name) => ({ name }))).map((i) => i.name);

    expect(kept).toStrictEqual(real);
    expect(real.length).toBeGreaterThan(10);
  });

  it('drops every span-producing integration the server SDK offers under tracing', () => {
    const real = realDefaults('index.server.js', { tracesSampleRate: 1 });
    const kept = keepAllowedIntegrations(real.map((name) => ({ name }))).map((i) => i.name);

    // ADR-0029's number, reproduced. `DistDirRewriteFrames` is the Next SDK's
    // own addition on top of `@sentry/node`'s set, so it is subtracted rather
    // than folded in — the 44 is a claim about the Node SDK.
    expect(real.filter((name) => name !== 'DistDirRewriteFrames').length).toBe(44);

    for (const spanProducing of ['Fastify', 'Express', 'Postgres', 'Prisma', 'Redis', 'Mongo']) {
      expect(real).toContain(spanProducing);
      expect(kept).not.toContain(spanProducing);
    }

    // Enabling tracing adds only span producers, so the kept set is unchanged
    // from the bare one — which is what makes "no traces from apps/web" a
    // property of the allowlist rather than of `tracesSampleRate` being unset.
    expect(kept).toStrictEqual(realDefaults('index.server.js', {}));
  });

  /**
   * No DEAD entries. A name in the allowlist that no runtime ships is either a
   * typo or a leftover from a version bump, and it silently protects nothing —
   * the same shape as a redaction path nothing matches.
   */
  it('names nothing that no runtime actually ships', () => {
    const shipped = new Set([
      ...realDefaults('index.client.js', {}),
      ...realDefaults('index.server.js', { tracesSampleRate: 1 }),
    ]);

    expect(ALLOWED_INTEGRATION_NAMES.filter((name) => !shipped.has(name))).toStrictEqual([]);
  });
});
