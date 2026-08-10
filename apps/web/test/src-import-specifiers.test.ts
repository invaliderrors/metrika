import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../src/', import.meta.url).pathname;

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(?<!:)\/\/[^\n]*/g, ' ');
}

function filesUnder(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => extensions.some((extension) => name.endsWith(extension)))
    .map((name) => join(dir, name));
}

/**
 * Any single-quoted relative module specifier. Prettier normalises this app to
 * single quotes, so one pattern covers `import x from '…'`, `export … from
 * '…'`, bare `import '…'` and `import('…')` without needing to know which is
 * which.
 */
const RELATIVE_SPECIFIER = /'(\.{1,2}\/[^']*)'/g;

function relativeSpecifiers(source: string): string[] {
  return [...withoutComments(source).matchAll(RELATIVE_SPECIFIER)].map(([, s = '']) => s);
}

/**
 * `src/` uses EXTENSIONLESS relative specifiers, and this is the only thing that
 * enforces it.
 *
 * MEASURED on next@16.3.0: Turbopack does not apply TypeScript's `.js` → `.ts`
 * rewrite, so `import { X } from './routing.js'` fails `next build` with
 * "Module not found: Can't resolve './routing.js'". `tsc -b --force`, `eslint
 * --max-warnings=0` and `vitest` all accept that specifier happily.
 *
 * For a module the App Router actually reaches, `next build` is the gate and it
 * is a loud one — `test/tailwind-build.test.ts` shells out to a real build, and
 * root `pnpm verify` runs `pnpm build` before the unit suites. But that gate is
 * REACHABILITY-SHAPED, and that is the hole this closes: `src/lib/formatting/**`
 * is not imported by any page today, so Turbopack never resolves its specifiers
 * and a `.js` there would pass all four gates and sit dormant until the first
 * component imported it. A text scan does not care what is reachable.
 *
 * `test/` deliberately keeps the `.js` form — those files are only ever run by
 * Vitest, and `test/env.test.ts` established the convention. Hence `SRC`.
 */
describe('relative imports under src/', () => {
  it('finds specifiers at all, so a broken scanner cannot make this vacuous', () => {
    const all = filesUnder(SRC, ['.ts', '.tsx']).flatMap((file) =>
      relativeSpecifiers(readFileSync(file, 'utf8')),
    );

    expect(all.length).toBeGreaterThan(3);
    // One known specifier, so a regex that has stopped matching cannot pass the
    // count assertion on some other file's imports. If `src/lib/formatting/`
    // ever moves, update this string — do not delete the assertion.
    expect(all).toContain('../../config/env');
  });

  it('never carries a .js extension Turbopack cannot resolve', () => {
    const offenders = filesUnder(SRC, ['.ts', '.tsx']).flatMap((file) =>
      relativeSpecifiers(readFileSync(file, 'utf8'))
        .filter((specifier) => specifier.endsWith('.js'))
        .map((specifier) => `${file}: ${specifier}`),
    );

    expect(offenders, 'Turbopack does not rewrite .js to .ts — drop the extension').toEqual([]);
  });
});
