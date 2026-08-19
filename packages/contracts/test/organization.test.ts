import { describe, expect, it } from 'vitest';
import { OrganizationKind, OrganizationRole, PlatformRole } from '../src/index.js';

/**
 * The three rosters are RESTATED here rather than derived from the schemas,
 * which is the same shape as `test/redaction.test.ts`: a test that reads
 * `Schema.options` and asserts it equals `Schema.options` agrees by construction
 * and catches nothing. These literals are copied from `docs/DOMAIN_MODEL.md`
 * lines 62, 64 and 68, so a member silently added, removed or renamed on one
 * side fails here.
 *
 * ORDER IS ASSERTED, NOT JUST MEMBERSHIP, and that is not pedantry: all three
 * enums are in `EMITTED`, so this order is the member order of the generated
 * pydantic `StrEnum` that CI's `contracts` job byte-diffs. A reordering that
 * `toEqual` on a sorted array would have accepted turns that gate red on a tree
 * nobody meant to touch.
 */
describe('the tenancy vocabulary', () => {
  it('declares the two organization kinds, in DOMAIN_MODEL.md:62 order', () => {
    expect(OrganizationKind.options).toEqual(['PERSONAL', 'TEAM']);
  });

  it('declares the four organization roles, in DOMAIN_MODEL.md:64 order', () => {
    expect(OrganizationRole.options).toEqual(['OWNER', 'ADMIN', 'MEMBER', 'BILLING']);
  });

  it('declares the five platform roles, in DOMAIN_MODEL.md:68 order', () => {
    expect(PlatformRole.options).toEqual([
      'PLATFORM_ADMIN',
      'OPERATIONS',
      'MANUFACTURING_OPERATOR',
      'FINANCE',
      'SUPPORT',
    ]);
  });

  it('parses each declared member', () => {
    expect(OrganizationKind.parse('PERSONAL')).toBe('PERSONAL');
    expect(OrganizationRole.parse('BILLING')).toBe('BILLING');
    expect(PlatformRole.parse('MANUFACTURING_OPERATOR')).toBe('MANUFACTURING_OPERATOR');
  });

  it('rejects a value that is not a member, rather than passing it through', () => {
    expect(OrganizationKind.safeParse('COMPANY').success).toBe(false);
    expect(OrganizationRole.safeParse('VIEWER').success).toBe(false);
    expect(PlatformRole.safeParse('ADMIN').success).toBe(false);
  });

  it('rejects a member of the wrong enum, which is the collision the separate tables exist to prevent', () => {
    // `docs/DOMAIN_MODEL.md:68` keeps platform roles in their own table so an
    // internal staff account can never be confused with a customer membership.
    // A single merged union would make both of these parse.
    expect(OrganizationRole.safeParse('PLATFORM_ADMIN').success).toBe(false);
    expect(PlatformRole.safeParse('OWNER').success).toBe(false);
  });

  it('shares no member between the organization and platform rosters', () => {
    // The generalisation of the assertion above: it fails on any future member
    // added to one roster that already exists in the other, not only on the two
    // pairs spelled out there.
    const shared = OrganizationRole.options.filter((role) =>
      (PlatformRole.options as readonly string[]).includes(role),
    );

    expect(
      shared,
      'a role name in both rosters makes a platform grant and an organization membership indistinguishable by value',
    ).toEqual([]);
  });

  it('rejects the lowercase spelling, because the database enum is uppercase', () => {
    // No `.toUpperCase()` anywhere in the chain: a `.trim()` or a case fold on
    // one of these would be dropped in SILENCE by `z.toJSONSchema()` and the
    // generated pydantic model would not carry it. See src/json-schema.ts.
    expect(OrganizationKind.safeParse('personal').success).toBe(false);
    expect(OrganizationRole.safeParse('owner').success).toBe(false);
  });
});
