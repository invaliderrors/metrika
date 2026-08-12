import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import * as contracts from '../src/index.js';
import { EMITTED, contractsJsonSchemaDocument, emitJsonSchemas } from '../src/json-schema.js';

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
        'RedactedFieldName',
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
 * A DIVERGENCE FAMILY WITH NO LIVE INSTANCE — which is exactly why it gets a
 * fixture rather than a paragraph. (Deliberately not given an ordinal: the
 * numbering in the block above is this file's own, ADR-0027 does not enumerate
 * these, and a count stated in three places is a count that goes wrong in one.)
 *
 * `z.toJSONSchema()` fails LOUDLY on `.transform()`, `z.bigint()` and
 * `z.date()`: it throws, `pnpm contracts:emit` dies, and somebody fixes it.
 * Those are safe. It fails SILENTLY on everything below, every one measured on
 * the pinned `zod@4.4.3` by the test at the end of this block:
 *
 *   `.refine()`, `.superRefine()`   emitted as if never written
 *   `.trim()`, `.toLowerCase()`     emitted as if never written
 *   `z.coerce.*`                    emits the bare target type
 *   `.optional()`                   the property leaves `required`, nothing else
 *   `.catch(x)`                     DEGRADED to a non-validating `default: x`
 *
 * PROVEN END TO END on `Money.amountMinor`: with a `.refine()` capping the digit
 * count, `pnpm contracts:emit` produced a BYTE-IDENTICAL pydantic file, CI's
 * `git diff --exit-code` exited 0, this package's suite passed 213/213 at 100%
 * coverage and `apps/workers` passed 165 — while Zod rejected a 40-digit
 * `amountMinor` and the generated model accepted it.
 *
 * Every other guard on this boundary is a POSITIVE assertion: this pattern is
 * present, this bound arrived, this enum member crossed. Nothing asserted the
 * absence of a construct that cannot cross, and `EMITTED` reviews *which*
 * schemas cross, never *what about them* does. No contract triggers this today;
 * the next one added would look exactly like the four defects this branch has
 * already found, and this repository's own standard is that a control without a
 * fixture asserting rejection is an intention.
 *
 * AN ALLOWLIST, NOT A DENYLIST, for the reason Task 7 established: a denylist
 * leaves every construct nobody thought of reachable, and the list of things
 * `z.toJSONSchema()` drops is a property of a library this repository does not
 * own and does not control across versions. Adding a node kind or a check here
 * is the review step that says somebody measured it across the boundary and
 * wrote the Python-side test proving it landed.
 *
 * `.optional()` IS REJECTED OUTRIGHT, and that is a decision rather than an
 * oversight. MEASURED: `memo: z.string().optional()` generates
 * `memo: StrictStr | None = None`, which ACCEPTS an explicit `"memo": null` on
 * the wire where Zod rejects it — optional and nullable are the same thing in
 * pydantic and are not in Zod. It could instead be admitted with a Python-side
 * probe pinning that behaviour, and it is not, because NO SCHEMA IN `EMITTED`
 * USES IT: admitting a construct with no user and no test would be adding the
 * intention this whole block exists to refuse. The day a contract needs an
 * optional field, adding it here alongside a `test_generated_contracts.py` case
 * for the `null` payload is a small, deliberate change — which is the point.
 */
describe('every emitted schema is built only from constructs that survive emission', () => {
  /** A Zod 4 check's internals, narrowed to what this walk reads. */
  interface CheckInternals {
    readonly _zod: { readonly def: { readonly check: string; readonly format?: string } };
  }

  /**
   * A Zod 4 schema's internals, narrowed to what this walk reads.
   *
   * `check`/`format` appear TWICE in this shape, and both positions are
   * load-bearing. `z.string().regex(…)` puts a `string_format` check in
   * `def.checks[]`, while a built-in format constructor — `z.email()`,
   * `z.uuid()`, `z.iso.datetime()` — IS the node: `def.check` is
   * `'string_format'` and `def.checks` is empty. Reading only the array made
   * `z.email()` walk through clean, which is how this was found.
   */
  interface SchemaInternals {
    readonly _zod: {
      readonly def: {
        readonly type: string;
        readonly coerce?: boolean;
        readonly check?: string;
        readonly format?: string;
        readonly checks?: readonly CheckInternals[];
        readonly shape?: Readonly<Record<string, z.ZodType>>;
      };
    };
  }

  function definitionOf(schema: z.ZodType): SchemaInternals['_zod']['def'] {
    return (schema as unknown as SchemaInternals)._zod.def;
  }

  /**
   * `def.type` for every node an emitted schema may be built from. `object` is
   * the only container: everything else is a leaf, which is what makes the
   * descent below complete.
   */
  const ALLOWED_NODE_KINDS = new Set(['object', 'string', 'number', 'enum']);

  /**
   * Every constraint an emitted schema may carry. `number_format` is `.int()`,
   * `greater_than`/`less_than` are `.min()`/`.max()`/`.nonnegative()`, and
   * `string_format` is `.regex()` — see below.
   *
   * Constraints that DO cross are absent too when nothing uses them —
   * `min_length`, `max_length`, `multipleOf`. That is the allowlist working as
   * intended rather than an omission: the list is what has been measured across
   * the boundary AND pinned by a `test_generated_contracts.py` case, not what
   * could plausibly work. Adding one is two small deliberate edits.
   */
  const ALLOWED_CHECKS = new Set(['string_format', 'number_format', 'greater_than', 'less_than']);

  /**
   * `regex` and nothing else, and the restriction is measured rather than
   * cautious. Zod's built-in string formats are NOT uniform: `z.email()` emits a
   * `pattern` beside its `format`, while `z.jwt()` and `z.url()` emit a bare
   * `format` with NO pattern at all — so the constraint reaches a generator that
   * understands the format keyword and vanishes for one that does not. That is
   * the same silent-drop shape as the rest of this block. The built-in formats
   * also carry `\d` in their patterns, which is the divergence the block above
   * reports rather than fails on; a new one arriving should be a decision here,
   * not a line in a report nobody reads.
   */
  const ALLOWED_STRING_FORMATS = new Set(['regex']);

  const NODE_KIND_NAMES: Readonly<Record<string, string>> = {
    optional: '`.optional()`',
    nullable: '`.nullable()`',
    default: '`.default()`',
    catch: '`.catch()`',
    pipe: '`.pipe()` / `.transform()`',
  };

  const CHECK_NAMES: Readonly<Record<string, string>> = {
    custom: '`.refine()` / `.superRefine()`',
    overwrite: '`.trim()` / `.toLowerCase()` / another value mutation',
  };

  /**
   * Every construct in `schema` that cannot cross, and every node it visited on
   * the way. The visited list is what keeps an empty offender list from being
   * vacuous — a walk that reaches nothing reports nothing.
   */
  function walk(
    schema: z.ZodType,
    at: string,
  ): { readonly offenders: readonly string[]; readonly visited: readonly string[] } {
    const definition = definitionOf(schema);
    const offenders: string[] = [];
    const visited: string[] = [at];

    function offenceIn(kind: string, format: string | undefined): string | undefined {
      if (!ALLOWED_CHECKS.has(kind)) {
        return `${at}: ${CHECK_NAMES[kind] ?? `a \`${kind}\` check`}`;
      }
      if (kind === 'string_format' && !ALLOWED_STRING_FORMATS.has(format ?? '')) {
        return `${at}: the \`${format ?? 'unnamed'}\` string format`;
      }
      return undefined;
    }

    if (!ALLOWED_NODE_KINDS.has(definition.type)) {
      offenders.push(
        `${at}: ${NODE_KIND_NAMES[definition.type] ?? `a \`${definition.type}\` node`}`,
      );
    }
    if (definition.coerce === true) {
      offenders.push(`${at}: \`z.coerce.${definition.type}()\``);
    }
    // The node's own check, which is where a built-in format constructor lives.
    if (definition.check !== undefined) {
      const offence = offenceIn(definition.check, definition.format);
      if (offence !== undefined) offenders.push(offence);
    }
    for (const check of definition.checks ?? []) {
      const offence = offenceIn(check._zod.def.check, check._zod.def.format);
      if (offence !== undefined) offenders.push(offence);
    }

    // `object` is the only container on the allowlist, so descending through
    // its shape reaches every node a PASSING schema can have. A container that
    // is not on the list has already been reported by the time we are here, and
    // its children are unreachable from a schema this test lets through.
    for (const [key, child] of Object.entries(definition.shape ?? {})) {
      const inner = walk(child, `${at}.${key}`);
      offenders.push(...inner.offenders);
      visited.push(...inner.visited);
    }

    return { offenders, visited };
  }

  function walkEmitted(): { readonly offenders: readonly string[]; readonly visited: string[] } {
    const offenders: string[] = [];
    const visited: string[] = [];
    for (const [name, schema] of Object.entries(EMITTED)) {
      const result = walk(schema, name);
      offenders.push(...result.offenders);
      visited.push(...result.visited);
    }
    return { offenders, visited };
  }

  it('reaches every emitted schema and descends into their properties', () => {
    const { visited } = walkEmitted();

    expect(visited).toContain('Money');
    expect(visited).toContain('Money.amountMinor');
    expect(visited).toContain('Money.currency');
    expect(visited).toContain('Money.exponent');
    // Every schema in the table, plus `Money`'s three properties — the only
    // nested nodes in the package today. An exact count rather than a lower
    // bound, so that a schema growing a nested object nobody walked shows up
    // here rather than passing by not being looked at.
    expect(visited.length).toBe(Object.keys(EMITTED).length + 3);
  });

  it('finds nothing unsurvivable in the tree as it stands', () => {
    expect(
      walkEmitted().offenders,
      "this construct is not on the allowlist of things measured to survive `z.toJSONSchema()`. Most of what is missing is dropped in SILENCE — the generated pydantic model then accepts what Zod rejects, and `pnpm contracts:emit`, CI's `git diff --exit-code` and every test on both sides stay green. Rewrite the schema; or, if it does cross, measure it, add the `test_generated_contracts.py` case proving it landed on the Python side, and add it to the allowlist above in the same commit.",
    ).toEqual([]);
  });

  // The fixtures. Each one is a construct that emits a schema indistinguishable
  // from a schema that never carried it, wrapped in an object so the report has
  // a property path to name — which is the half a failing developer needs.
  const REJECTED: [string, z.ZodType, string][] = [
    [
      '.refine()',
      z.object({ amountMinor: z.string().refine((value) => value.length <= 30) }),
      'Probe.amountMinor: `.refine()` / `.superRefine()`',
    ],
    [
      '.superRefine()',
      z.object({ amountMinor: z.string().superRefine(() => undefined) }),
      'Probe.amountMinor: `.refine()` / `.superRefine()`',
    ],
    [
      '.trim()',
      z.object({ currency: z.string().trim() }),
      'Probe.currency: `.trim()` / `.toLowerCase()` / another value mutation',
    ],
    [
      '.toLowerCase()',
      z.object({ currency: z.string().toLowerCase() }),
      'Probe.currency: `.trim()` / `.toLowerCase()` / another value mutation',
    ],
    ['.optional()', z.object({ memo: z.string().optional() }), 'Probe.memo: `.optional()`'],
    ['.nullable()', z.object({ memo: z.string().nullable() }), 'Probe.memo: `.nullable()`'],
    ['.default()', z.object({ memo: z.string().default('') }), 'Probe.memo: `.default()`'],
    ['.catch()', z.object({ memo: z.string().catch('') }), 'Probe.memo: `.catch()`'],
    [
      'z.coerce.string()',
      z.object({ amountMinor: z.coerce.string() }),
      'Probe.amountMinor: `z.coerce.string()`',
    ],
    [
      'z.coerce.number()',
      z.object({ exponent: z.coerce.number() }),
      'Probe.exponent: `z.coerce.number()`',
    ],
    // A built-in format IS the node — `def.check`, not `def.checks[]` — so this
    // pair is the fixture for the position the first draft of the walk missed.
    [
      'a built-in string format',
      z.object({ memo: z.email() }),
      'Probe.memo: the `email` string format',
    ],
    [
      "Zod's own uuid, which brand.ts deliberately does not use",
      z.object({ memo: z.uuid() }),
      'Probe.memo: the `uuid` string format',
    ],
    // Crosses perfectly well, and is still reported: nothing uses it and no
    // Python-side test pins it. Fails closed, on purpose.
    [
      'a length bound nothing has measured yet',
      z.object({ memo: z.string().min(1) }),
      'Probe.memo: a `min_length` check',
    ],
    [
      'an unlisted node kind',
      z.object({ memo: z.array(z.string()) }),
      'Probe.memo: a `array` node',
    ],
  ];

  describe.each(REJECTED)('rejects %s', (_construct, schema, expected) => {
    it('names the construct and the property carrying it', () => {
      expect(walk(schema, 'Probe').offenders).toEqual([expected]);
    });
  });

  it('accepts a schema built only from what `Money` and the IDs already use', () => {
    // The positive control. Without it, a walk that reported everything would
    // pass every test above and fail the one that matters on the first change.
    const clean = z.object({
      amountMinor: z.string().regex(/^[0-9]+$/),
      currency: z.enum(['COP', 'USD']),
      exponent: z.number().int().min(0).max(4),
      length: z.number().nonnegative().max(Number.MAX_VALUE),
    });

    expect(walk(clean, 'Probe').offenders).toEqual([]);
  });

  it('measures that the emitter really is blind to all of them', () => {
    // The justification for this entire block, asserted rather than asserted-in-
    // prose. If a future Zod starts representing any of these, this test goes red
    // and the corresponding entry can be reconsidered on evidence.
    const bare = JSON.stringify(z.toJSONSchema(z.string()));

    expect(JSON.stringify(z.toJSONSchema(z.string().refine(() => false)))).toBe(bare);
    expect(JSON.stringify(z.toJSONSchema(z.string().superRefine(() => undefined)))).toBe(bare);
    expect(JSON.stringify(z.toJSONSchema(z.string().trim()))).toBe(bare);
    expect(JSON.stringify(z.toJSONSchema(z.string().toLowerCase()))).toBe(bare);
    expect(JSON.stringify(z.toJSONSchema(z.coerce.string()))).toBe(bare);
    expect(JSON.stringify(z.toJSONSchema(z.string().optional()))).toBe(bare);

    // Worse than dropped: `.catch()` becomes a `default`, which is documentation
    // rather than validation — the generated model would carry a fallback value
    // and validate nothing.
    expect(z.toJSONSchema(z.string().catch('fallback'))).toMatchObject({
      type: 'string',
      default: 'fallback',
    });
  });

  it('does not duplicate what `z.toJSONSchema()` already fails loudly on', () => {
    // These three throw, so `pnpm contracts:emit` dies and somebody fixes it.
    // They are not this test's job, and pinning that is what stops the allowlist
    // being widened on the theory that Zod catches everything.
    expect(() => z.toJSONSchema(z.string().transform((value) => value))).toThrow();
    expect(() => z.toJSONSchema(z.bigint())).toThrow();
    expect(() => z.toJSONSchema(z.date())).toThrow();
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
