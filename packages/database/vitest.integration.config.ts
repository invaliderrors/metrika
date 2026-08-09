import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    // One container for the whole run, owned by globalSetup — see the comment
    // in packages/testing/vitest.integration.config.ts, including why
    // `poolOptions` must not be added back. Without globalSetup, this
    // package's integration files each start their own Postgres and run their
    // own `prisma migrate deploy` — measured, three containers for three
    // files; Task 8 Step 3 reproduces it.
    //
    // Vitest's own file-execution order is NOT declaration or alphabetical
    // order (its default `BaseSequencer` sorts by file size with a cold
    // duration cache, by recorded duration once one exists — MEASURED on
    // 4.1.10) and a custom sequencer to pin it was tried and then removed:
    // it only made a real bug — cross-file state coupling — deterministic
    // instead of fixing it, and it silently broke `--shard` along the way
    // (a sharded run executed every test in every shard). The actual fix
    // was removing the coupling: no test file in this package may assume
    // another file's rows are, or are not, present. Each integration test
    // file must be independently order-safe against every other.
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
