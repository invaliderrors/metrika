# ADR-0041 — A module's repositories live in the module, and tenancy is a function rather than an extension

**Status:** Accepted · **Date:** 2026-08-17 · Scopes part of ADR-0005, ADR-0013 and ADR-0018

## Context

Two documents disagreed about where a Prisma repository may physically live, and
the disagreement was not visible until something had to be written.

[`ARCHITECTURE.md`](../ARCHITECTURE.md) §10 gives every module the same internal
shape and puts its repositories at `modules/<name>/infrastructure/`. The
`prismaImportBoundary` ESLint rule exempts the literal glob
`src/infrastructure/persistence/**/*.ts` and nothing else
(`packages/eslint-config/src/boundaries.js`). **A repository written at the
documented location could not import `@metrika/database` at all** — the rule
would reject it, and `pnpm lint --max-warnings=0` inside `pnpm verify` would
fail. Neither document was wrong on its own; the glob was written when
`apps/api` had one module and no repositories.

Phase 1B writes the first module repository, so the answer has to exist now, and
every module in every later phase inherits it.

A second question arrived with it. ROADMAP 1.6 words its deliverable as "Prisma
extension setting `app.current_org_id` per transaction", and
[ADR-0013](./0013-authorization.md) decision 3 says the same. Plan 1A Task 4
builds it as a function instead.

## Decision

**1. Two persistence zones, not one. A module's repositories live in the
module.**

`prismaImportBoundary`'s `ignores` becomes:

```js
ignores: ['src/infrastructure/persistence/**/*.ts', 'src/modules/*/infrastructure/**/*.ts'];
```

The blueprint is the source of truth ([`CLAUDE.md`](../../CLAUDE.md)): a conflict
with it is either followed or superseded by an ADR, never silently diverged
from. `ARCHITECTURE.md` §10 is the blueprint here, the glob was an
implementation detail written against a smaller tree, and moving every module's
data access out of the module to satisfy a glob would be the tail wagging the
dog.

`*` matches **one** path segment, deliberately. `src/modules/users/
infrastructure/**` is exempt; `src/modules/users/application/infrastructure/**`
is not, and a fixture asserts that direction rather than leaving it to the
reader — a boundary without a rejection fixture is an intention, not a control.

This narrows **ADR-0005 decision 1** ("`@prisma/client` may only be imported from
`apps/api/src/infrastructure/persistence/**`") and **ADR-0018**'s identical
sentence about `brandUnsafe`. Hence the status line, and hence the
forward-pointing lines added to both.

**2. `brandUnsafe` and `newUuidV7` are confined to the same zones, by the same
rule.**

A helper that mints a branded id from a bare string dissolves ADR-0018's
guarantee wherever it is reachable, so it is not enough for it to live in the
persistence directory — it must be unimportable from outside it. It is added to
the **same** `no-restricted-imports` options object rather than a second config
object, because flat config replaces a rule's options wholesale per key and a
second object naming the same rule id would silently drop one of the two bans.

**3. One narrow exemption, which carries everything it displaces.**

`apps/api/test/branding.test.ts` asserts that `newUuidV7` emits a version-7
UUID — the one thing that distinguishes it from `crypto.randomUUID()`, which
would satisfy a test that only checked the shape. `apps/api`'s lint script is
`eslint .` and ignores only `dist/`, `coverage/` and `openapi/`, so `test/**` is
linted like source and that import trips the rule this ADR just widened.

The exemption is a second config object scoped to that exact path which repeats
the `@prisma/client` and `@metrika/database` entries and omits only the branding
pattern. Both objects read from one module-level constant so they cannot drift,
and the fixture table's last row is the negative control: a `@metrika/database`
import from a `test/branding.test.ts`-shaped path is **still rejected**. A
narrowing with no negative control is the same defect the `slice(1)` comment in
`boundaries.js` describes.

Co-locating the test inside the zone was the alternative. It costs **two** config
changes rather than one — `apps/api/vitest.config.ts`'s `include` is
`['test/**/*.test.ts']` and `tsconfig.build.json`'s is `['src/**/*.ts']` — so a
co-located test would be compiled into `dist/` and ship with the application.
That price is paid by every future co-located test, for one file.

**4. Tenancy is a function, not a Prisma client extension.**

`withTenantContext(client, scope, fn)` opens one interactive transaction and sets
both GUCs on it. An extension wrapping every model operation would open a
transaction per operation, which changes connection behaviour and multiplies
transactions per request — the interactive-transaction limits documented on
`createPrismaClient` (one pooled connection for the callback's whole duration,
`P2028` past the timeout) make that a real cost rather than a stylistic one.

This is where ROADMAP 1.6's wording and **ADR-0013 decision 3** yield to the
measurement, which is the third thing this ADR scopes. Task 9 updates the
roadmap so the two documents agree rather than leaving the reader to discover
which one the tree follows.

## Alternatives

**(a) All repositories under `apps/api/src/infrastructure/persistence/<aggregate>/`.**
Zero ESLint change, and every raw-Prisma import stays in one directory, which is
a genuinely smaller review surface. Rejected because it contradicts
`ARCHITECTURE.md` §10 — so it needs an ADR against the blueprint rather than one
scoping a glob — and because a module's data access living outside the module
breaks the "each module has the same internal shape" property that makes the
catalogue readable. Revisit if the number of modules with repositories stays
small enough that one directory is still reviewable, which is not the direction
Phases 2–11 go.

**(b') A single glob `src/**/infrastructure/**`.** Simpler to read and wrong: it
exempts `src/modules/users/application/infrastructure/`, and any other directory
someone names `infrastructure` at any depth. The fixture that rejects one
segment outside the zone is what makes the difference observable.

## Consequences

1. **Two directories may import Prisma**, and the review surface for raw data
   access grows by one directory per module. The `no-restricted-imports` message
   names both, because a developer who trips the rule reads the message and not
   the ADR index.
2. **The lint messages changed and now cite ADR-0041.** They previously read
   "Prisma access goes through apps/api/src/infrastructure/persistence — see
   ADR-0005", which is no longer the rule and no longer the authority.
3. **`CLAUDE.md`'s two Boundaries bullets state the old rule verbatim** and are
   on Task 9's explicit edit list. Until that lands, the tree and that file
   disagree — which is exactly the state this ADR's bookkeeping exists to
   prevent, and is why the edit is listed rather than left to be noticed.
4. **`withOrganizationContext` is kept, not removed.** It sets only the
   organization GUC, which is correct for `RlsProbe` — the permanent regression
   fixture, which has no user column — and for the leak assertion that proves
   the `$transaction` wrapper is load-bearing. New callers take
   `withTenantContext`.
5. **Three named entry points wrap the two raw functions**, in
   `apps/api/src/infrastructure/persistence/tenant-context.ts`, which is the only
   module in the application that calls either. Two of them —
   `runInBootstrapTenant` and `runInIdentityScope` — are the declared exemptions
   to ADR-0013 decision 2, recorded by symbol in
   [ADR-0040](./0040-tenant-context-gucs.md). The list does not grow without an
   ADR.
6. **A raw scope is still reachable inside the persistence zone**, by design:
   provisioning must mint both ids before the rows exist, because Task 3's
   `WITH CHECK` predicates require a row's id to equal the GUC before its
   `INSERT`. What the zone boundary buys is that no code outside it can pass two
   strings from a request into a tenant context. It does **not** discharge
   ADR-0040 consequence 10 — deriving `organizationId` from a membership lookup
   is Task 5's obligation, and `runInTenant`'s signature is what makes that the
   only place it can be owed.
