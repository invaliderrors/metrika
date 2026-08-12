import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    // The container's lifecycle lives in globalSetup, which Vitest runs once
    // per RUN, before it forks any worker — regardless of `pool`, `isolate`
    // or `fileParallelism`. This is VERIFIED, not a prediction: see Task 8
    // Step 3's measurement in this plan.
    // Two files, because two harnesses. Vitest runs each entry once per run,
    // in order, before forking any worker. Only THIS package lists the
    // Temporal one: packages/database and apps/api need a database and not a
    // workflow server, and a globalSetup they do not use is a container they
    // would still pay for.
    globalSetup: ['./test/global-setup.ts', './test/global-setup-temporal.ts'],
    // Files still run one at a time (fileParallelism:false forces
    // maxWorkers to 1), so the small container's connection budget never
    // sees concurrent load. NOTE: this does NOT reuse a single forked
    // process across files — Vitest still spawns a fresh fork per file
    // under the default `isolate:true`. That's fine: the container itself
    // lives in globalSetup, not in module state those forks would share.
    //
    // Do NOT add `poolOptions: { forks: { singleFork: true } }` here.
    // `poolOptions` was removed in Vitest 4 (options moved to top-level)
    // and fails `defineConfig`'s type check: TS2769 "'poolOptions' does
    // not exist in type 'InlineConfig'". At runtime the CLI merely warns
    // and ignores it, but `pnpm typecheck` (part of `pnpm verify`) will
    // not build clean with this line present. Verified by removing it:
    // container count and pass/fail are unaffected either way.
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
