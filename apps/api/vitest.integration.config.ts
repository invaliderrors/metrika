import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    // One container for the whole run, owned by globalSetup — see the comment
    // in packages/testing/vitest.integration.config.ts, including the measured
    // per-file container count without it (three files, three containers) and
    // why `poolOptions` must not be added back: it was removed in Vitest 4 and
    // breaks `pnpm typecheck`. `isolate`/`fileParallelism` are the top-level
    // replacements.
    //
    // Do NOT add `dangerouslyIgnoreUnhandledErrors: true` here, however ugly
    // the output of a failing run looks. A DI failure reaches this suite as
    // `process.abort()` from @nestjs/core/nest-factory.js — `abortOnError`
    // defaults to true — which Vitest cannot intercept the way it intercepts
    // `process.exit`. The result is a crashed worker reported as an unhandled
    // error with blank `Test Files (1) / Tests (n)` counts rather than a named
    // failing test. That blank line is the boot gate WORKING. Silencing it
    // makes the run look tidy and disarms the one control that catches an
    // `import type` on an injected dependency, which `tsc` and `eslint` both
    // pass. It is set nowhere in this repository; keep it that way.
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
