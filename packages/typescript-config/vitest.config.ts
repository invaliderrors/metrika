import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * The same resource assumption `packages/eslint-config/vitest.config.ts`
     * documents, for the same reason: every assertion in `configs.test.ts` and
     * `lint-parity.test.ts` spawns a real `tsc` or a real ESLint over a fixture
     * project, and vitest's 5 s default is generous alone and marginal when
     * `apps/web`'s `tailwind-build.test.ts` is running a full `next build` on
     * the same machine.
     *
     * MEASURED at turbo's default concurrency: 7–10 s per assertion in this
     * package under contention, against a 5 s default. Raised to 30 s — enough
     * headroom that scheduling cannot decide the result, small enough that a
     * genuine hang still fails.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
