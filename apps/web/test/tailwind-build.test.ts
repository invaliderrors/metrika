import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('..', import.meta.url).pathname;
const STATIC_DIR = join(ROOT, '.next', 'static');

/**
 * The balanced `{ … }` block that follows `marker`, or `null` if the marker is
 * absent.
 *
 * Brace counting rather than a regex, because the regions this test reads —
 * `@layer theme` and the `prefers-color-scheme` media query — both CONTAIN a
 * nested `@supports` block holding a second copy of every declaration (the
 * lab() fallback Lightning CSS emits under an oklch() source). An earlier
 * version matched `[^@]*` after the marker, which happened to work only because
 * Turbopack emits the plain declarations before the nested `@supports`. That is
 * an ordering coincidence, not a guarantee: reorder them upstream and the
 * assertion goes red on a stylesheet that is perfectly correct.
 *
 * Assumes no `{` or `}` inside a string or comment within the block. True of
 * these two regions, which hold only custom-property declarations.
 */
function balancedBlockAfter(css: string, marker: string): string | null {
  const markerAt = css.indexOf(marker);
  if (markerAt === -1) return null;
  const open = css.indexOf('{', markerAt);
  if (open === -1) return null;

  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

/** Every value declared for `property` anywhere in `block`, in source order. */
function declaredValues(block: string, property: string): string[] {
  return [...block.matchAll(new RegExp(`${property}\\s*:\\s*([^;}]+)`, 'g'))].map((m) =>
    (m[1] ?? '').trim(),
  );
}

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
    //
    // A DECLARATION (`--color-brand:`), not a substring. MEASURED by mutation:
    // `toContain('--color-brand')` is also satisfied by `--color-brand-foreground`,
    // so deleting `--color-brand` from the `@theme` block outright left this
    // green — the assertion could not fail for the reason it names. The trailing
    // colon is what distinguishes the declaration from both the longer token and
    // the `var(--color-brand)` references in the utilities.
    expect(all).toMatch(/--color-brand\s*:/);

    // NEGATIVE CONTROL. Every assertion above would also pass against a stock
    // Tailwind stylesheet that had never been scanned against this app —
    // `.p-8` and `--color-brand` are in every sheet Tailwind could emit. The
    // sentinel below is an ordinary utility that nothing under `src/` uses, so
    // its ABSENCE is what proves the sheet was derived from these files.
    //
    // The sentinel is an ARBITRARY-VALUE utility on purpose. It was `italic`,
    // which is also an ordinary English word: any prose comment under `src/`
    // mentioning it would have failed the build for no reason. That is not
    // hypothetical — `.block` ships in the production sheet solely because
    // `src/config/process-env.d.ts` uses the word, and `.outline` ships because
    // it is a cva variant key in `button.tsx`. `p-[13px]`, with the brackets,
    // cannot occur in prose. Note what that makes the control mean precisely:
    // the sheet is derived from the TEXT of `src/`, not from what the app
    // renders. If you ever need this exact padding, change the sentinel; do not
    // delete the assertion.
    //
    // The emitted selector escapes the brackets — `.p-\[13px\]` — hence the
    // double backslashes.
    expect(all).not.toMatch(/\.p-\\\[13px\\\]/);

    // ── The two schemes are genuinely two schemes ──────────────────────────
    //
    // MEASURED on tailwindcss@4.3.3, a `@theme` block nested inside
    // `@media (prefers-color-scheme: dark)` is hoisted OUT of the media query,
    // so the dark values land unconditionally on `:root` and the light theme
    // silently ceases to exist — with `next build` exiting 0.
    //
    // Asserting only that a dark rule exists is not enough, and this is
    // measured too: set the light `--color-surface` in `@theme` to the dark
    // value by hand and every "a dark rule exists" assertion stays green while
    // the app ships permanently dark, which is the very bug this guards. So the
    // assertion is that the two blocks declare DIFFERENT values.
    //
    // Compared as sets rather than first-match, so it cannot be broken by the
    // order Lightning CSS emits a declaration and its `@supports` fallback in.
    const themeBlock = balancedBlockAfter(all, '@layer theme');
    const darkBlock = balancedBlockAfter(all, 'prefers-color-scheme');
    expect(themeBlock, 'no @layer theme block in the emitted stylesheet').not.toBeNull();
    expect(darkBlock, 'no prefers-color-scheme rule in the emitted stylesheet').not.toBeNull();

    const light = declaredValues(themeBlock ?? '', '--color-surface');
    const dark = declaredValues(darkBlock ?? '', '--color-surface');
    expect(light.length).toBeGreaterThan(0);
    expect(dark.length).toBeGreaterThan(0);
    expect(light.filter((value) => dark.includes(value))).toEqual([]);
  });
}, 180_000);
