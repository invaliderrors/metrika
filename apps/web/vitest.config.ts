import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  /**
   * The `@/*` alias `tsconfig.json` declares, restated for Vitest.
   *
   * Vite does not read `compilerOptions.paths`, so without this entry the first
   * test to import `@/lib/cn` fails to resolve at runtime while `tsc` is
   * perfectly happy — a green typecheck and a red test suite, for a path that
   * works in `next build`. Both files have to move together; there is no third
   * place that derives one from the other.
   */
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    /**
     * The same 5 s resource assumption `packages/eslint-config/vitest.config.ts`
     * and `packages/typescript-config/vitest.config.ts` document, and this
     * package is the third to break it — except that here the contention is
     * INTERNAL, so raising the other two could never have covered it.
     *
     * `test/tailwind-build.test.ts` shells out to a full production `next build`
     * (9.1 s, measured) and `test/eslint-order.test.ts` constructs a real ESLint
     * and resolves apps/web's whole composed config, which loads
     * eslint-config-next and typescript-eslint on the first call. Vitest runs
     * test FILES in parallel, so those two land on the same machine by default.
     *
     * MEASURED on a clean clone with no turbo cache, `pnpm verify`: the first
     * assertion in `eslint-order.test.ts` timed out at 5000 ms while the tailwind
     * build was running, and the six assertions after it — same file, same warm
     * ESLint — took 57–118 ms each. Nothing was wrong; the cold start simply does
     * not fit in the default. Working checkouts pass because they are warm, which
     * is exactly the shape of failure a clean-clone run exists to catch.
     *
     * 30 s, matching the two packages above: enough that scheduling cannot decide
     * the result, small enough that a genuine hang still fails. If it ever fires
     * legitimately, the fix is to stop running a `next build` inside a unit
     * suite, not to raise the number again.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
    /**
     * `src/config/env.ts` parses `clientEnv` at MODULE SCOPE, deliberately — a
     * misconfigured deployment must fail at build rather than on a user's first
     * render. The consequence is that merely importing that module runs the
     * parse, so `test/env.test.ts` cannot import `parseServerEnv` from it
     * without valid public keys in the ambient environment. MEASURED: without
     * these two, the whole suite file fails to load with a ZodError before a
     * single assertion runs.
     *
     * So these are a fixture for the module's import-time contract, not a
     * convenience. Do not "fix" the collision by making `clientEnv` a function:
     * a lazy read moves the failure from build time to first render, which is
     * the property the module-level constant exists to buy.
     *
     * `parseServerEnv` itself is pure and takes its source as an argument, so
     * nothing below actually reads these — every server-side assertion passes
     * its own object. They exist only to get the module imported.
     */
    env: {
      NEXT_PUBLIC_API_BASE_URL: 'http://localhost:3001',
      NEXT_PUBLIC_DEFAULT_LOCALE: 'es-CO',
    },
  },
});
