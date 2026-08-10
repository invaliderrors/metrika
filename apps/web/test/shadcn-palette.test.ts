import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../src/', import.meta.url).pathname;

/**
 * `globals.css` declares one colour system, and it is not shadcn's.
 *
 * `shadcn init` writes a second, complete palette — `--background`,
 * `--foreground`, `--primary`, `--secondary`, `--accent`, `--destructive`,
 * `--border`, `--ring`, five `--chart-*`, eight `--sidebar-*` — plus an
 * `@theme inline` block mapping them into Tailwind's `--color-*` namespace. Two
 * of those entries, `--color-muted` and `--color-muted-foreground`, collide by
 * name with this app's tokens and, being later in the file, silently WIN:
 * `bg-muted` resolved to shadcn's neutral grey rather than the declared token.
 * That collision was reconciled by hand in the commit that added the Button.
 *
 * The reconciliation is not self-sustaining. Every component that comes out of
 * the registry is written against those names, so the next `shadcn add` will
 * reintroduce `bg-primary` / `text-destructive` / `border-border`, they will
 * resolve to nothing, and the quickest way to "fix" that is to paste the
 * generator's palette back in — which is the failure this file exists to make
 * loud. `components.json` cannot carry the instruction: shadcn parses it with a
 * schema that strips unknown keys and rewrites the file on re-init.
 *
 * The rule is not "never use these words". It is "never use them as live
 * class names or live custom properties" — the doc comments in `button.tsx` and
 * `globals.css` name every one of them deliberately, which is why comments are
 * stripped before matching.
 */

/**
 * Comments removed, so prose that names a banned token on purpose does not trip
 * the check.
 *
 * Block comments first, then line comments. `[^\\n]*` after `//` rather than
 * anything cleverer: the only false positive would be a `//` inside a string
 * literal, and the sole realistic case — a URL — is preceded by a colon, which
 * the negative lookbehind excludes. A false NEGATIVE here would hide a real
 * violation inside something that merely looks like a comment; that is the
 * trade, and it is acceptable for a directory this small and this hand-reviewed.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(?<!:)\/\/[^\n]*/g, ' ');
}

function filesUnder(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => extensions.some((extension) => name.endsWith(extension)))
    .map((name) => join(dir, name));
}

/**
 * The utility classes shadcn's registry emits that have no token behind them
 * here. Each is bounded so this app's own names cannot match: `text-foreground`
 * must not fire on `text-surface-foreground`, and `border-border` must not fire
 * on `border-brand`. A trailing `/50` opacity modifier still matches, which is
 * intended — `bg-primary/80` is just as broken as `bg-primary`.
 */
const BANNED_CLASSES = [
  'bg-primary',
  'text-destructive',
  'border-border',
  'bg-background',
  'text-foreground',
  'ring-ring',
  'bg-card',
  'bg-popover',
] as const;

/** The custom properties whose presence means the generator's palette came back. */
const BANNED_PROPERTIES = ['--background', '--primary', '--destructive'] as const;

describe('the vendored shadcn components', () => {
  it('reads at least one component, so a broken walker cannot make this vacuous', () => {
    expect(filesUnder(join(SRC, 'components'), ['.ts', '.tsx']).length).toBeGreaterThan(0);
  });

  it.each(BANNED_CLASSES)('does not use the unbacked shadcn class %s', (className) => {
    const pattern = new RegExp(`(?<![\\w-])${className}(?![\\w-])`);
    const offenders = filesUnder(join(SRC, 'components'), ['.ts', '.tsx']).filter((file) =>
      pattern.test(withoutComments(readFileSync(file, 'utf8'))),
    );

    expect(offenders, `${className} has no token behind it — retarget it at globals.css`).toEqual(
      [],
    );
  });

  it.each(BANNED_PROPERTIES)('does not declare the generator token %s in globals.css', (token) => {
    const css = withoutComments(readFileSync(join(SRC, 'app/globals.css'), 'utf8'));

    expect(new RegExp(`(?<![\\w-])${token}\\s*:`).test(css)).toBe(false);
  });
});
