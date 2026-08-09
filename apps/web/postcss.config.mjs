/**
 * Tailwind 4 ships as a PostCSS plugin; this file is the whole of its build-time
 * wiring. Next discovers it by filename, so renaming it silently disables
 * Tailwind while `next build` still exits 0 — an unprocessed `className`
 * survives into the HTML untouched. `test/tailwind-build.test.ts` is what turns
 * that into a failing test rather than an unstyled page.
 *
 * Bound to a name rather than `export default { ... }`. MEASURED, same shape as
 * `eslint.config.js`: `eslint-config-next` enables
 * `import/no-anonymous-default-export`, which reports an anonymous object
 * literal, and the root `lint` script passes `--max-warnings=0`.
 */
const config = { plugins: { '@tailwindcss/postcss': {} } };

export default config;
