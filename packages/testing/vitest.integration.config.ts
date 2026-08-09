import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    // The container's lifecycle lives in globalSetup, which Vitest runs once
    // per RUN, before it forks any worker — regardless of `pool`, `isolate`
    // or `fileParallelism`. This is VERIFIED, not a prediction: see Task 8
    // Step 3's measurement in this plan.
    globalSetup: ['./test/global-setup.ts'],
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
