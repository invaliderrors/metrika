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

/** The value at a dotted path, or `undefined` if the path does not resolve. */
function valueAt(path: string, catalogue: unknown): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, k) =>
        typeof acc === 'object' && acc !== null ? (acc as Record<string, unknown>)[k] : undefined,
      catalogue,
    );
}

/**
 * Short values are skipped, and the threshold is the whole design of this check.
 *
 * `app.name` is `"Metrika"`. Seven characters, and a word that legitimately
 * appears in package names, comments and identifiers — matching on it would fail
 * the build over prose rather than over a duplicated string. This is the same
 * trade `test/tailwind-build.test.ts` reasons about when it picks `p-[13px]`
 * over `italic` for its sentinel: a check that fires on ordinary English is a
 * check that gets deleted.
 *
 * MEASURED at the time of writing: the string `Metrika` appears NOWHERE under
 * `src/`, so the filter is not covering up a present collision — it is
 * insurance against a future one. State the cost plainly: a hardcoded copy of a
 * value shorter than this is invisible here. Both current offenders of interest
 * are far above it (`shell.skipToContent` is 19 characters,
 * `app.tagline` is 68).
 */
const MIN_LITERAL_LENGTH = 12;

/**
 * THE HOLE THAT NO BROWSER ASSERTION CAN CLOSE.
 *
 * `e2e/shell.spec.ts` compares the rendered DOM against this catalogue, which
 * catches the copy and the catalogue disagreeing. What it cannot catch — and
 * what no end-to-end test ever could — is `{t('tagline')}` replaced by the same
 * sentence typed into `page.tsx`: the two produce byte-identical DOM, so a
 * browser has nothing to look at. MEASURED: that exact mutation leaves all seven
 * Playwright tests green.
 *
 * It is undetectable by a BROWSER. It is not undetectable. next-intl's whole
 * value is that copy lives in one place, and a literal under `src/` that also
 * appears in the catalogue is a second place — visible to anything that reads
 * the text, which this file already does. MEASURED against that same mutation:
 * this test reports
 * `src/app/page.tsx :: app.tagline :: Cotizaciones de manufactura para …`.
 *
 * BE EXACT ABOUT WHAT IT CATCHES: the check is `source.includes(value)`, so it
 * catches a VERBATIM copy of a catalogue value, not a RECONSTRUCTED one.
 * MEASURED: splitting the sentence across a `+` concatenation defeats it — the
 * full value never appears in the file text — and the vacuity control above
 * still passes, because that control reads the catalogue rather than the source.
 * A template literal, a `.join('')`, or any other assembly is the same hole.
 *
 * That hole is left open deliberately, and the alternative was considered rather
 * than skipped. Normalising `' + '` away would close exactly the concatenation
 * case while leaving every other reconstruction open, and would restore a
 * comment that reads as if the check were complete — which is worse than a
 * stated gap, because the next person would stop looking. The honest framing is
 * that this test raises the cost of a duplicate from "paste it" to "paste it and
 * then deliberately obfuscate it", which is the difference between an accident
 * and a decision. Accidents are what a cheap gate is for.
 *
 * Comments are stripped first, for the reason the header of this file gives: a
 * doc comment quoting a piece of copy on purpose is not a second source for it.
 * Both catalogues are scanned, not just the shipped one — a hardcoded English
 * string is the same defect, and the two files carry the same key set anyway.
 */
describe('the shipped copy', () => {
  const shipped = [esCO, enUS].flatMap((catalogue) =>
    keyPaths(catalogue)
      .map((path) => ({ path, value: valueAt(path, catalogue) }))
      .filter((entry): entry is { path: string; value: string } => typeof entry.value === 'string')
      .filter(({ value }) => value.length >= MIN_LITERAL_LENGTH),
  );

  it('has values long enough to check, so a raised threshold cannot make this vacuous', () => {
    // A threshold above every value in the catalogues would empty `shipped` and
    // turn the assertion below into `[] === []`. This is what notices.
    expect(shipped.map(({ path }) => path)).toContain('app.tagline');
    expect(shipped.length).toBeGreaterThanOrEqual(2);
  });

  it('never appears as a literal under src/, which would be a second source for it', () => {
    const offenders = filesUnder(SRC, ['.ts', '.tsx']).flatMap((file) => {
      const source = withoutComments(readFileSync(file, 'utf8'));
      return shipped
        .filter(({ value }) => source.includes(value))
        .map(({ path, value }) => `${file} :: ${path} :: ${value}`);
    });

    expect(
      offenders,
      'this copy is in the catalogue too — render it with t() instead of duplicating it',
    ).toEqual([]);
  });
});
