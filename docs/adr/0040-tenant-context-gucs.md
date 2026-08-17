# ADR-0040 — tenancy needs three GUC primitives, not one, because the read that finds the user runs before either tenant is known

**Status:** Accepted · **Date:** 2026-08-17 · **Scopes part of**
[ADR-0013](./0013-authorization.md). Decisions 1 and 3 of that ADR are unchanged
— policy functions still take the loaded resource, and RLS is still the backstop
rather than the primary control. What this one narrows is decision 2,
"`AuthContext` in every repository signature": there are **exactly two** methods
that run before an `AuthContext` can exist, both named by symbol in decision 7,
and the list does not grow without a new ADR.

> **Every claim below is labelled MEASURED, INHERITED or INFERENCE.** MEASURED
> means run against this tree during Plan 1A Task 3, on PostgreSQL 16.15 and
> Prisma 7.9.1. INHERITED means taken from an earlier ADR or from Postgres's own
> documented behaviour. INFERENCE means reasoned from those and not observed.

## Context

The init migration established one predicate shape and one primitive:
`USING ("organizationId" = app_current_org_id())`, with the GUC set per
transaction. Two of Phase 1A's three tables cannot be written that way, and the
third read cannot be written with any tenant primitive at all.

`Organization` has no `organizationId` — its predicate is on `id`. `User` has no
organization, because a person belongs to many, and `/me` has to answer "which
organizations am I in", which a single-organization GUC cannot express.

**And one read has neither tenant available, which is the finding that shaped the
whole migration.** The `externalAuthId → User` lookup runs on every single
request: the API holds only the verified provider `sub` and must find `User` by
`(authProvider, externalAuthId)` in order to learn `User.id`. At that moment
`app.current_user_id` is unknown **by definition** — it is what the lookup
computes — and `app.current_org_id` is unknown too, because which organization
the caller is acting in is read from a membership row that has not been found
yet. `metrika_app` is `NOBYPASSRLS` (`packages/database/sql/00-app-role.sql:29`),
an unset GUC is NULL, and NULL never equals anything. So a `User` policy keyed
only on those two returns **zero rows on every sign-in after the first**, sends
every returning user down the provisioning path, and violates
`User_authProvider_externalAuthId_key`. The elevated client that would otherwise
answer it is deferred to Plan 1D on purpose, with its audit wrapper.

That is a product where nobody can sign in twice, produced by a policy that
looks correct and by a suite that only ever tested a first sign-in.

### What was measured before choosing

- **The pre-identity read denies everything, and each half denies on its own.**
  As `metrika_app` (`rolsuper` `f`, `rolbypassrls` `f`, asserted in the same
  session): with both bootstrap GUCs set to a real identity, `SELECT` on `"User"`
  returns exactly **1** row; with only `app.current_external_auth_id` set, **0**;
  with the provider right and the external id wrong, **0**; with nothing set,
  **0** rows on all three tables. MEASURED.
- **A cycle raises `42P17`, and the shipped policies do not close one.** Six read
  cases and seven write cases across all three tables, none of which raised
  `infinite recursion detected in policy for relation`. The absence is only
  meaningful with a positive control, so one was run: a temporary
  `FOR SELECT` policy on `OrganizationMember` reading `"User"` was created — and
  **`CREATE POLICY` succeeded**, because Postgres does not detect the cycle at DDL
  time. `SELECT count(*) FROM "User"` then failed with
  `ERROR: infinite recursion detected in policy for relation "User"`, and the same
  query on `"Organization"` failed naming `"OrganizationMember"` — the relation the
  cycle is detected in, not the one the query started from. The control policy was
  then removed. MEASURED.
- **`@default(uuid(7))` is accepted, and mints a real v7.** `pnpm db:generate` and
  `pnpm db:migrate --create-only` both exit 0 with it on all three models, and a
  round-trip through the generated client produced
  `01a01033-3a6e-7380-86a7-a2da4f63fc30` — version nibble `7`, variant nibble `8`
  — with two consecutive ids sorting in creation order. MEASURED. What it buys in
  1A is **nothing at runtime**: see the `WITH CHECK` section below, and note that
  this measurement had to be taken through the OWNER connection, because the app
  role cannot insert a row whose id it generated client-side.
- **The emitted `id` column carries no database `DEFAULT`.** `"id" UUID NOT NULL`
  on all three tables, while `createdAt` and `joinedAt` do carry
  `DEFAULT CURRENT_TIMESTAMP` — so the emitter writes defaults when there is one,
  and `uuid(7)` is not one. `"updatedAt" TIMESTAMPTZ(3) NOT NULL` also carries no
  default, because Prisma implements `@updatedAt` client-side and emits no
  trigger. MEASURED.
- **The applied catalog.** All three new tables read `relrowsecurity = t` and
  `relforcerowsecurity = t`, owned by `metrika` and not `metrika_app`, whose grants
  on them are exactly `arwd` — no `TRUNCATE`, which would bypass RLS entirely — and
  whose privilege on schema `public` is `USAGE` only, so the unqualified
  `app_current_*()` calls in the policies cannot be shadowed by a function the app
  role creates. Six policies exist in schema `public`, all with
  `roles = {public}`; five are `PERMISSIVE` and
  `OrganizationMember_delete_in_context` is `RESTRICTIVE`. `HealthCheck` and
  `_prisma_migrations` are the only public tables with RLS off. MEASURED.
- **Three writes that the first pass of these predicates permitted, found by
  attacking them as `metrika_app` rather than by reading them.** All three have
  the same shape — a `WITH CHECK` that constrains the tenant COLUMN and leaves the
  rest of the row free — and all three are closed by the predicates recorded in
  decision 2. MEASURED, before the fix, as `metrika_app` (`rolsuper` `f`,
  `rolbypassrls` `f`, asserted in-session) scoped to ORG_A as USER_A:

  1. **A stranger's whole `User` row, through a membership row the caller wrote.**
     `SELECT … FROM "User" WHERE id = <stranger>` → **0 rows**;
     `INSERT INTO "OrganizationMember" (<ORG_A>, <stranger>, 'OWNER')` →
     `INSERT 0 1`; the same `SELECT` → the stranger's `id`, `email`,
     `displayName`, `authProvider` **and** `externalAuthId`. The same escalation
     through `UPDATE "OrganizationMember" SET "userId" = <stranger>` → `UPDATE 1`.
  2. **Membership rows in other organizations, deleted.**
     `DELETE FROM "OrganizationMember" WHERE "organizationId" = <ORG_B>` →
     `DELETE 1`; a bare `DELETE FROM "OrganizationMember"` with no `WHERE` →
     `DELETE 4`, spanning **three** organizations.
  3. **A personal organization fabricated for a stranger.**
     `UPDATE "Organization" SET "personalOwnerUserId" = <stranger>` → `UPDATE 1`,
     consuming that stranger's `Organization_personalOwnerUserId_key` slot
     permanently; and with the organization GUC set to a fresh uuid, an `INSERT`
     of `kind = 'PERSONAL'` owned by the stranger → `INSERT 0 1`, followed by a
     membership row making the attacker its only `OWNER`.

  Re-measured after the fix, same role, same fixture: rejections 1 and 3 both
  answer `new row violates row-level security policy`, the cross-organization
  `DELETE` answers `DELETE 0`, the bare `DELETE` answers `DELETE 2` (this
  organization's rows only), and the four positive controls — a self-membership
  write, the caller's own `personalOwnerUserId`, clearing it to NULL, and the
  widened reads — all still succeed.

- **`@db.Char(2)` and a plain unique index are each half of what a comment
  claimed.** `countryCode = 'c'` was accepted and read back at `length() = 1`,
  blank-padded; `Probe-A@example.test` inserted alongside `probe-a@example.test`
  as a second row. Both MEASURED, and both are now CHECK constraints
  (decision 8).

- **A `FOR INSERT` policy reads back with a NULL `qual`.** MEASURED on a throwaway
  table: `CREATE POLICY … FOR INSERT WITH CHECK (…)` gives `cmd = INSERT`,
  `qual IS NULL`, `with_check` non-null — PostgreSQL does not permit `USING` on
  `INSERT`. So the coverage gate keys its `qual` assertion on `cmd` for the same
  reason it keys its `with_check` assertion on `cmd`; consequence 9 records both.

- **A unique violation aborts the transaction.** In one transaction as
  `metrika_app`: insert a `User`; insert a second whose
  `(authProvider, externalAuthId)` collides →
  `duplicate key value violates unique constraint
"User_authProvider_externalAuthId_key"`; then ANY statement →
  `current transaction is aborted, commands ignored until end of transaction
block` (`25P02`). MEASURED, and it is the property Plan 1A Task 6 Step 3's retry
  boundary rests on.

- **The next `migrate dev` proposes reverting none of the hand-written block.**
  With the migration applied and the schema formatted,
  `pnpm db:migrate --create-only` emits `-- This is an empty migration.` — 30
  bytes. Prisma does not diff CHECK constraints, RLS policies or SQL functions, so
  the block is invisible to future authoring rather than fought with. MEASURED,
  and it is the reason sub-decision (c) below is argued on the one construct
  Prisma DOES manage rather than on hand-written SQL in general.

## Decision

**1. Three tenancy primitives, each a GUC read through a `STABLE` SQL function
that returns NULL when the setting is absent.** The `true` second argument to
`current_setting` is what makes a missing setting return NULL rather than raise,
and `NULLIF(…, '')` collapses the empty string onto NULL as well — so an unset
_or_ blanked context denies every row instead of erroring. Deny-by-default is a
property of the primitive, not of any policy written against it. All three are
created in
`packages/database/prisma/migrations/20260817144359_identity_and_tenancy/migration.sql`
and held by `packages/database/test/identity-rls.integration.test.ts`.

| Primitive                                                    | Function                                                        | Returns | Scopes to                                         | Set by                                               |
| ------------------------------------------------------------ | --------------------------------------------------------------- | ------- | ------------------------------------------------- | ---------------------------------------------------- |
| `app.current_org_id`                                         | `app_current_org_id()` (init migration)                         | `uuid`  | the active organization                           | the tenant context helper, per transaction           |
| `app.current_user_id`                                        | `app_current_user_id()`                                         | `uuid`  | the authenticated user, across every organization | the same helper, in the same transaction             |
| `app.current_auth_provider` + `app.current_external_auth_id` | `app_current_auth_provider()`, `app_current_external_auth_id()` | `text`  | one external identity, before any tenant is known | the identity-bootstrap entry point, and nothing else |

The third is a **pair** and counts as one primitive because its policy ANDs both
halves: a caller who sets only one matches no row (MEASURED above). Its two
functions return `text` rather than an enum type, and that is mechanical rather
than stylistic — see decision 5.

**2. Five policies over three tables: two asymmetric, one read-only, one
restrictive.** `USING` filters what a statement can SEE; `WITH CHECK` constrains
what it can WRITE. Where the two differ, the read half is the widened one.

| Table                | Policy                                 | Kind          | `cmd`    | `USING`                                                                                                | `WITH CHECK`                                                                                         |
| -------------------- | -------------------------------------- | ------------- | -------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `Organization`       | `Organization_tenant_isolation`        | `PERMISSIVE`  | `ALL`    | `id = app_current_org_id()` **OR** the caller is a member of it                                        | `id = app_current_org_id()` **AND** (`personalOwnerUserId` **IS NULL OR** `= app_current_user_id()`) |
| `OrganizationMember` | `OrganizationMember_tenant_isolation`  | `PERMISSIVE`  | `ALL`    | `organizationId = app_current_org_id()` **OR** `userId = app_current_user_id()`                        | `organizationId = app_current_org_id()` **AND** `userId = app_current_user_id()`                     |
| `OrganizationMember` | `OrganizationMember_delete_in_context` | `RESTRICTIVE` | `DELETE` | `organizationId = app_current_org_id()`                                                                | none — a `FOR DELETE` policy has no write half                                                       |
| `User`               | `User_tenant_isolation`                | `PERMISSIVE`  | `ALL`    | `id = app_current_user_id()` **OR** they are a member of the organization in context                   | `id = app_current_user_id()`                                                                         |
| `User`               | `User_identity_bootstrap`              | `PERMISSIVE`  | `SELECT` | `authProvider = app_current_auth_provider()` **AND** `externalAuthId = app_current_external_auth_id()` | none — a `FOR SELECT` policy has no write half                                                       |

The two widenings exist for one screen each. `OrganizationMember`'s read half is
what lets `/me` list a caller's memberships across every organization without an
elevated client. `Organization`'s read half follows from it: `MembershipSummary`
renders names and slugs rather than ids, so a caller scoped to org A who can see
their membership row for org B but cannot read org B's `Organization` row has a
switcher with a blank entry in it.

Neither write half is widened, and the measurements say what that buys: with org
B in context and the caller a member of org A, `UPDATE` on org A's row —
**visible** through the widened read — is rejected with `new row violates
row-level security policy for table "Organization"`, as is an
`OrganizationMember` stamped with a third organization's id, as is an `UPDATE` of
a co-member's `User` row. MEASURED.

**Each write half constrains every column that another predicate reads, not only
the tenant key**, and the two extra conjuncts are the whole of what the first pass
got wrong (see the three measured writes above). `OrganizationMember.userId` is
read by `User_tenant_isolation`'s subquery, so leaving it free let a caller
enlarge their own read surface; `Organization.personalOwnerUserId` carries a
GLOBAL unique index and binds a tenant to a person, so leaving it free let a
caller claim a stranger's slot. **The rule to carry into 1B-1D: a `WITH CHECK`
must constrain the tenant key AND every column any policy predicate reads.** A
predicate is only as narrow as the narrowest thing it depends on.

**The restrictive policy is a fifth policy and a construct nothing else in the
tree uses, and it is here because `DELETE` has no `WITH CHECK` half at all.**
Restrictive policies AND with the permissive set rather than ORing into it, so
they can only narrow; it is also the only way to take back part of an
already-stated `USING` half without a `DROP POLICY`, which the migration history
grep forbids. It is scoped to the organization in context rather than to `false`
because the boundary this migration owns is the TENANT one: whether a MEMBER may
remove a co-member from an organization they are both in is an authorization
question with a role in it, which RLS cannot express here (see decision 3's
recursion note) and which the application policies own.

**What the narrowed `OrganizationMember` write half costs, stated because it will
be met as a surprise otherwise.** `WITH CHECK` is evaluated against the whole new
row, so requiring `userId = app_current_user_id()` makes RLS admit
**self-membership writes only**: an ADMIN cannot add another person, and cannot
change a co-member's `role`, through the app role. An invitation ACCEPTED by its
recipient satisfies the predicate as written, which is why 1A and an accept-based
1C flow are unaffected. Plan 1C owns the choice between widening this conjunct and
routing administrative membership writes through Plan 1D's audited elevated
client. It is deliberately the narrow direction: widening a shipped predicate is
an `ALTER POLICY`, narrowing one is a data migration.
`packages/database/test/identity-rls.integration.test.ts` case 4 asserts the cost
as well as the protection, so a 1C author meets a test that expected it rather
than concluding the policy is broken.

**3. The widening is bounded by the policy it reads through — and that sentence
is worth nothing on its own, because the bound is a table the app role WRITES.**
Both subquery policies read `OrganizationMember`, and a policy expression that
reads an RLS-protected table has that table's policies applied to it. `EXPLAIN` on
`SELECT * FROM "User"` shows the `SubPlan` over `OrganizationMember` carrying
`OrganizationMember`'s own predicate (MEASURED). **The first pass of this ADR
stopped there and concluded that the widening "cannot outgrow that policy", which
was false**: the `SubPlan` predicate is real, but it bounds the widening to rows
the caller can insert, and that policy's `WITH CHECK` did not constrain `userId`.
Measured consequence: a stranger's whole `User` row, `externalAuthId` included
(see the measurements above). The claim is true only with the conjunct decision 2
now records — with writes narrowed to the caller's own `userId`, the only way to
enlarge this widening is to add YOURSELF to an organization, which reveals that
organization's members and nobody else's.

**The residual risk therefore lives in the VALUE of `app.current_org_id`, and
consequence 10 records what closes it.** Nothing in any predicate anchors that GUC
to a membership row.

It also means the widened `Organization` read is **dead with the
organization GUC alone**: with org B set and the user GUC unset,
`SELECT` on `"Organization"` returns only org B, because the subquery row is
visible only through `userId = app_current_user_id()` (MEASURED — and it is the
shape a test can pass while measuring nothing). The moment Plan 1C adds a policy
on `OrganizationMember` that reads `"User"` **or `"Organization"`**, there is a
cycle, and Postgres reports it at query time rather than at `CREATE POLICY` time.

**4. `Organization_personal_owner_required`, because a unique index on a nullable
column is half an invariant.** `Organization_personalOwnerUserId_key` makes a
user hold at most one personal organization only if the column is populated;
Postgres treats NULLs as distinct, and nothing ties the column to `kind`. The
CHECK is `kind <> 'PERSONAL' OR personalOwnerUserId IS NOT NULL` — one-directional
on purpose, so that Plan 1C converting a personal organization into a team is an
`UPDATE` rather than a constraint fight. Held by
`identity-rls.integration.test.ts`; MEASURED as `new row for relation
"Organization" violates check constraint "Organization_personal_owner_required"`.

**What that one-directionality costs, recorded rather than left implicit: "every
user has a personal organization" is a PRODUCT invariant, not a database one.**
The two-step evasion is permitted by construction — MEASURED as `metrika_app` with
the organization GUC on the target row: `UPDATE … SET "kind" = 'TEAM'` →
`UPDATE 1`, then `UPDATE … SET "personalOwnerUserId" = NULL` → `UPDATE 1`, leaving
the row `TEAM`/NULL and the user with zero personal organizations. Nothing
requires a `User` to be referenced by any `Organization` in the first place
either. So the claim in `docs/DOMAIN_MODEL.md` that this "removes 'a resource with
no organization' as a branch from every policy and every query" holds for the
policies (none of them carries such a branch) and **does not** license a reader of
`User.personalOrganization` to treat absence as impossible: treat it as a real
branch. Enforcing it properly needs a deferred constraint trigger, which cannot be
specified until 1C settles conversion semantics.

**5. `User.authProvider` is `text`, not a Postgres enum, and the reason is a
failure mode rather than a preference.** `app_current_auth_provider()` returns
`text` and `User_identity_bootstrap` compares the column against it directly.
Against an enum type that comparison has no operator, so it would need a cast:
`"authProvider"::text = …` puts a cast on a column in the hot path of every
request, and `… = app_current_auth_provider()::"AuthProvider"` **raises 22P02**
for any GUC value outside the type — converting deny-by-default into a 500 on the
most-travelled read in the product. There is also no `AuthProvider` vocabulary in
`packages/contracts` to copy members from. INFERENCE on the cast behaviour,
INHERITED on the enum-input error.

**6. `OrganizationMember` carries an index on `userId` alone, and it is
load-bearing.** The composite unique indexes `(organizationId, userId)` and so
serves the `User` policy's organization-leading subquery; the `Organization`
policy's subquery is user-leading and had no index without one. `EXPLAIN` shows
each policy using its own: `OrganizationMember_organizationId_userId_key` for the
`User` policy, `OrganizationMember_userId_idx` for the `Organization` policy.
MEASURED.

**7. There are EXACTLY TWO declared exceptions to ADR-0013 decision 2, and to
`docs/ROADMAP.md:275`'s "`AuthContext` required on every repository method", and
both are named here by symbol.** Both documents are named because both say it.

| Method                                 | Task | Why it cannot take an `AuthContext`                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `findByExternalAuthId(identity)`       | 5    | It runs **before** an `AuthContext` can exist. An `AuthContext` carries `userId` and the caller's roles, read from our database; this method is what finds the row those are read from. Requiring the parameter would not make it safer, it would make it unwritable.                                                                                        |
| `provisionIdentity(identity, profile)` | 6    | It **creates** the rows an `AuthContext` would be derived from. The `WITH CHECK` predicates in decision 2 force it to mint the `User` and `Organization` ids and set both tenancy GUCs from them **before** either row exists, so the context it runs under is minted rather than derived — there is nothing for an `AuthContext` parameter to have carried. |

The list is exactly two and does not grow without a new ADR. The guard 1A can
afford is a type-level test asserting the `auth`-first shape over the repository
interface, plus the review surface of a two-name list.

Each exception is narrow in three ways at once, and it is the combination rather
than any one of them that makes it acceptable:

- **Neither can be written with the parameter**, for the reasons in the table.
- **Each runs under a predicate narrower than any `AuthContext` would make it.**
  `findByExternalAuthId` sets the bootstrap pair, which restricts it to the single
  `User` row whose external identifier the token verifier already proved by
  signature — an `AuthContext`-scoped read of `User` would admit every co-member in
  the organization in context. `provisionIdentity` runs with
  `app.current_user_id` and `app.current_org_id` equal to the two ids it is
  creating, which is the narrowest context that exists: exactly one row per table.
- **The read-only one cannot write.** MEASURED: an `INSERT` into `"User"` in
  bootstrap context is rejected, because `User_identity_bootstrap` has no write
  half and `User_tenant_isolation`'s `WITH CHECK` compares against an unset
  `app.current_user_id`.

The exception is to the **signature**, not to the backstop. Neither method
bypasses RLS; both run under a narrower predicate than the general one, not
outside it. Plan 1A Task 4 owns both entry points and their typed context setters,
and they are the only places either bootstrap GUC may be set.

**8. Two format CHECK constraints, because a column type was carrying a
guarantee it does not make.** Both were added after the measurements above
falsified a schema comment, and both are constraints rather than conventions for
the reason CLAUDE.md gives: a constraint is a guarantee and a check is a hope.

- **`User_email_lowercase` — `CHECK ("email" = lower("email"))`.** `User_email_key`
  is a plain unique index and Postgres has no case-insensitive text type without
  `citext`, so `Probe-A@example.test` and `probe-a@example.test` were two rows
  (MEASURED). "One email, one user" was an application convention wearing a
  constraint's name. Plan 1A Task 6 still owns the normalisation; this makes
  forgetting it a refused write rather than a second account for the same person.
  Deliberately **not** a functional or partial unique index on `lower("email")`: an
  index is the one construct in this block that Prisma manages, and sub-decision
  (c) defers that class of change until its drift behaviour has been measured. A
  CHECK is invisible to Prisma's differ (MEASURED).
- **`Organization_country_code_format` — `CHECK ("countryCode" ~ '^[A-Z]{2}$')`.**
  `@db.Char(2)` is a MAXIMUM width and nothing more: `'c'` was accepted and stored
  blank-padded at `length() = 1` (MEASURED). The MEMBER set remains an
  API-boundary check — there is still no ISO-3166 vocabulary in
  `packages/contracts` and 1A does not create one — but every alpha-2 code
  satisfies this format by definition, and every lowercased, truncated or
  blank-padded value does not. See consequence 8.

## `WITH CHECK` means a row's identifier exists before the row does

This is the most surprising property of the design and the one most likely to be
rediscovered as a bug, so it is written here rather than only in the plan.

`WITH CHECK ("id" = app_current_user_id())` says a `User` may be inserted only
when `app.current_user_id` **already equals the id being inserted** — and the
same for `Organization` and `app.current_org_id`. Since the emitted column has no
database `DEFAULT` (MEASURED) and Prisma generates the value client-side, the
order of operations is inverted from the obvious one: provisioning **mints both
UUIDs first**, sets both GUCs from them, and passes `id` explicitly in `data`.
There is no arrangement in which the database assigns the id and the policy
passes.

Two consequences follow, and both are load-bearing for Plan 1A Tasks 4 and 6:

- **`withOrganizationContext` cannot express it.** It sets exactly one GUC, and
  the provisioning transaction needs `app.current_org_id` and
  `app.current_user_id` set together. Task 4's `withTenantContext` and
  `newUuidV7()` exist for this; in 1A the only other setter is a test-local
  `set_config(…, true)` through a tagged-template `$executeRaw`.
- **`@default(uuid(7))` is therefore unexercised by anything this slice writes.**
  It is declared for rows created outside provisioning, from Plan 1B onward. It
  was verified anyway because choosing v4 now and v7 later is a data migration
  across every foreign key — but a `uuid(7)` round-trip assertion must not be
  allowed to stand in for Task 4's `newUuidV7()` test, which is the one that
  matters here.

The measurement above demonstrates the property by accident: minting a v7 through
the client required the **owner's** connection, because the app role cannot insert
a row whose id it generated after the GUC was set.

## Three sub-decisions the plan left open

**(a) `CurrencyCode` becomes a Postgres enum; `Money.currency` does not.** The
asymmetry is the decision, not an oversight. `Organization.defaultCurrency` is a
mutable default on an Identity entity, read to decide what a **new** quote is
denominated in, so constraining it to today's vocabulary is exactly right — the
same authority `apps/api` applies at the request boundary when it checks a
supplied `exponent` against `CURRENCY_REGISTRY`. `Money.currency` is the opposite
kind of value: a persisted historical fact that must stay parseable after the
vocabulary changes, which is why `docs/DOMAIN_MODEL.md:491` gives it
`String @db.Char(3)` and why `Money` deliberately does not cross-check `exponent`
against the registry. **A future migration must not move `Money.currency` onto
this type**; the schema comment on the enum says so.

The cost, priced rather than waved past: adding a currency is
`ALTER TYPE "CurrencyCode" ADD VALUE`, and a value added inside a transaction
block cannot be used until that transaction commits (INHERITED, PostgreSQL 12+).
Prisma wraps each migration in a transaction, so "add the currency and backfill
rows with it" is two migrations, not one. Removing a value is a full
expand/contract. Both are accepted: the vocabulary has changed zero times in this
repository's life, and a wrong `defaultCurrency` prices a quote in the wrong
currency.

The Prisma enum member **order** is copied from
`packages/contracts/src/money.ts:3` and `organization.ts:44,55`, not sorted. Those
three Zod enums are in `EMITTED`, so their order is the generated pydantic
`StrEnum` order that CI byte-diffs ([ADR-0039](./0039-contracts-typescript-only-exports.md)),
and keeping one order everywhere is what makes the two reviewable against each
other. **Member equality between each Prisma enum and its Zod counterpart is
asserted by a Docker-free unit test in this same task** —
`packages/database/test/prisma-enum-parity.test.ts`, one assertion per enum, so a
member added on one side and not the other is a red gate rather than a divergence
nobody notices until the pydantic diff. It carries a fourth assertion that the
generated client exposes exactly those three enums, because the per-enum checks
can only see an enum somebody remembered to list.
**`PlatformRole` gets no Prisma enum**: its only column is
`PlatformRoleAssignment.role`, which lands in 1D, and a Postgres enum type with no
column is a schema object nothing can be wrong about.

**(b) `update`, `updateMany` and `upsert` stay unfiltered, and that is the restore
mechanism.** `FILTERED_OPERATIONS` holds eight read operations and no write ones,
so with `User` and `Organization` soft-deletable, restore is
`update({ where: { id }, data: { deletedAt: null } })` and needs no escape hatch.
Recording it as the mechanism rather than as a hole is the decision; `withDeleted()`
remains what a read needs.

What that costs, stated so nobody discovers it: **an `upsert` on a soft-deleted
row is worse than a resurrection.** Its `where` is unfiltered, so it finds the
deleted row and takes the `update` branch — which leaves `deletedAt` set unless
the payload clears it. The call returns a row object; the next `findUnique` for
the same identifier returns `null`. So `upsert` must not be used on `User` or
`Organization` in the provisioning path, and Plan 1A Task 6 owns that. Renaming a
soft-deleted organization likewise succeeds, which is harmless only because
nothing reads it. INFERENCE from the extension's operation sets, not measured.

**(c) The partial unique indexes are DEFERRED, and the consequence is not "a
re-signup then fails".** `Organization_slug_key` and `User_email_key` are **total**
uniques, so a soft-deleted organization permanently occupies its slug and a
soft-deleted user permanently occupies their email. The fix is a partial unique
index (`WHERE "deletedAt" IS NULL`), which Prisma's DSL cannot express for
PostgreSQL.

**The drift argument has to be made about the right construct, and the
measurement above narrows it.** Hand-written SQL is _not_ generally at risk here:
the CHECK constraints, all five policies and all three functions survive the next
`migrate dev` untouched, which emits an empty migration. An index is the
exception, because it is the one construct in the block's class that Prisma
**does** manage — it emits `CREATE UNIQUE INDEX "User_email_key"` from
`@@unique([email])` — so replacing that index with a partial one means the shadow
replay and the datamodel disagree about an object Prisma owns, and what it does
then is exactly the thing nobody here has measured. Nothing in this repository has
ever authored a partial index; the migration-authoring path proved fragile enough
during this very task (see the commit that guarded the `_prisma_migrations` REVOKE
on the table rather than only on the role); and learning that behaviour under
eight tables' worth of dependants is the wrong trade. Deferred, and the thing to
measure first is named.

**Written at full strength, because the obvious phrasing understates it by a
lot.** `FILTERED_OPERATIONS` includes `findUnique`, `findFirst` **and** `count`.
So once a `User` is soft-deleted, the provisioning path raises `User_email_key` or
`User_authProvider_externalAuthId_key` on **every** attempt, while its "another
request won, re-read and return" branch reads `null` on **every** attempt. That is
not a failure — it is a retry that never terminates successfully, reporting an
error that points at a row the extension has made invisible. Compounding it: a
unique violation aborts the whole transaction, so Postgres answers every
subsequent statement with `25P02` until rollback, and a recovery branch written
after the failing `INSERT` inside the same `client.$transaction` cannot execute at
all — MEASURED, in one transaction as `metrika_app`, by colliding
`User_authProvider_externalAuthId_key` and then issuing an ordinary `SELECT`,
which answered `current transaction is aborted, commands ignored until end of
transaction block`. **Plan 1A Task 6 Step 3 is where this is handled rather than discovered**:
the re-read must run inside `withDeleted()` and must distinguish "an active row
exists, return it" from "a soft-deleted row occupies this identifier", which is
not a race and must fail loudly with its own error rather than retry.

## Alternatives

- **The elevated `BYPASSRLS` client for the cross-organization read.** Pulls Plan
  1D's role, its third connection URL and its mandatory-audit wrapper forward into
  1A, and makes the most ordinary read in the product go through the escape hatch.
  Rejected on ordering: 1D's rule is that nothing bypasses RLS until bypassing is
  auditable.
- **No RLS on `User` and `OrganizationMember`, with an application-only rule.**
  Contradicts `docs/ROADMAP.md:274` ("enable on every tenant table") and ADR-0013
  ("both, always"), and would make the catalog coverage gate need a permanent
  exemption for the two tables the whole slice is about.
- **A `SECURITY DEFINER` function for the pre-identity read** —
  `app_user_by_external_id(provider text, external_id text) RETURNS uuid`, owned by
  `metrika`, `GRANT EXECUTE` to `metrika_app`. Rejected for being an
  owner-privileged, RLS-bypassing door reachable by the app role, shipped in the
  one slice with no audit trail — and for being invisible to the coverage gate,
  which enumerates tables and policies, not functions.
- **A fourth branch on `User_tenant_isolation` instead of a second policy.**
  Identical behaviour, since permissive policies OR together. Rejected because the
  widening would then have no name in `pg_policies`, no `FOR SELECT` of its own to
  prove it cannot write, and no way to be retired independently the day an
  elevated client makes it unnecessary.
- **A `RESTRICTIVE FOR DELETE` policy on `User` and `Organization`**, to stop the
  widened read half from also widening `DELETE` (see consequence 1). Deferred, not
  rejected on principle — the same construct IS used on `OrganizationMember`,
  because there the exposure was measured reachable and neither mitigation covered
  it. On these two it is unreachable for the two independent reasons consequence 1
  now names table by table, and the cost of writing it anyway is two more policies
  and two more golden-map entries in a slice that has already grown one policy.
  **Revisit in Plan 1C**, which decides what removing a member means, or the first
  time a soft-deletable model arrives with no membership child.
- **A `SECURITY DEFINER` role-check helper to gate `OrganizationMember` writes**,
  so that "an ADMIN adds a member" could be expressed in the policy without
  recursion. Its argument differs from the rejected bootstrap one — it reads the
  actor's OWN role and is not an RLS-bypassing read door — but it is still an
  owner-privileged function reachable by the app role, shipped in the slice with
  no audit trail, and invisible to the coverage gate. Rejected for 1A on the same
  ordering rule; 1C may take it, or may route administrative membership writes
  through 1D's audited elevated client.
- **Splitting `authProvider` and `externalAuthId` into a `UserIdentity` table**
  whose only policies are `userId = app_current_user_id()` plus the bootstrap
  pair, so that the widened co-member read of `User` could not reach the provider
  subject at all. It is a real answer to the escalation measured above and a
  better one at rest, but it is a second table, a second migration's worth of
  relations, and a rewrite of Tasks 5 and 6 against a shape the plan does not
  describe. The narrowed `WITH CHECK` closes the same escalation with one
  conjunct. Worth revisiting the day `User` grows a second credential-shaped
  column.

## Consequences

1. **The widened read half also widens `DELETE`, because `DELETE` is filtered by
   `USING` and has no `WITH CHECK` half — and the mitigations have to be named
   table by table, because they do not all cover all three.** The first pass of
   this ADR named two mitigations for "both models" and did not notice that the one
   table where the gap was reachable was covered by neither.

   - **`User` and `Organization`: unreachable, and neither reason is the policy.**
     The soft-delete extension refuses `delete`/`deleteMany` on both with
     `HardDeleteForbiddenError`, and `OrganizationMember`'s `onDelete: Restrict`
     foreign keys block deleting any `User` or `Organization` that has a membership
     row — which is every row provisioning creates, and being a co-member is what
     made the row visible in the first place. A future model that is
     soft-deletable but has no membership child inherits the gap. INFERENCE from
     Postgres's documented `USING`/`WITH CHECK` split.
   - **`OrganizationMember`: it was REACHABLE, and it is closed by a policy.** The
     model has no `deletedAt`, so it is deliberately absent from
     `SOFT_DELETABLE_MODELS` and `delete`/`deleteMany` pass straight through the
     extension; and no table carries a foreign key TO it, so there is nothing to
     restrict. MEASURED: `DELETE 1` across organizations, and `DELETE 4` spanning
     three for a bare `DELETE` with no `WHERE`.
     `OrganizationMember_delete_in_context` (decision 2) narrows it back to the
     organization in context — re-measured as `DELETE 0` and `DELETE 2`
     respectively, with `identity-rls.integration.test.ts` case 10 holding both the
     narrowing and the fact that in-context deletes still work.

   The general lesson, which is the reason this consequence is written at length:
   **the soft-delete extension and `onDelete: Restrict` are mitigations for
   soft-deletable models with membership children, and a table outside that
   intersection has neither.** Check the intersection, not the sentence.

2. **Referential integrity bypasses RLS, so a foreign key can point at a row the
   inserting caller cannot read.** `OrganizationMember.invitedById` is the live
   case. This is documented Postgres behaviour, not a defect, and it is the reason
   an FK violation can reveal that an id exists. INHERITED.

3. **`"updatedAt"` has no database default and no trigger.** Every raw-SQL
   `INSERT` — every fixture in the new suites, every psql probe — must supply it or
   fail with a NOT NULL violation, and an out-of-band `UPDATE` will not bump it.
   Prisma implements `@updatedAt` client-side. MEASURED.

4. **`Prisma.dmmf` is typed but STRIPPED, and the type claims more than the
   runtime carries.** It is typed as `BaseDMMF` — assigning it to `number` fails
   with `TS2322`, so the coverage test needs no `any`. But at runtime a model
   object holds only `{ name, fields, dbName }` and a field object only
   `{ name, kind, type }` (plus `relationName`): `isRequired`, `isId`, `default` and
   `uniqueFields` are **`undefined`** while typing as present, and
   `datamodel.enums` and `datamodel.types` are **empty arrays** even though this
   migration creates three enums. So `soft-delete-coverage.test.ts` may rely on
   `models[].fields[].name` and on nothing else — a `deletedAt` presence check is
   sound, and any assertion about nullability, defaults or enum members read from
   `dmmf` would silently pass on `undefined`. The enum member-equality assertion
   must read the generated runtime objects instead: `$Enums.OrganizationRole`,
   `$Enums.OrganizationKind` and `$Enums.CurrencyCode` are populated maps, and
   `Object.keys($Enums)` lists exactly the three. MEASURED, all of it — this is the
   one place in this ADR where TypeScript and the runtime disagree, and the type is
   the one that is wrong.

5. **`OrganizationMember` is absent from `SOFT_DELETABLE_MODELS`, and that is now
   asserted rather than assumed.** It has no `deletedAt`, so naming it would inject
   a filter on a column that does not exist. `soft-delete-coverage.test.ts` reads
   the datamodel and fails in both directions — a model with `deletedAt` missing
   from the set, or a name in the set with no `deletedAt`.

6. **Adding `User` and `Organization` to the set makes `.delete()` on either throw
   immediately.** `REFUSED_OPERATIONS` is checked before any filtering. Any
   provisioning-rollback or test-cleanup path in Tasks 4-6 that reaches for
   `.delete()` on those models has to be written as a soft delete or as raw SQL
   through the owner.

7. **`billingAddressId` from `docs/DOMAIN_MODEL.md:62` is not in the schema.**
   `Address` is not a Phase 1 table, and a nullable UUID with no referent is a fact
   nobody can check. It returns with `Address`.

8. **`Organization.countryCode` carries a FORMAT constraint and no MEMBER
   constraint; `taxIdentifier` carries neither.** There is no ISO-3166 vocabulary in
   `packages/contracts` and 1A does not create one, so the member set is checked at
   the API boundary. The column is `@db.Char(2)`, following the `Char(3)` currency
   and `Char(64)` hash precedents — but `Char(2)` is a MAXIMUM width and nothing
   more (MEASURED: `'c'` accepted, stored blank-padded at length 1), so the format
   is `Organization_country_code_format` and not the type. `taxIdentifier` gets
   nothing at all on purpose: a wrong NIT regex rejects a real taxpayer, and the
   domain model says the value is stored and never used in core logic.

9. **`permissive`, `roles`, and "does the predicate MENTION a tenancy function or
   CONSTRAIN with one" are the three ways a coverage gate passes while proving
   nothing.** All six applied policies read `roles = {public}`; five are
   `PERMISSIVE` and `OrganizationMember_delete_in_context` is `RESTRICTIVE`
   (MEASURED).

   - **`roles` is asserted per policy**: a policy scoped `TO some_other_role`
     never applies to `metrika_app` and is invisible to every predicate assertion.
   - **`PERMISSIVE` is asserted PER TABLE, as an existence check, not per policy
     as a prohibition.** A table whose ONLY policy is restrictive denies
     everything while satisfying every `qual`/`with_check` assertion, which is the
     property worth policing — but banning `AS RESTRICTIVE` outright bans the only
     construct that can narrow a shipped `USING` half without a `DROP POLICY`,
     i.e. the gate would forbid its own remedy. It did, briefly, in the first pass.
   - **The predicate itself is PINNED, not pattern-matched.** MEASURED, and this
     is the one that mattered: a table carrying `ENABLE`, `FORCE` and one
     `PERMISSIVE` policy `TO public` whose `USING` and `WITH CHECK` were both
     `(true OR app_current_org_id() IS NOT NULL)` passed the whole suite — 55/55,
     exit 0 — while a row written under one organization was readable from another
     and readable with no context set at all. PostgreSQL does not constant-fold a
     policy expression at `CREATE POLICY` time, so the harmless mention survives
     into `pg_policies` and a substring test reads it as a predicate. So the gate
     holds a golden map of catalog-rendered `{cmd, qual, with_check}` per policy
     and asserts set equality in both directions — this repository's own
     "the golden-file diff is the review" rule applied to policy predicates.
     The shape assertions are kept as the cheap first line, because they are what
     polices a table nobody has written yet; they are not sufficient on their own.
   - **`qual` is keyed on `cmd`, for the same reason `with_check` is.** `qual` is
     NULL by definition for a `FOR INSERT` policy (MEASURED), so a blanket
     non-null assertion would reject a correct insert-only policy — and the
     cheapest way out of that for its author is to widen the policy to `FOR ALL`.

10. **Nothing anchors `app.current_org_id` to a membership row, so a wrong value
    is not a degraded boundary — it is no boundary.** RLS is the backstop for the
    primary control and it consumes the primary control's own output unchecked.
    MEASURED as `metrika_app` with `app.current_org_id` = ORG_C and
    `app.current_user_id` = USER_A, having asserted in the same transaction that
    USER_A has **zero** membership rows in ORG_C: ORG_C's `Organization` row read
    in full, its entire roster read, its members' `User` rows read including
    `email` and `externalAuthId`, `UPDATE "Organization" SET name = …` →
    `UPDATE 1`, self inserted into ORG_C as `OWNER` → `INSERT 0 1`.

    This migration is the first point at which the membership anchor became
    expressible at all — `app_current_user_id()` did not exist before it — and the
    new primitive was used exclusively to WIDEN reads. Two obligations follow:

    - **Plan 1A Task 4's `withTenantContext` must derive the organization id from a
      membership lookup, never from request input or a header.** That is the
      primary control for this, and there is no backstop behind it on the three
      identity tables: conjoining the anchor into their policies would break
      creation (`Organization`'s `WITH CHECK` runs before any membership row
      exists) and would recurse on `OrganizationMember`.
    - **Every tenant-scoped CHILD table from Phase 2 onward should conjoin the
      anchor**, where it is safe to:
      `"organizationId" = app_current_org_id() AND EXISTS (SELECT 1 FROM
"OrganizationMember" m WHERE m."organizationId" = app_current_org_id() AND
m."userId" = app_current_user_id())`.

11. **Two things in the behavioural suite are single-assertion dependencies, and
    one thing is detection by SETUP rather than by assertion.** All three measured
    by mutation, and recorded so that a future author trimming
    "redundant-looking" cases knows what they are removing.

    - Deleting `User_identity_bootstrap` is caught by case 7a and only 7a; 7b-7f
      all assert emptiness or refusal, which a deleted policy preserves. Reducing
      its `AND` to the external-id half alone is caught by 7c and only 7c.
    - Deleting `User_tenant_isolation` is caught by the `beforeAll` SEED, not by an
      assertion: it removes the only INSERT-capable predicate on `User`, so Vitest
      reports `15 tests | 15 skipped` with zero failures and cases 3 and 6 never
      execute. The diagnostic is good (the seed re-throws with exactly this
      scenario named) but the detector is the part most likely to be refactored —
      moving the seed onto the owner connection for speed transfers the duty to
      case 3, whose co-member and self positive controls both go null without the
      policy.
    - Deleting the whole behavioural file leaves both gates GREEN (MEASURED: 8
      files / 40 tests, exit 0; `test:unit` exit 0). Nothing pins a test file's
      existence, no coverage floor covers this package, and neither CI suppression
      grep looks at test inventory. The golden map above is the real mitigation —
      with it, removing the behavioural suite no longer removes ALL of the
      boundary's coverage at once — and the gate additionally asserts that the file
      exists and is non-trivial. That residual risk is accepted rather than closed:
      a `describe`-count or case-name inventory rots on the first legitimate
      refactor, and a rotting assertion gets deleted.

12. **This ADR is frozen the moment Plan 1A Task 4 acts on it**, per
    `docs/adr/README.md:7`, which is why the `WITH CHECK` consequence and the two
    policy-composition edges are written here on the first pass rather than left for
    a correction. A later correction costs a new ADR. **This document was amended
    once before it was pushed** — after an adversarial review of Task 3 measured
    three permitted writes that decision 2 was believed to prevent, a coverage gate
    that could pass on a leaking policy, and a claim in decision 3 that the
    measurements falsified. Everything in it below the amendment is the state of the
    tree; nothing was corrected after the freeze.
