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
