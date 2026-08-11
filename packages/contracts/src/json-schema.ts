import { z } from 'zod';
import { DomainErrorCode } from './errors.js';
import {
  MaterialId,
  ModelId,
  ModelVersionId,
  OrderId,
  OrganizationId,
  PrintJobId,
  PrinterProfileVersionId,
  ProjectId,
  QuoteId,
  SliceJobId,
  UserId,
} from './ids.js';
import { CurrencyCode, Money } from './money.js';
import { CubicMillimeters, Grams, Millimeters, Seconds, SquareMillimeters } from './units.js';

/**
 * The Zod→JSON Schema half of `pnpm contracts:emit`. The other half —
 * `datamodel-codegen`, and the committed pydantic models — is driven by
 * `scripts/contracts-emit.mjs` at the repository root.
 *
 * NO NEW DEPENDENCY, and that is the point rather than a convenience. Zod 4
 * ships `z.toJSONSchema()` natively, so this file keeps `packages/contracts`
 * inside its one-dependency budget (docs/ARCHITECTURE.md §7). `docs/
 * CONTRACTS_AND_API.md` used to describe the chain as `zod-to-json-schema →
 * datamodel-codegen`; there is no such package here and there is no
 * justification for adding one.
 *
 * WHAT SURVIVES THE CROSSING, and what does not:
 *
 *   - `pattern`, `minimum`/`maximum`, `enum` and `required` all survive, which
 *     is what makes the Python side VALIDATE rather than merely deserialise.
 *   - Regex FLAGS do not. `z.toJSONSchema()` emits the pattern source and drops
 *     the flags silently, which is why `src/brand.ts` spells case into its
 *     character classes instead of carrying `/i`.
 *   - BRANDING does not. `z.string().regex(…).brand<'QuoteId'>()` emits a plain
 *     constrained string, so Python gets validation but not type identity:
 *     `QuoteId` and `OrderId` are freely interchangeable there in a way they are
 *     not here. ADR-0018's guarantee stops at this boundary and cannot be made
 *     to cross it. Same for the branded numeric units.
 *
 * `\d` IS NOT ALLOWED IN ANY PATTERN THAT REACHES HERE. In JavaScript it is
 * ASCII-only; in Python — both `re` and the Rust engine pydantic uses — it
 * matches any Unicode decimal digit, so the generated model would be strictly
 * more permissive than the Zod schema defining it. `test/json-schema.test.ts`
 * asserts on the EMITTED patterns, which is the only place that is observable.
 * See ADR-0027.
 */

/**
 * Every schema the Python side is given, by the name it is given.
 *
 * Hand-written, and deliberately not derived from `index.ts`'s exports: a list
 * generated from the exports would agree with them by construction and assert
 * nothing. Adding a schema here is the review step that says a worker is allowed
 * to see it. `test/json-schema.test.ts` asserts this list is exactly the set of
 * Zod schemas the package exports, so the two cannot drift apart silently — the
 * check is on the pair, not on either half.
 *
 * `brandedUuid` is absent because it is a factory, not a schema; every ID it
 * builds is here.
 */
const EMITTED = {
  CubicMillimeters,
  CurrencyCode,
  DomainErrorCode,
  Grams,
  MaterialId,
  Millimeters,
  ModelId,
  ModelVersionId,
  Money,
  OrderId,
  OrganizationId,
  PrintJobId,
  PrinterProfileVersionId,
  ProjectId,
  QuoteId,
  Seconds,
  SliceJobId,
  SquareMillimeters,
  UserId,
} as const satisfies Record<string, z.ZodType>;

/** Where a `$defs` entry lives in the assembled document, for `$ref` purposes. */
const DEFS_URI = (id: string): string => `#/$defs/${id}`;

/**
 * The JSON Schema for each emitted contract, keyed by name.
 *
 * Emitted THROUGH A REGISTRY rather than one `z.toJSONSchema(schema)` call per
 * name, and that is not a refactor for its own sake: a per-schema call inlines
 * every nested schema, so `Money.currency` came out as an anonymous copy of the
 * currency enum and `datamodel-codegen` generated a SECOND Python enum called
 * `Currency` beside `CurrencyCode`. Two classes for one contract is the drift
 * this boundary exists to prevent, and it would have been invisible from the
 * TypeScript side. Registered, the same property emits
 * `{ "$ref": "#/$defs/CurrencyCode" }` and Python gets one enum.
 *
 * Deterministic by construction: the keys are sorted rather than left in
 * registration order, and `z.toJSONSchema()` was measured stable across repeated
 * calls on the pinned `zod@4.4.3`. The committed pydantic models are diffed
 * byte-for-byte in CI, so a stable ordering here is load-bearing — an emitter
 * whose output permutes turns that gate red on a tree nobody touched.
 */
export function emitJsonSchemas(): Record<string, unknown> {
  const registry = z.registry<{ id: string }>();
  for (const [name, schema] of Object.entries(EMITTED)) {
    registry.add(schema, { id: name });
  }

  const { schemas } = z.toJSONSchema(registry, { uri: DEFS_URI });
  const result: Record<string, unknown> = {};
  for (const name of Object.keys(schemas).sort()) {
    result[name] = schemas[name];
  }
  return result;
}

/**
 * The single JSON Schema document `datamodel-codegen` consumes.
 *
 * One document with `$defs`, not nineteen files: the generator names a model
 * after the `$defs` key, so this is what makes the Python class called `Money`
 * rather than after whatever the input filename happened to be.
 *
 * Two keys are lifted out of every definition:
 *
 *   - `$schema`, stated once at the root instead of nineteen times.
 *   - `$id`, which Zod sets to the `uri` above (`#/$defs/Money`). A
 *     fragment-only `$id` has not been legal since JSON Schema 2019-09 — it is
 *     a `$ref` TARGET spelled as an identifier — and leaving it inside a
 *     definition invites a resolver to re-base every relative reference under it.
 *     The `$ref`s that point at these names are unaffected: they are resolved
 *     against the document's own `$defs`, which is where the definitions are.
 *
 * The root declares `type: "object"` for a schema with no properties, which
 * reads like a redundancy and is not. MEASURED, on the same `$defs`:
 *
 *   no `type`      →  `class MetrikaContracts(RootModel[Any])`, and `Any` is
 *                     imported into a file `disallow_any_explicit` is already
 *                     being scoped off for.
 *   `type: object` →  an empty `class MetrikaContracts(BaseModel)`, and no `Any`
 *                     anywhere in the generated module.
 *
 * The generator always names a model after the document root; the choice is only
 * between an inert empty class and one typed `Any`.
 */
export function contractsJsonSchemaDocument(): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(emitJsonSchemas())) {
    const { $schema: _schema, $id: _id, ...rest } = schema as Record<string, unknown>;
    defs[name] = rest;
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'MetrikaContracts',
    description: 'Generated from packages/contracts by `pnpm contracts:emit`. Do not edit.',
    type: 'object',
    additionalProperties: false,
    $defs: defs,
  };
}
