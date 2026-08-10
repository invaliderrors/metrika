import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import enUS from '../messages/en-US.json' with { type: 'json' };
import esCO from '../messages/es-CO.json' with { type: 'json' };

const SRC = new URL('../src/', import.meta.url).pathname;

/**
 * `value as Record<string, unknown>` rather than bare `Object.entries(value)`:
 * the `object` overload of `Object.entries` returns `[string, any][]`, and
 * feeding that `any` back into this function is an error under
 * `no-unsafe-argument`. The assertion is what keeps the walk typed.
 */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    keyPaths(v, prefix !== '' ? `${prefix}.${k}` : k),
  );
}

/**
 * Comments stripped before scraping, so prose naming a key does not register as
 * a call site. Same reader, same reasoning, as `test/shadcn-palette.test.ts` —
 * a false positive here would fail the build over a sentence, and a comment
 * cannot contain a real call.
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
 * `const t = useTranslations('app')` / `const t = await getTranslations('app')`.
 *
 * The namespace is bound to the VARIABLE, not to the file, which is what lets
 * two namespaces coexist in one component without the resolution becoming a
 * guess. The namespace group is optional because `useTranslations()` with no
 * argument is legal and makes its keys absolute.
 */
const TRANSLATOR_BINDING =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*(?:'([^']*)')?\s*\)/g;

/** Every message path a file asks for, fully qualified by its namespace. */
function usedKeyPaths(source: string): string[] {
  const stripped = withoutComments(source);
  const paths: string[] = [];

  for (const [, binding = '', namespace = ''] of stripped.matchAll(TRANSLATOR_BINDING)) {
    const calls = new RegExp(String.raw`(?<![\w$.])${binding}\(\s*'([^']*)'`, 'g');
    for (const [, key = ''] of stripped.matchAll(calls)) {
      paths.push(namespace !== '' ? `${namespace}.${key}` : key);
    }
  }

  return paths;
}

function resolves(path: string): boolean {
  const value = path
    .split('.')
    .reduce<unknown>(
      (acc, k) =>
        typeof acc === 'object' && acc !== null ? (acc as Record<string, unknown>)[k] : undefined,
      esCO,
    );
  // A path landing on a nested OBJECT is just as broken as one landing on
  // nothing — next-intl reports INSUFFICIENT_PATH and renders the key.
  return typeof value === 'string';
}

/**
 * The gap the structural test above cannot see.
 *
 * `carry exactly the same key set` compares the catalogues to EACH OTHER and to
 * nothing else. MEASURED: delete `app.tagline` from both files and the whole
 * web suite stays green, `next build` exits 0, and the page ships the literal
 * string "app.tagline" to users. Deleting it from one file only is caught, but
 * by the wrong assertion and only because the other file still has it.
 *
 * What this scan can and cannot do is worth being precise about. It resolves a
 * key only when both the translator binding and the key are plain single-quoted
 * literals — the form Prettier produces and the only form in this app. A
 * computed key (`t(dynamicName)`) is invisible to it and always will be; that
 * is the cost of a check that needs no type information and runs in
 * milliseconds. The vacuity control below is what stops a regex that has
 * silently stopped matching anything from reading as a pass.
 */
describe('the message keys components actually use', () => {
  it('finds the call sites at all, so a broken scraper cannot make this vacuous', () => {
    const found = filesUnder(SRC, ['.ts', '.tsx']).flatMap((file) =>
      usedKeyPaths(readFileSync(file, 'utf8')),
    );

    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(found).toContain('app.tagline');
    expect(found).toContain('shell.skipToContent');
  });

  it('resolves every one of them to a string in the shipped catalogue', () => {
    const missing = filesUnder(SRC, ['.ts', '.tsx']).flatMap((file) =>
      usedKeyPaths(readFileSync(file, 'utf8')).filter((path) => !resolves(path)),
    );

    expect(missing, 'these keys render as their own name in production').toEqual([]);
  });
});

describe('message catalogues', () => {
  it('carry exactly the same key set', () => {
    // A key present in one locale and absent from the other is a runtime
    // MISSING_MESSAGE in production for whichever locale lacks it. Structural
    // equality is checkable now; translation quality is not.
    expect(keyPaths(enUS).sort()).toEqual(keyPaths(esCO).sort());
  });

  it('reads a non-trivial key set, so a broken walker cannot make this vacuous', () => {
    // Both catalogues being `{}` satisfies the equality above. This is the
    // control that says the walker actually descended into something.
    expect(keyPaths(esCO)).toContain('app.name');
    expect(keyPaths(esCO).length).toBeGreaterThan(1);
  });

  it('has no empty string values in the shipped locale', () => {
    const empties = keyPaths(esCO).filter((path) => {
      const v = path
        .split('.')
        .reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], esCO);
      return v === '';
    });
    expect(empties).toEqual([]);
  });
});
