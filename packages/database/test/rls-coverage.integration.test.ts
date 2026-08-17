import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stopDatabase, withDatabase } from './support.js';

/**
 * The catalog-driven coverage gate — the part of Plan 1A Task 3 that outlives
 * Plan 1A Task 3.
 *
 * Everything that policed row-level security before this file was scoped to a
 * table somebody had already thought about. `rls.integration.test.ts:207-218`
 * filters `pg_policies` by `policyname = 'RlsProbe_tenant_isolation'`;
 * `migration-sql.test.ts:51-57` greps the concatenated migration history for
 * `USING ("organizationId" = app_current_org_id())` and its `WITH CHECK`
 * twin — substring checks that the init migration satisfies forever, whatever
 * any later migration does. **Neither would notice a Phase 1B, 1C or 1D table
 * whose policy omits `WITH CHECK`, and neither can see a table created without
 * `ENABLE ROW LEVEL SECURITY` at all**: the `FORCE`-for-every-`ENABLE` loop in
 * `migration-sql.test.ts:35-49` starts from tables that say `ENABLE`, so a table
 * that says nothing is invisible to it. That asymmetry is the entire reason this
 * file exists.
 *
 * So this one enumerates, from the LIVE catalog rather than from the migration
 * text: every ordinary table in schema `public`, and every policy on it. What is
 * being policed is the migrations nobody has written yet.
 *
 * It reads `pg_class` and `pg_policies` through the ordinary `metrika_app`
 * client, which needs no grant and — unlike a behavioural probe — cannot be
 * fooled by which role happens to be asking. That matters here for the same
 * reason `rls.integration.test.ts:121-160` records: this harness's owner role is
 * a bootstrap superuser and bypasses RLS unconditionally, so `FORCE` is
 * behaviourally invisible through it and the catalog bit is the only trustworthy
 * check.
 */

/**
 * Every table in schema `public` is tenant-scoped and must have row-level
 * security, unless it is named here WITH A REASON. Adding a table therefore
 * means adding a policy or arguing in this list — an omission is a failure, not
 * a silence.
 *
 * A `Map` rather than a `Set` so the reason is structurally required: an
 * exemption nobody can defend in one sentence is not an exemption.
 */
const NOT_TENANT_SCOPED: ReadonlyMap<string, string> = new Map([
  ['HealthCheck', '/health/deep round-trip target; holds no customer data'],
  ['_prisma_migrations', "Prisma's own ledger; metrika_app has no privileges on it at all"],
]);

/**
 * The functions a policy predicate may be built out of.
 *
 * A LIST, not a substring pair, because the set grows:
 * `20260817144359_identity_and_tenancy` added three at once, Plan 1D's
 * elevated-client work may add more, and a policy referencing something that is
 * not on this list is a policy nobody reviewed. Each entry says what it scopes
 * to, so adding one is a sentence somebody has to write.
 */
const TENANCY_FUNCTIONS: ReadonlyMap<string, string> = new Map([
  ['app_current_org_id', 'the active organization'],
  ['app_current_user_id', 'the authenticated user, across organizations'],
  ['app_current_auth_provider', 'identity bootstrap — half of the pre-identity pair'],
  ['app_current_external_auth_id', 'identity bootstrap — the other half'],
]);

/**
 * The `cmd` values that admit a NEW row, and therefore require a write
 * predicate. `pg_policies.cmd` is one of `ALL`, `SELECT`, `INSERT`, `UPDATE`,
 * `DELETE`; `SELECT` and `DELETE` produce no new row and correctly carry a NULL
 * `with_check`.
 */
const WRITE_ADMITTING_COMMANDS: ReadonlySet<string> = new Set(['ALL', 'INSERT', 'UPDATE']);

/**
 * The `cmd` values that read existing rows, and therefore require a `qual`.
 *
 * The FOURTH false rejection, and it is the mirror image of the first one below:
 * `pg_policies.qual` is NULL **by definition** for a `FOR INSERT` policy —
 * PostgreSQL does not permit `USING` on `INSERT`, because there is no existing
 * row to filter — so a blanket non-null `qual` assertion rejects a correct
 * `FOR INSERT WITH CHECK (…)` policy for being exactly right, the same way a
 * blanket non-null `with_check` assertion would reject `User_identity_bootstrap`.
 * MEASURED on a throwaway table: `CREATE POLICY … FOR INSERT WITH CHECK (…)`
 * reads back `cmd = INSERT`, `qual IS NULL`, `with_check` non-null.
 *
 * It matters because the cheapest way to satisfy a gate that mis-rejects your
 * policy is to widen the policy — a Plan 1B/1C/1D author with an insert-only
 * predicate would reach for `FOR ALL`, and the gate would have talked them into
 * a worse policy.
 */
const READ_FILTERING_COMMANDS: ReadonlySet<string> = new Set(['ALL', 'SELECT', 'UPDATE', 'DELETE']);

/**
 * THE APPLIED PREDICATES, PINNED. `referencesTenancyFunction` below is a
 * substring test, and a substring test cannot tell a constraint from a mention:
 * MEASURED, a table carrying one PERMISSIVE policy whose `USING` and
 * `WITH CHECK` were both `(true OR app_current_org_id() IS NOT NULL)` satisfied
 * every other assertion in this file — the suite passed 55/55 — while a row
 * written under one organization was readable from another AND readable with no
 * context set at all. PostgreSQL does not constant-fold a policy expression at
 * `CREATE POLICY` time, so the harmless-looking mention survives into
 * `pg_policies` and the gate reads it as a predicate.
 *
 * So the gate does not ask what a predicate mentions. It asks what the predicate
 * IS, against the values read back from the catalog, in both directions: a
 * changed predicate, a new policy and a deleted policy are all failures. That is
 * this repository's own golden-file rule ("the golden-file diff is the review",
 * CLAUDE.md) applied to policy predicates, and it costs a future author one entry
 * per policy — which is the review surface, not an obstacle.
 *
 * Whitespace is normalised before comparison (`normalise` below) and nothing
 * else is: PostgreSQL renders a subquery across several lines with its own
 * indentation, which is a formatting detail of the version, whereas every
 * parenthesis, operator, column name and function name here is load-bearing.
 * A `true` disjunct or a dropped conjunct cannot survive normalisation.
 */
interface GoldenPolicy {
  readonly permissive: 'PERMISSIVE' | 'RESTRICTIVE';
  readonly cmd: string;
  readonly qual: string | null;
  readonly with_check: string | null;
}

const GOLDEN_POLICIES: ReadonlyMap<string, GoldenPolicy> = new Map([
  [
    'RlsProbe.RlsProbe_tenant_isolation',
    {
      permissive: 'PERMISSIVE',
      cmd: 'ALL',
      qual: '("organizationId" = app_current_org_id())',
      with_check: '("organizationId" = app_current_org_id())',
    },
  ],
  [
    'Organization.Organization_tenant_isolation',
    {
      permissive: 'PERMISSIVE',
      cmd: 'ALL',
      // Widened read: the organization in context, OR any the caller is a member
      // of. ADR-0040 decision 2.
      qual:
        '((id = app_current_org_id()) OR (EXISTS ( SELECT 1 FROM "OrganizationMember" m ' +
        'WHERE ((m."organizationId" = "Organization".id) AND (m."userId" = app_current_user_id())))))',
      // Narrow write, and `personalOwnerUserId` is constrained as well as `id`:
      // without the second clause a caller could consume a stranger's unique
      // personal-owner slot, or fabricate a PERSONAL organization owned by them.
      with_check:
        '((id = app_current_org_id()) AND (("personalOwnerUserId" IS NULL) ' +
        'OR ("personalOwnerUserId" = app_current_user_id())))',
    },
  ],
  [
    'OrganizationMember.OrganizationMember_tenant_isolation',
    {
      permissive: 'PERMISSIVE',
      cmd: 'ALL',
      qual: '(("organizationId" = app_current_org_id()) OR ("userId" = app_current_user_id()))',
      // BOTH columns. This table is the set the `User` policy reads THROUGH, so
      // an unconstrained `userId` here let any member enlarge their own `User`
      // read surface to any user id they could name.
      with_check:
        '(("organizationId" = app_current_org_id()) AND ("userId" = app_current_user_id()))',
    },
  ],
  [
    'OrganizationMember.OrganizationMember_delete_in_context',
    {
      // The only RESTRICTIVE policy in the tree, and the only construct that can
      // narrow an already-stated USING half without a DROP POLICY.
      permissive: 'RESTRICTIVE',
      cmd: 'DELETE',
      qual: '("organizationId" = app_current_org_id())',
      with_check: null,
    },
  ],
  [
    'User.User_tenant_isolation',
    {
      permissive: 'PERMISSIVE',
      cmd: 'ALL',
      qual:
        '((id = app_current_user_id()) OR (EXISTS ( SELECT 1 FROM "OrganizationMember" m ' +
        'WHERE ((m."userId" = "User".id) AND (m."organizationId" = app_current_org_id())))))',
      with_check: '(id = app_current_user_id())',
    },
  ],
  [
    'User.User_identity_bootstrap',
    {
      permissive: 'PERMISSIVE',
      // FOR SELECT, so `with_check` is NULL and that is correct rather than a
      // hole — see the `cmd`-keyed assertions.
      cmd: 'SELECT',
      qual:
        '(("authProvider" = app_current_auth_provider()) ' +
        'AND ("externalAuthId" = app_current_external_auth_id()))',
      with_check: null,
    },
  ],
]);

interface TableRow {
  readonly table_name: string;
  readonly relrowsecurity: boolean;
  readonly relforcerowsecurity: boolean;
}

interface PolicyRow {
  readonly table_name: string;
  readonly policy_name: string;
  readonly permissive: string;
  readonly roles: string;
  readonly cmd: string;
  readonly qual: string | null;
  readonly with_check: string | null;
}

let allTables: readonly TableRow[] = [];
let allPolicies: readonly PolicyRow[] = [];

/** The tables this gate holds to the standard — every public table bar the exemptions. */
function tenantScopedTables(): readonly TableRow[] {
  return allTables.filter((table) => !NOT_TENANT_SCOPED.has(table.table_name));
}

function referencesTenancyFunction(expression: string): boolean {
  return [...TENANCY_FUNCTIONS.keys()].some((name) => expression.includes(name));
}

/**
 * Collapses every run of whitespace to one space and trims. PostgreSQL renders a
 * policy expression containing a subquery across several lines with its own
 * indentation; that is a formatting choice of the server version, and everything
 * else in the string is not.
 */
function normalise(expression: string | null): string | null {
  return expression === null ? null : expression.replace(/\s+/g, ' ').trim();
}

/** `WITH CHECK (false)` reads back from the catalog as exactly `false`. */
function isLiteralFalse(expression: string): boolean {
  return expression.trim().toLowerCase() === 'false';
}

function describePolicy(policy: PolicyRow): string {
  return `${policy.table_name}.${policy.policy_name}`;
}

beforeAll(async () => {
  const loaded = await withDatabase(async (db) => ({
    // `relnamespace = 'public'::regnamespace` is not decoration. Two sibling
    // integration files CREATE TABLES AT RUNTIME in this same container, in
    // their own schemas (`metrika_adapter_probe.HealthCheck` and
    // `metrika_error_probe.UniquePair`), both granted to metrika_app — and
    // Vitest's file order is not deterministic, so whether they exist when this
    // gate runs is a coin flip. Without the schema filter this file would fail,
    // or not, depending on execution order.
    //
    // `relkind = 'r'` keeps this to ordinary tables: views, sequences, indexes
    // and composite types are not rows anybody can leak. A PARTITIONED table is
    // `'p'` and would be skipped — nothing in this repository is partitioned
    // today, and the day something is, `'p'` belongs in this filter and its
    // partitions do not (RLS is declared on the parent).
    tables: await db.$queryRaw<TableRow[]>`
      SELECT relname AS table_name, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
      ORDER BY relname
    `,
    // `array_to_string(roles, ',')` rather than the raw `name[]`: the assertion
    // only needs to know which roles are named, and a text round-trip keeps this
    // independent of how the driver adapter maps Postgres array types.
    policies: await db.$queryRaw<PolicyRow[]>`
      SELECT
        tablename AS table_name,
        policyname AS policy_name,
        permissive,
        array_to_string(roles, ',') AS roles,
        cmd,
        qual,
        with_check
      FROM pg_policies
      WHERE schemaname = 'public'
      ORDER BY tablename, policyname
    `,
  }));

  allTables = loaded.tables;
  allPolicies = loaded.policies;

  // THE VACUITY GUARD, and it is deliberately a throw from `beforeAll` rather
  // than an assertion in one test: every assertion below is a loop over one of
  // these two arrays, and an empty array makes every loop trivially true. A
  // broken query, a renamed catalog column or a connection that lands in the
  // wrong database would otherwise make this whole file report success while
  // asserting nothing at all — which, for a gate whose only job is to police
  // migrations nobody has written yet, is worse than a red run. Failing here
  // fails every test in the file.
  if (loaded.tables.length === 0 || loaded.policies.length === 0) {
    throw new Error(
      `The RLS coverage gate read ${String(loaded.tables.length)} tables and ` +
        `${String(loaded.policies.length)} policies from schema public. Both must be non-zero: ` +
        'an empty result set makes every assertion in this file vacuously true. Treat this as a ' +
        'broken catalog query or a database with no migrations applied, not as a passing gate.',
    );
  }
});

afterAll(async () => {
  await stopDatabase();
});

describe('the applied surface, enumerated rather than named', () => {
  it('sees the tables and policies it is about to iterate', () => {
    // Restated as a test as well as enforced in `beforeAll`, so the counts are
    // visible in the report rather than only in a failure message. The
    // exemptions are subtracted here, because a run in which EVERY public table
    // was exempt would satisfy the guard above and still police nothing.
    expect(allTables.length).toBeGreaterThan(0);
    expect(allPolicies.length).toBeGreaterThan(0);
    expect(tenantScopedTables().length).toBeGreaterThan(0);
  });

  it('has row-level security ENABLED and FORCED on every table that is not exempted with a reason', () => {
    const tables = tenantScopedTables();
    expect(tables.length).toBeGreaterThan(0);

    // `FORCE` as well as `ENABLE`, because `ENABLE` alone exempts the table
    // OWNER — the role `prisma migrate` runs as, and the role a local psql
    // session connects as — so without it a policy is invisible to exactly the
    // connection a developer uses to convince themselves RLS works.
    const offenders = tables
      .filter((table) => !table.relrowsecurity || !table.relforcerowsecurity)
      .map((table) => ({
        table: table.table_name,
        relrowsecurity: table.relrowsecurity,
        relforcerowsecurity: table.relforcerowsecurity,
      }));

    expect(offenders).toEqual([]);
  });

  it('has at least one policy on every table that is not exempted with a reason', () => {
    const tables = tenantScopedTables();
    expect(tables.length).toBeGreaterThan(0);

    // Enabling RLS with no policy denies everything, which is safe and also
    // indistinguishable from a table nobody finished. Both are failures here.
    const withPolicies = new Set(allPolicies.map((policy) => policy.table_name));
    const offenders = tables
      .map((table) => table.table_name)
      .filter((table) => !withPolicies.has(table));

    expect(offenders).toEqual([]);
  });

  it('has no exemption for a table that no longer exists', () => {
    // A staleness guard, not one of the five coverage assertions. An exemption
    // whose table has been renamed or dropped is a sentence that no longer
    // defends anything, and the day a NEW table takes the old name it inherits
    // the exemption silently.
    const existing = new Set(allTables.map((table) => table.table_name));
    const stale = [...NOT_TENANT_SCOPED.keys()].filter((table) => !existing.has(table));

    expect(stale).toEqual([]);
  });
});

describe('every applied policy, held to the shape the tenancy design declares', () => {
  it('has a non-null with_check on every policy whose cmd admits a new row', () => {
    // KEYED ON `cmd`, NOT ASSERTED EVERYWHERE, and that is a decision rather
    // than a shortcut. `pg_policies.with_check` is NULL BY DEFINITION for a
    // `FOR SELECT` policy — it has no write half to constrain — so
    // `User_identity_bootstrap` would fail a blanket non-null assertion for
    // being exactly right. `cmd` is the property that actually distinguishes
    // "cannot write" from "writes unchecked".
    const writers = allPolicies.filter((policy) => WRITE_ADMITTING_COMMANDS.has(policy.cmd));
    expect(writers.length).toBeGreaterThan(0);

    const offenders = writers
      .filter((policy) => policy.with_check === null)
      .map((policy) => `${describePolicy(policy)} (cmd ${policy.cmd})`);

    expect(offenders).toEqual([]);
  });

  it('builds every non-null with_check out of a declared tenancy function, or out of the literal false', () => {
    const checks = allPolicies.filter((policy) => policy.with_check !== null);
    expect(checks.length).toBeGreaterThan(0);

    // ADMITTING A LITERAL `false` IS ALSO A DECISION. `PlatformRoleAssignment`
    // (Plan 1D) is keyed on `userId` and must NOT be self-writable through the
    // app role at all; its correct write predicate is `WITH CHECK (false)`,
    // which is non-null and references no tenancy function. Without this clause
    // the gate would force 1D to choose between a wrong policy and an exemption
    // entry, under time pressure, on the slice whose whole subject is the audit
    // trail.
    const offenders = checks
      .filter((policy) => {
        const expression = policy.with_check ?? '';
        return !referencesTenancyFunction(expression) && !isLiteralFalse(expression);
      })
      .map((policy) => `${describePolicy(policy)} → ${policy.with_check ?? ''}`);

    expect(offenders).toEqual([]);
  });

  it('has a non-null qual on every policy that filters existing rows, built out of a declared tenancy function', () => {
    // KEYED ON `cmd` FOR THE SAME REASON THE `with_check` ASSERTION ABOVE IS.
    // `qual` is NULL by definition for a `FOR INSERT` policy — see
    // `READ_FILTERING_COMMANDS` — so asserting it everywhere would reject a
    // correct insert-only policy, and the cheapest way out of that for its
    // author is to widen the policy to `FOR ALL`.
    const readers = allPolicies.filter((policy) => READ_FILTERING_COMMANDS.has(policy.cmd));
    expect(readers.length).toBeGreaterThan(0);

    // Without this a table could ship one `FOR SELECT USING (true)` beside one
    // correct write policy and pass everything above.
    // `migration-sql.test.ts`'s `USING` check cannot cover it: that is a
    // whole-history substring check already satisfied forever by the init
    // migration.
    //
    // Note also what CANNOT generalise from `rls.integration.test.ts`: its
    // `with_check === qual` assertion. `Organization`'s and
    // `OrganizationMember`'s policies are deliberately asymmetric — the read
    // half is widened and the write half is not — so equality is now the wrong
    // assertion, and "non-null where rows are filtered, and built only out of
    // declared tenancy functions" is the right one.
    const offenders = readers
      .filter((policy) => policy.qual === null || !referencesTenancyFunction(policy.qual))
      .map((policy) => `${describePolicy(policy)} (cmd ${policy.cmd}) → ${policy.qual ?? 'NULL'}`);

    expect(offenders).toEqual([]);
  });

  it('gives every tenant-scoped table at least one PERMISSIVE policy that applies to the application role', () => {
    const tables = tenantScopedTables();
    expect(tables.length).toBeGreaterThan(0);

    // ADR-0040 consequence 9: `permissive` and `roles` are the two columns a
    // coverage gate can pass while proving nothing. A RESTRICTIVE policy ANDs
    // with the permissive set rather than ORing into it, so a table whose ONLY
    // policy is restrictive denies everything while satisfying every `qual` and
    // `with_check` assertion above.
    //
    // ASSERTED PER TABLE, NOT PER POLICY, and the difference is the whole point.
    // An earlier version of this assertion collected an offender whenever
    // `permissive !== 'PERMISSIVE'` for ANY policy — which banned `AS
    // RESTRICTIVE` outright, and `AS RESTRICTIVE` is the only construct that can
    // narrow an already-shipped `USING` half without a `DROP POLICY`. It is what
    // `OrganizationMember_delete_in_context` is, and ADR-0040 names the same
    // construct as the deferred fix for the widened `DELETE` on the other two
    // tables. So the gate would have forbidden its own remedy. A restrictive
    // policy can only ever narrow a result set; it can grant nothing, which is
    // why its presence is not the thing worth policing.
    const offenders = tables
      .filter(
        (table) =>
          !allPolicies.some(
            (policy) =>
              policy.table_name === table.table_name && policy.permissive === 'PERMISSIVE',
          ),
      )
      .map((table) => table.table_name);

    expect(offenders).toEqual([]);
  });

  it('scopes no policy away from the application role', () => {
    expect(allPolicies.length).toBeGreaterThan(0);

    // The other half of consequence 9, and this one IS per policy: a policy
    // scoped `TO some_other_role` never applies to `metrika_app` at all, so it
    // satisfies every predicate assertion above while constraining nothing.
    // Measured expected value for all six applied policies: `roles = {public}`.
    const offenders = allPolicies
      .filter((policy) => {
        const roles = policy.roles.split(',').map((role) => role.trim());
        return !roles.includes('public') && !roles.includes('metrika_app');
      })
      .map((policy) => `${describePolicy(policy)} → ${policy.permissive} TO ${policy.roles}`);

    expect(offenders).toEqual([]);
  });
});

describe('the applied predicates, pinned rather than pattern-matched', () => {
  it('matches the golden set exactly, in both directions', () => {
    // THE ASSERTION THAT CLOSES THE SUBSTRING BLIND SPOT. Everything above tests
    // the SHAPE of a policy; this tests its CONTENT. Both are wanted: the shape
    // assertions catch an omission on a table nobody has written yet, and this
    // one catches a predicate that is the wrong predicate — including the
    // measured case of a policy that mentions a tenancy function inside an
    // expression that constrains nothing.
    //
    // Equality in BOTH directions, so all three mutations are red: an altered
    // predicate (value differs), a new undeclared policy (extra key) and a
    // deleted policy (missing key). A future author adding a table adds an entry
    // here, and that entry is the review.
    const applied = new Map(
      allPolicies.map((policy) => [
        describePolicy(policy),
        {
          permissive: policy.permissive,
          cmd: policy.cmd,
          qual: normalise(policy.qual),
          with_check: normalise(policy.with_check),
        },
      ]),
    );

    const expected = new Map(
      [...GOLDEN_POLICIES].map(([name, golden]) => [
        name,
        {
          permissive: golden.permissive,
          cmd: golden.cmd,
          qual: normalise(golden.qual),
          with_check: normalise(golden.with_check),
        },
      ]),
    );

    // Sorted object comparison rather than two set-difference assertions, so a
    // failure prints the offending predicate beside the expected one instead of
    // only naming the policy.
    expect(Object.fromEntries([...applied].sort())).toEqual(
      Object.fromEntries([...expected].sort()),
    );
  });

  it('finds the behavioural suite that stands behind these predicates still present', () => {
    // MEASURED, and the reason this assertion exists: deleting
    // `identity-rls.integration.test.ts` outright — all fifteen assertions, the
    // only thing in this repository that measures the tenant boundary
    // BEHAVIOURALLY — left both gates green. `pnpm test:integration` exited 0
    // and so did `pnpm test:unit`. Nothing pins a test file's existence, no
    // coverage floor covers this package, and neither CI suppression grep looks
    // at test inventory.
    //
    // Deliberately existence-and-size only, not a count of `describe` blocks or
    // a list of case names: those rot on the first legitimate refactor, and a
    // rotting assertion gets deleted. The golden map above is the real defence —
    // with it, removing the behavioural suite no longer removes ALL of the
    // boundary's coverage at once — and this is the cheap backstop for the file
    // itself. `migration-sql.test.ts` reads files from this package in the same
    // way.
    const behavioural = path.resolve(import.meta.dirname, 'identity-rls.integration.test.ts');
    const source = readFileSync(behavioural, 'utf8');

    expect(source.length).toBeGreaterThan(8_000);
  });
});
