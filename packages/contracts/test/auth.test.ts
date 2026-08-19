import { describe, expect, it } from 'vitest';
import { MeResponse, MembershipSummary } from '../src/index.js';

const USER_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4051';
const ORGANIZATION_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4052';

function membership(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    organizationId: ORGANIZATION_ID,
    name: 'Taller Mestra',
    slug: 'taller-mestra',
    kind: 'PERSONAL',
    role: 'OWNER',
    ...overrides,
  };
}

function me(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: USER_ID,
    email: 'ana@example.com',
    displayName: 'Ana Mestra',
    memberships: [membership()],
    ...overrides,
  };
}

describe('MembershipSummary', () => {
  it('accepts one organization as the switcher renders it', () => {
    expect(MembershipSummary.parse(membership())).toEqual(membership());
  });

  it('rejects an organizationId that is not a UUID', () => {
    // The branded ID's regex still applies inside a TS_ONLY schema — being
    // TypeScript-only removes the Python model, not the validation.
    expect(MembershipSummary.safeParse(membership({ organizationId: 'org_2abc' })).success).toBe(
      false,
    );
  });

  it('rejects a role that is not in the roster', () => {
    expect(MembershipSummary.safeParse(membership({ role: 'VIEWER' })).success).toBe(false);
  });

  it('rejects a kind that is not in the roster', () => {
    expect(MembershipSummary.safeParse(membership({ kind: 'COMPANY' })).success).toBe(false);
  });

  it('requires the name and slug the switcher has to render', () => {
    const { name: _name, ...withoutName } = membership();
    const { slug: _slug, ...withoutSlug } = membership();

    expect(MembershipSummary.safeParse(withoutName).success).toBe(false);
    expect(MembershipSummary.safeParse(withoutSlug).success).toBe(false);
  });
});

describe('MeResponse', () => {
  it('accepts a caller with one membership', () => {
    expect(MeResponse.parse(me())).toEqual(me());
  });

  it('accepts a caller with several memberships, which is the construct that forced ADR-0039', () => {
    const two = me({ memberships: [membership(), membership({ kind: 'TEAM', role: 'ADMIN' })] });

    expect((MeResponse.parse(two) as { memberships: unknown[] }).memberships).toHaveLength(2);
  });

  it('accepts an empty membership list', () => {
    // Not a state Plan 1A can produce — provisioning creates the personal
    // organization in the same transaction as the user — but the schema is not
    // the place to assert a database invariant, and a `.min(1)` here would fail
    // a caller whose only organization was being removed rather than telling
    // them why.
    expect(MeResponse.safeParse(me({ memberships: [] })).success).toBe(true);
  });

  it('rejects a memberships field that is not an array', () => {
    expect(MeResponse.safeParse(me({ memberships: membership() })).success).toBe(false);
  });

  it('rejects a membership inside the array that is malformed', () => {
    // The element schema is applied, not merely named — an array of `unknown`
    // would pass the assertion above and fail here.
    expect(
      MeResponse.safeParse(me({ memberships: [membership({ role: 'VIEWER' })] })).success,
    ).toBe(false);
  });

  it('accepts an absent timezone', () => {
    expect(MeResponse.safeParse(me()).success).toBe(true);
  });

  it('accepts a present timezone', () => {
    expect(MeResponse.parse(me({ timezone: 'America/Bogota' }))).toMatchObject({
      timezone: 'America/Bogota',
    });
  });

  it('rejects an explicitly null timezone, which is the exact divergence that keeps `.optional()` out of EMITTED', () => {
    // MEASURED in src/json-schema.ts and pinned by the allowlist fixture in
    // test/json-schema.test.ts: `memo: z.string().optional()` generates
    // `memo: StrictStr | None = None`, which ACCEPTS `"memo": null` on the wire.
    // Optional and nullable are the same thing in pydantic and are not in Zod.
    // This assertion is the Zod half of that pair — if it ever goes green, the
    // two sides have stopped disagreeing and `.optional()` could be revisited.
    expect(MeResponse.safeParse(me({ timezone: null })).success).toBe(false);
  });

  it('rejects a userId that is not a UUID', () => {
    expect(MeResponse.safeParse(me({ userId: 'user_2abcDEF' })).success).toBe(false);
  });

  it('does not validate the shape of an email address, deliberately', () => {
    // NOT `z.email()`, and this asserts the decision rather than an accident.
    // The allowlist rejects every built-in string format, and ADR-0027 measured
    // that `format: email` generates `EmailStr`, which import-fails without the
    // optional `email-validator` package while four gates exit 0. The value
    // arrives from a token Clerk has already verified. See ADR-0039.
    expect(MeResponse.safeParse(me({ email: 'not-an-address' })).success).toBe(true);
  });

  it('still requires an email to be a string', () => {
    expect(MeResponse.safeParse(me({ email: 42 })).success).toBe(false);
  });

  it('strips an undeclared field rather than carrying it to the browser', () => {
    // Zod's default object mode. Worth pinning here because `/me` is the first
    // response schema in the product and this is what makes the response
    // envelope the contract rather than whatever the handler happened to build.
    expect(MeResponse.parse(me({ platformRoles: ['PLATFORM_ADMIN'] }))).not.toHaveProperty(
      'platformRoles',
    );
  });
});
