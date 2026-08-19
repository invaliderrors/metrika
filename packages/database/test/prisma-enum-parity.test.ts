import { $Enums } from '@prisma/client';
import {
  CurrencyCode as ZodCurrencyCode,
  OrganizationKind as ZodOrganizationKind,
  OrganizationRole as ZodOrganizationRole,
} from '@metrika/contracts';
import { describe, expect, it } from 'vitest';

/**
 * The assertion Plan 1A Task 3's Consumes line owes Task 2: "the Prisma enums
 * must carry the same members, and Task 3 asserts it". ADR-0040 sub-decision (a)
 * names the obligation without pinning a filename; this is the file.
 *
 * MEMBER ORDER, not just the member set. All three Zod enums are in `EMITTED`
 * (`packages/contracts/src/json-schema.ts`), so their declaration order IS the
 * member order of the generated pydantic `StrEnum` that CI's `contracts` job
 * byte-diffs — see `packages/contracts/src/organization.ts:3-27` and
 * [ADR-0039](../../../docs/adr/0039-contracts-typescript-only-exports.md).
 * Keeping one order across the Zod enum, the Prisma enum and
 * `docs/DOMAIN_MODEL.md` is the whole reason the three are reviewable against
 * each other, so a reorder is a red gate here rather than a silent divergence
 * nobody notices until the pydantic diff.
 *
 * A UNIT test, no Docker, and it reads no file outside `packages/database`:
 * `@prisma/client` is a build output of this package's own `build` task and
 * `@metrika/contracts` arrives through the `^build` edge, both of which
 * `test:unit` declares in `turbo.json`. No `inputs` entry is needed.
 *
 * **It reads the generated runtime enum objects, NOT `Prisma.dmmf`.** Measured
 * during Task 3 and recorded as ADR-0040 consequence 4:
 * `Prisma.dmmf.datamodel.enums` is an EMPTY ARRAY at runtime while being typed as
 * populated, so an assertion built on it would pass vacuously forever. `$Enums`
 * is the populated one.
 */

describe('the Prisma enums carry the same members, in the same order, as their Zod counterparts', () => {
  it('generates exactly the three enums the schema declares, and no more', () => {
    // A vacuity guard AND a real assertion. The guard half: if `$Enums` were
    // empty, all three assertions below would compare two empty arrays and pass.
    // The assertion half: the three per-enum checks below can only see an enum
    // somebody remembered to list here, so this is what catches a FOURTH Prisma
    // enum added with no Zod counterpart at all — including `PlatformRole`, which
    // deliberately has no Prisma enum in 1A, because its only column is
    // `PlatformRoleAssignment.role` and that table lands in Plan 1D.
    expect(Object.keys($Enums)).toEqual(['OrganizationKind', 'OrganizationRole', 'CurrencyCode']);
  });

  it('OrganizationKind', () => {
    expect(ZodOrganizationKind.options.length).toBeGreaterThan(0);
    expect(Object.keys($Enums.OrganizationKind)).toEqual([...ZodOrganizationKind.options]);
  });

  it('OrganizationRole', () => {
    expect(ZodOrganizationRole.options.length).toBeGreaterThan(0);
    expect(Object.keys($Enums.OrganizationRole)).toEqual([...ZodOrganizationRole.options]);
  });

  it('CurrencyCode', () => {
    // `Organization.defaultCurrency` is the only column on this type, and that is
    // deliberate: `Money.currency` stays `String @db.Char(3)` because a persisted
    // historical amount must stay parseable after the vocabulary changes, where a
    // mutable configuration default should be pinned to today's. ADR-0040
    // sub-decision (a).
    expect(ZodCurrencyCode.options.length).toBeGreaterThan(0);
    expect(Object.keys($Enums.CurrencyCode)).toEqual([...ZodCurrencyCode.options]);
  });
});
