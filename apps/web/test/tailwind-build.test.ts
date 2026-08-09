import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('..', import.meta.url).pathname;
const STATIC_DIR = join(ROOT, '.next', 'static');

/**
 * THE SLOWEST TEST IN THIS PACKAGE, deliberately. It runs a real production
 * `next build` because nothing cheaper distinguishes "Tailwind processed these
 * sources" from "Tailwind never ran". The thing under test is the PostCSS
 * pipeline Next drives, not the contents of `globals.css`, so do not "optimise"
 * it into a file-read over the stylesheet. It lives in the unit suite rather
 * than the integration one because it needs no container and no network.
 */
describe('the Tailwind pipeline', () => {
  it('emits a stylesheet containing the utilities the shell uses', () => {
    // Every sheet read below must come from the build this test just ran.
    // `.next/cache` is left alone — it is Next's incremental cache, it is the
    // bulk of the directory, and it holds no emitted CSS. MEASURED: `next build`
    // does clean `.next/static` itself today, so this is belt and braces rather
    // than a fix for an observed staleness bug; it is here because "the build
    // exited 0 but the artefact was left over from last time" is the exact
    // failure this whole test exists to rule out.
    rmSync(STATIC_DIR, { recursive: true, force: true });

    try {
      execFileSync('pnpm', ['exec', 'next', 'build'], { cwd: ROOT, stdio: 'pipe' });
    } catch (error) {
      // `stdio: 'pipe'` keeps a passing run quiet, but it also swallows the
      // compiler's diagnostics on a failing one, which is when they are the
      // only thing worth having.
      const detail =
        error !== null && typeof error === 'object' && 'stderr' in error
          ? String(error.stderr)
          : String(error);
      throw new Error(`next build failed:\n${detail}`, { cause: error });
    }

    // Next 16 emits CSS into `.next/static/chunks`, NOT `.next/static/css` —
    // that path is a Webpack-era layout and Turbopack is 16's default builder.
    // Walked recursively so a future chunking change relocates the sheet without
    // silently turning this into an assertion over an empty array.
    const sheets = readdirSync(STATIC_DIR, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.css'))
      .map((f) => readFileSync(join(STATIC_DIR, f), 'utf8'));

    expect(sheets.length).toBeGreaterThan(0);
    const all = sheets.join('\n');

    // A rule body, not a class name: `.p-8{...}` proves the compiler ran,
    // whereas the string `p-8` also appears in an unprocessed className.
    expect(all).toMatch(/\.p-8\s*\{[^}]*padding/);
    // The custom token resolves, so the theme block is being read.
    expect(all).toContain('--color-brand');

    // NEGATIVE CONTROL. Both assertions above would also pass against a stock
    // Tailwind stylesheet that had never been scanned against this app —
    // `.p-8` and `--color-brand` are in every sheet Tailwind could emit.
    // `italic` is an equally ordinary utility that nothing under `src/` uses, so
    // its ABSENCE is what proves the sheet was derived from these files.
    //
    // This control only means anything because `globals.css` scopes Tailwind's
    // source detection to `src/` with `source('../')`. MEASURED with the default
    // unscoped `@import 'tailwindcss'`: Tailwind scans the whole package, THIS
    // FILE included, and the words `p-8` and `italic` in the assertions above
    // are themselves enough to make both utilities appear in the output — the
    // `.p-8` assertion passed with `page.tsx` carrying no className at all. A
    // test that is an input to the thing it tests asserts nothing. If you ever
    // legitimately use `italic`, swap in another unused class; do not delete it.
    expect(all).not.toMatch(/\.italic\s*\{/);

    // The dark scheme survives as a CONDITIONAL rule. MEASURED on
    // tailwindcss@4.3.3, a `@theme` block nested inside
    // `@media (prefers-color-scheme: dark)` is hoisted out of the media query,
    // so the dark values land unconditionally on `:root` and the light theme
    // silently ceases to exist — with `next build` exiting 0. In that broken
    // form the emitted sheet contains no `prefers-color-scheme` rule at all,
    // which is what this catches. See the comment in `globals.css`.
    expect(all).toMatch(/prefers-color-scheme\s*:\s*dark\)[^@]*--color-surface\s*:/);
  });
}, 180_000);
