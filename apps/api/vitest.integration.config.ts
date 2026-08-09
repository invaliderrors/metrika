import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    // One container for the whole run, owned by globalSetup — see the comment
    // in packages/testing/src/global-setup.ts, including the measured
    // per-file container count without it (three files, three containers) and
    // why `poolOptions` must not be added back: it was removed in Vitest 4 and
    // breaks `pnpm typecheck`. `isolate`/`fileParallelism` are the top-level
    // replacements.
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
