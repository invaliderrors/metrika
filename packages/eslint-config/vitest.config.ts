import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Vitest's 5 s default is a RESOURCE assumption, and this package breaks it
     * under load rather than because anything is wrong.
     *
     * Every assertion here runs a real, type-aware ESLint over a fixture, which
     * means loading a TypeScript program per config under test. In isolation
     * that is roughly a second. MEASURED: `turbo run test:unit --force` at
     * turbo's default concurrency failed 1 run in 4 with
     * "Test timed out in 5000ms" on `explicit-any.ts triggers
     * @typescript-eslint/no-explicit-any` at 5221 ms, 221 ms over the line —
     * and `--concurrency=1` was green every time. The contention is with
     * `apps/web`'s `tailwind-build.test.ts`, which shells out to a full
     * production `next build` inside the unit suite and saturates the machine.
     *
     * Raised rather than serialising the whole workspace: these tests are not
     * measuring speed, and `--concurrency=1` would cost every package the
     * parallelism to fix two. Raised to 30 s rather than something enormous
     * because a genuine hang must still fail — that is roughly six times the
     * worst figure observed under contention.
     *
     * If this ever fires legitimately, the fix is to stop running a `next build`
     * inside a unit suite, not to raise the number again.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
