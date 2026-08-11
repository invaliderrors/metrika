import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import * as contracts from '../src/index.js';
import { contractsJsonSchemaDocument, emitJsonSchemas } from '../src/json-schema.js';

describe('emitJsonSchemas', () => {
  const schemas = emitJsonSchemas();

  it('emits every schema the Python side needs, by name', () => {
    expect(Object.keys(schemas).sort()).toEqual(
      [
        'CubicMillimeters',
        'CurrencyCode',
        'DomainErrorCode',
        'Grams',
        'MaterialId',
        'Millimeters',
        'ModelId',
        'ModelVersionId',
        'Money',
        'OrderId',
        'OrganizationId',
        'PrintJobId',
        'PrinterProfileVersionId',
        'ProjectId',
        'QuoteId',
        'Seconds',
        'SliceJobId',
        'SquareMillimeters',
        'UserId',
      ].sort(),
    );
  });

  it('keeps the integer-string pattern on Money.amountMinor', () => {
    // Without the pattern the Python model accepts "3500.00" and float money
    // re-enters the system at the language boundary — the one place no
    // TypeScript test can see.
    const money = schemas['Money'] as { properties: { amountMinor: { pattern?: string } } };
    const { pattern } = money.properties.amountMinor;
    expect(pattern).toBeDefined();
    // Narrowed with a throw rather than `!`, which `@typescript-eslint/
    // no-non-null-assertion` forbids repo-wide. Same shape as
    // `test/brand.test.ts`, which asserts on an emitted pattern for the same
    // reason: the JSON Schema is the only artefact Python ever sees.
    if (pattern === undefined) throw new TypeError('Money.amountMinor emitted no pattern');
    expect(new RegExp(pattern).test('3500.00')).toBe(false);
    expect(new RegExp(pattern).test('350000')).toBe(true);
  });

  it('keeps the exponent bounds', () => {
    const money = schemas['Money'] as {
      properties: { exponent: { minimum?: number; maximum?: number } };
    };
    expect(money.properties.exponent.minimum).toBe(0);
    expect(money.properties.exponent.maximum).toBe(4);
  });

  it('is deterministic across two calls', () => {
    expect(JSON.stringify(emitJsonSchemas())).toBe(JSON.stringify(emitJsonSchemas()));
  });

  // JSON Schema has no `finite` keyword, and a bare `{ "type": "number" }`
  // generates a pydantic float that ACCEPTS NaN, +inf and -inf — measured, on
  // the five quantities CLAUDE.md says flow into money, on the side that
  // PRODUCES them. `minimum`/`maximum` do cross, and ±Number.MAX_VALUE is
  // exactly the set of finite doubles.
  //
  // These bounds are a no-op on this side, which is precisely why they need a
  // test: nothing else here would notice them being deleted as redundant.
  describe.each([
    ['Millimeters', -Number.MAX_VALUE],
    ['SquareMillimeters', 0],
    ['CubicMillimeters', 0],
    ['Grams', 0],
    ['Seconds', 0],
  ])('%s carries the finite bounds', (name, minimum) => {
    it('emits both, so finiteness survives the crossing', () => {
      const unit = schemas[name] as { minimum?: number; maximum?: number };

      expect(unit.minimum).toBe(minimum);
      expect(unit.maximum).toBe(Number.MAX_VALUE);
    });
  });

  it('rejects the values those bounds exist to exclude, on this side too', () => {
    // The Zod schemas already reject all three without the bounds. That is the
    // trap: the bounds look like noise here and are load-bearing there.
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(contracts.Millimeters.safeParse(bad).success).toBe(false);
      expect(contracts.Grams.safeParse(bad).success).toBe(false);
    }
    expect(contracts.Millimeters.safeParse(-12.5).success).toBe(true);
    expect(contracts.Grams.safeParse(12).success).toBe(true);
  });
});

/**
 * The list above is hand-written, which is what makes it a review step: adding a
 * schema to `packages/contracts` and forgetting to emit it is the failure this
 * boundary is built to prevent, and a list generated from the exports would
 * agree with the exports by construction and assert nothing.
 *
 * So the list is checked against reality here instead. This is the half that
 * cannot be satisfied by editing one place: a new Zod export must appear in
 * `EMITTED` *and* in the test above, in the same commit, or one of the two
 * fails.
 */
describe('the emitted set covers every Zod schema the package exports', () => {
  function exportedSchemaNames(): string[] {
    return Object.entries(contracts)
      .filter(([, value]) => value instanceof z.ZodType)
      .map(([name]) => name)
      .sort();
  }

  it('finds a non-trivial number of exported schemas, so this cannot be vacuous', () => {
    // `brandedUuid` is a factory, not a schema, so it is deliberately not here;
    // every ID it builds is.
    expect(exportedSchemaNames()).toContain('Money');
    expect(exportedSchemaNames()).toContain('QuoteId');
    expect(exportedSchemaNames().length).toBeGreaterThan(10);
  });

  it('emits exactly the exported schemas — no more, no fewer', () => {
    expect(
      Object.keys(emitJsonSchemas()).sort(),
      'a Zod schema exported from packages/contracts is not reaching the Python side (or a name in EMITTED no longer exists)',
    ).toEqual(exportedSchemaNames());
  });
});

/**
 * ADR-0027's third divergence family, asserted on THIS side as far as it can be.
 *
 * `\d` is ASCII-only in JavaScript and Unicode-aware in Python, so an emitted
 * pattern containing one means the generated pydantic model is strictly more
 * permissive than the Zod schema that defines it. `money.ts` and `brand.ts` were
 * both fixed for exactly this; the remaining exposure is Zod's own built-in
 * formats (`z.e164()`, `z.iso.datetime()`, …), whose patterns are library
 * internals this repository cannot edit.
 *
 * ADR-0027 decided NOT to post-process those in the emitter. This test therefore
 * does not fail the build on a built-in format — it reports which emitted
 * patterns carry the hazard, and the Python suite carries the matching
 * behavioural check. Today the answer is "none", and that is worth pinning: it
 * is the state in which the two sides provably agree.
 */
describe('emitted patterns are engine-independent', () => {
  function emittedPatterns(): { name: string; pattern: string }[] {
    return Object.entries(emitJsonSchemas()).flatMap(([name, schema]) =>
      collectPatterns(schema).map((pattern) => ({ name, pattern })),
    );
  }

  function collectPatterns(node: unknown): string[] {
    if (Array.isArray(node)) return node.flatMap(collectPatterns);
    if (typeof node !== 'object' || node === null) return [];
    const record = node as Record<string, unknown>;
    const here = typeof record['pattern'] === 'string' ? [record['pattern']] : [];
    return [...here, ...Object.values(record).flatMap(collectPatterns)];
  }

  it('finds the patterns it claims to check', () => {
    expect(emittedPatterns().map(({ name }) => name)).toContain('Money');
    expect(emittedPatterns().length).toBeGreaterThan(10);
  });

  it('spells no digit class as `\\d`, which means two different things in JS and Python', () => {
    const offenders = emittedPatterns()
      .filter(({ pattern }) => /\\d/.test(pattern))
      .map(({ name, pattern }) => `${name}: ${pattern}`);

    expect(
      offenders,
      "write `[0-9]` — Python's `\\d` matches any Unicode decimal digit, so the generated model accepts money TypeScript rejects. If this is a Zod built-in whose pattern cannot be edited, see ADR-0027 and add a Python-side rejection test for it.",
    ).toEqual([]);
  });
});

/**
 * The committed pydantic models are stale unless proven otherwise — LOCALLY.
 *
 * CI already runs `pnpm contracts:emit` and `git diff --exit-code`, which is the
 * byte-exact answer and the authoritative one. This is the same question asked
 * where `pnpm verify` can hear it, because a gate that exists only in CI makes
 * `pnpm verify` systematically weaker than the pull request — the exact gap that
 * shipped twice through `--max-warnings=0` (see .github/workflows/ci.yml).
 *
 * Structural rather than byte-exact, deliberately: reproducing the bytes means
 * running `datamodel-codegen`, and putting a Python toolchain inside
 * `@metrika/contracts`'s unit tests would be a worse trade than the coverage it
 * buys. What is checked here is what a stale file actually looks like — a schema
 * that is not there, a regex that no longer matches, an enum member that was
 * added on one side only.
 *
 * TURBO HASHES THIS FILE'S PACKAGE ONLY, so the `inputs` declaration in
 * `packages/contracts/turbo.json` is what makes this gate real. Without it,
 * editing the generated Python file leaves this task a CACHE HIT and the check
 * never runs. Four gates in this repository were in exactly that state.
 */
describe('the committed pydantic models still match these schemas', () => {
  const generated = path.resolve(
    import.meta.dirname,
    '../../../apps/workers/packages/metrika_core/src/metrika_core/contracts/__init__.py',
  );

  function pythonSource(): string {
    return readFileSync(generated, 'utf8');
  }

  it('reads a real generated module, so a wrong path cannot make this vacuous', () => {
    expect(pythonSource()).toContain('GENERATED BY `pnpm contracts:emit`');
    expect(pythonSource().length).toBeGreaterThan(2000);
  });

  it('declares a class for every emitted schema', () => {
    const source = pythonSource();
    const missing = Object.keys(emitJsonSchemas()).filter(
      (name) => !new RegExp(`^class ${name}\\b`, 'm').test(source),
    );

    expect(missing, 'run `pnpm contracts:emit` and commit the result').toEqual([]);
  });

  it('carries every emitted pattern verbatim', () => {
    const source = pythonSource();
    const document = JSON.stringify(contractsJsonSchemaDocument());
    const patterns = [...new Set(collectStrings(JSON.parse(document), 'pattern'))];

    expect(patterns.length).toBeGreaterThan(0);
    // The pattern is written into the Python file as a double-quoted literal,
    // and none of these patterns contains a character Python escapes — asserted
    // by the `\d` test above, which is the only escape they could carry.
    const missing = patterns.filter((pattern) => !source.includes(`"${pattern}"`));

    expect(missing, 'a regex changed on the Zod side and was never re-emitted').toEqual([]);
  });

  it('carries every emitted numeric bound', () => {
    const source = pythonSource();
    // `ge=`/`le=` is how `--use-annotated` writes `minimum`/`maximum`. Asserted
    // on the FULL PRECISION literal, because a bound rounded on the way across
    // is a bound that no longer means "finite".
    expect(source).toContain('le=1.7976931348623157e308');
    expect(source).toContain('ge=-1.7976931348623157e308');
    expect(source).toContain('ge=0.0, le=1.7976931348623157e308');
  });

  it('keeps the strict scalar types, which are what stop lax coercion', () => {
    // Without them pydantic reads "12.5" and True as floats, and "2" and True
    // as ints, where Zod rejects all four.
    const source = pythonSource();

    expect(source).toContain('RootModel[StrictFloat]');
    expect(source).toContain('StrictStr');
    expect(source).toContain('StrictInt');
  });

  it('carries every emitted enum member', () => {
    const source = pythonSource();
    const document: unknown = JSON.parse(JSON.stringify(contractsJsonSchemaDocument()));
    const members = [...new Set(collectEnumMembers(document))];

    expect(members.length).toBeGreaterThan(20);
    const missing = members.filter((member) => !source.includes(`= "${member}"`));

    expect(missing, 'an enum member changed on the Zod side and was never re-emitted').toEqual([]);
  });
});

function collectStrings(node: unknown, key: string): string[] {
  if (Array.isArray(node)) return node.flatMap((item) => collectStrings(item, key));
  if (typeof node !== 'object' || node === null) return [];
  const record = node as Record<string, unknown>;
  const here = typeof record[key] === 'string' ? [record[key]] : [];
  return [...here, ...Object.values(record).flatMap((value) => collectStrings(value, key))];
}

function collectEnumMembers(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(collectEnumMembers);
  if (typeof node !== 'object' || node === null) return [];
  const record = node as Record<string, unknown>;
  const here = Array.isArray(record['enum'])
    ? record['enum'].filter((value): value is string => typeof value === 'string')
    : [];
  return [...here, ...Object.values(record).flatMap(collectEnumMembers)];
}
