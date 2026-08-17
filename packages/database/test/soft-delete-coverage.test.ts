import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { SOFT_DELETABLE_MODELS } from '../src/index.js';

/**
 * `SOFT_DELETABLE_MODELS` is a hand-maintained set of strings and the schema is
 * not, so this asserts the correspondence in BOTH directions rather than
 * trusting it. Without it, a later model gains `deletedAt`, nobody edits the
 * string set, and the model is silently unfiltered AND hard-deletable — two
 * defects from one omission, neither of which shows up as a type error. The
 * reverse direction matters just as much: a name in the set that no model
 * carries makes the extension inject `deletedAt: null` into a query against a
 * column that does not exist, which fails at runtime and only for the callers
 * that touch it.
 *
 * A UNIT test, no Docker: it reads Prisma's datamodel, not a database. It runs
 * inside `pnpm verify`.
 *
 * **MECHANISM: `Prisma.dmmf` shipped, not a `schema.prisma` parse.** Measured on
 * Prisma 7.9.1 during Plan 1A Task 3 before this file was written, because
 * nothing in this repository had ever read Prisma's datamodel and neither the
 * export's presence nor its typing was known. It is exported at runtime and it is
 * TYPED — `Prisma.dmmf` is `runtime.BaseDMMF`, and assigning it to `number`
 * fails with `TS2322` — so nothing here needs `any` and nothing here parses text.
 *
 * **What the type claims and the runtime does not carry** (ADR-0040 consequence
 * 4, and the reason this file uses field NAMES and nothing else): a runtime model
 * object holds only `{ name, fields, dbName }` and a runtime field object only
 * `{ name, kind, type }` plus `relationName`. `isRequired`, `isId`, `default` and
 * `uniqueFields` all TYPE as present and are `undefined`, and
 * `datamodel.enums` is an EMPTY ARRAY even though the migration that created
 * these models creates three Postgres enums. So an assertion built on any of
 * those would pass vacuously forever. Do not extend this file with one; the
 * enum-member assertion lives in `prisma-enum-parity.test.ts` and reads the
 * generated runtime enum objects instead.
 *
 * **Turbo `inputs`: none needed, deliberately.** This file reads no file outside
 * `packages/database` — it imports the generated client, which is a build OUTPUT
 * of this package's own `build` task (`pnpm db:generate && tsc -b`). `test:unit`
 * declares `dependsOn: ["^build", "build"]` (`turbo.json:5-6`), so a
 * `prisma/schema.prisma` edit invalidates `build`, which invalidates this task.
 * The `$TURBO_ROOT$` entry already in this package's `turbo.json` exists only for
 * `postgres-image.test.ts`, which reads `infra/docker/docker-compose.yml`; the
 * schema-parsing fallback this file did NOT take would not have needed one
 * either, since `schema.prisma` lives in-package and `$TURBO_DEFAULT$` already
 * hashes it.
 */

const models = Prisma.dmmf.datamodel.models;

function fieldNames(model: (typeof models)[number]): readonly string[] {
  return model.fields.map((field) => field.name);
}

const modelsWithDeletedAt = models
  .filter((model) => fieldNames(model).includes('deletedAt'))
  .map((model) => model.name);

describe('SOFT_DELETABLE_MODELS against the datamodel', () => {
  it('reads a datamodel with models in it, and a set with names in it', () => {
    // Three vacuity guards, because all three assertions below are filters over
    // one of these collections and an empty collection makes a filter trivially
    // empty. A `dmmf` shape change, a client generated from the wrong schema, or
    // an emptied set would otherwise make this whole file report success while
    // asserting nothing.
    expect(models.length).toBeGreaterThan(0);
    expect(SOFT_DELETABLE_MODELS.size).toBeGreaterThan(0);
    expect(modelsWithDeletedAt.length).toBeGreaterThan(0);
  });

  it('names every model that has a deletedAt column', () => {
    // The direction that catches the expensive omission: a Phase 1B or 1C model
    // that gains `deletedAt` and is not added here is both unfiltered and
    // hard-deletable.
    const missing = modelsWithDeletedAt.filter((name) => !SOFT_DELETABLE_MODELS.has(name));

    expect(missing).toEqual([]);
  });

  it('names nothing that is not a model with a deletedAt column', () => {
    // The other direction, with the two failure modes reported apart: a name
    // that is not a model at all, and a name that is a model but carries no
    // `deletedAt`. `OrganizationMember` is the live case for the second —
    // it is not an Identity entity (`docs/DOMAIN_MODEL.md:13`), it has no
    // `deletedAt`, and naming it here would make every read of it inject a
    // filter on a column that does not exist.
    const offenders = [...SOFT_DELETABLE_MODELS]
      .map((name) => {
        const model = models.find((candidate) => candidate.name === name);
        if (model === undefined) {
          return `${name}: named in SOFT_DELETABLE_MODELS but not a model in the datamodel`;
        }
        if (!fieldNames(model).includes('deletedAt')) {
          return `${name}: a model, but it has no deletedAt field`;
        }
        return undefined;
      })
      .filter((offender): offender is string => offender !== undefined);

    expect(offenders).toEqual([]);
  });
});
