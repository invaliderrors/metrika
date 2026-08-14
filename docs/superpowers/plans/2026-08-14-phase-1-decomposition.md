# Phase 1 — how it splits, and why

Phase 1 has eleven roadmap deliverables and one definition of done: _a user in org A cannot
reach any resource of org B through any endpoint, verified by the automated suite, with RLS
proven to catch it independently_ (`docs/ROADMAP.md:294`). Plan 0B-1 shipped fifteen tasks in
6,548 lines and was afterwards split by subject into 0B-1/0B-2/0B-3; that is the ceiling this
repository has already measured. Phase 1 is larger. It splits into **four sub-plans**.

## The seam: the user journey, not the layer

The cut follows the three things a person can complete in Phase 1 — become a user, keep private
work, work with other people — plus one that is only demonstrable once the first three have
produced actions worth recording. Every horizontal deliverable is pushed into the journey that
first genuinely consumes it, and no slice ships a package, a role or a control with no caller.

The roadmap's own 1.1 → 1.10 ordering is a layer cake (auth, users, orgs, projects, authz, RLS,
audit, client, ui, web). Executed as written, nothing is demonstrable until 1.9 and the IDOR
suite has no route to point at until the phase is nearly over — which inverts the definition of
done. Slicing by journey makes that property true at the end of **1B** and keeps it true by
construction afterwards, because the suite is generated: 1C adds roughly ten routes and the
suite covers them with no new test code. That is also the only available proof that the
generator generates.

| Slice  | Title                                                       | Roadmap tasks   | Depends on |
| ------ | ----------------------------------------------------------- | --------------- | ---------- |
| **1A** | Sign up, and Metrika knows who you are                      | 1.1, 1.2, 1.6\* | —          |
| **1B** | Your work lives in projects, and no one else can reach them | 1.4, 1.5, 1.8   | 1A         |
| **1C** | Bring your studio in: invite, accept, switch                | 1.3, 1.9, 1.10  | 1A, 1B     |
| **1D** | An audit trail nothing in the running system can rewrite    | 1.7, 1.6\*      | 1B, 1C     |

\* 1.6 is split, deliberately, and that is the one place this cut deviates from the roadmap's
wording. See "Declared deviations" below.

## What is true after each slice merges

**1A — Sign up, and Metrika knows who you are.** A visitor completes Clerk sign-up and lands on
a page rendering their own display name and the personal organization Metrika created for them,
fetched from `GET /api/v1/me` over a verified bearer token. Signing in twice yields exactly one
`User`, one `Organization` and one `OrganizationMember`, and the second attempt is absorbed by a
database unique-constraint violation rather than an application pre-check. Every table in the
first real migration is `ENABLE`d **and** `FORCE`d with a policy carrying both `USING` and
`WITH CHECK`, asserted as `metrika_app` against Testcontainers by a test that enumerates tables
from `pg_class` rather than naming them — so every later slice's migration is policed
automatically. `/me` is the first route ever served under `/api/v1`, which is what lands the
request-validation pipe, the typed error envelope and the JWT security scheme once instead of
per module. And every log line and every server span carries `userId` and `organizationId`,
which closes the one row of `docs/OBSERVABILITY.md`'s chain table (`:58`) whose stated blocker is
this phase by name — the constant definition of done asks for observability on anything that can
fail, and 1A adds three failure classes that had none.

**1B — Your work lives in projects.** A signed-in architect creates a project, sees it in a
cursor-paginated list, opens it, renames it and archives it. `Project` is the smallest possible
tenant-scoped resource, which makes it the right surface on which to establish four things every
later resource copies: the `Action`/`Resource` unions and pure policy functions, the `@Policy()`
decorator and its guard, the cursor contract, and **the cross-tenant IDOR suite generated from
the route table**. `Project` carries the roadmap's fourth named index,
`(organizationId, createdAt DESC)` (`docs/ROADMAP.md:284`, placed on `Project` by
`docs/DOMAIN_MODEL.md:536`) — it is the index cursor pagination reads, so it lands with the
list endpoint rather than being inferred later. `packages/api-client` lands here because this is
the first browser-side mutation, at a three-endpoint surface rather than forty. The phase's
definition of done becomes true and mechanically verified one slice before the phase ends.

Four obligations 1A defers land here explicitly, as acceptance criteria rather than as
implications:

- **`/me` migrates onto the typed client.** The constant definition of done requires new
  endpoints in the generated OpenAPI **and the typed client** (`docs/ROADMAP.md:696`). 1A serves
  `/me` and renders it from an RSC through raw `apiFetch`; when `packages/api-client` lands, that
  call moves onto it and `apps/web` stops calling `apiFetch` directly. Without this line the
  mechanism by which `/me` is permanently absent from the typed client is already in place.
- **Both coverage gates**, named separately because they are independent numbers with
  independent rationales: `apps/api/src/authorization/policies` at **100% branch** and API
  modules at **≥ 70%** (`docs/TESTING.md:17`, enforced per-package per `:21`). 1A adds the ≥70%
  gate for the three modules it ships; 1B adds the 100%-branch gate when the policies exist.
- **"`AuthContext` required on every repository method" is written against 1A's exemption list**,
  not against a clean tree: identity bootstrap (`findByExternalAuthId`) and first-login
  provisioning both run before any `AuthContext` exists. 1A names them, gives them their own
  entry points and records the reason in ADR-0040; 1B's rule is "every repository method takes
  `auth: AuthContext` as its first parameter, except the two named in ADR-0040", and the list
  does not grow without an ADR.
- **`PolicyResult`'s home** was decided in 1A alongside `AuthContext`'s — see Declared
  deviations item 5. 1B implements the decision rather than reopening it.

**1C — Bring your studio in.** An owner creates a TEAM organization, invites someone by email,
and the invitee accepts and appears in the member list. Invitation tokens are hashed at rest;
last-owner protection runs inside the removal transaction and is proven by a concurrent
double-removal against a real container. `packages/ui` lands here, at the point of widest demand
(Dialog, Input, Select, DataTable, Badge, Toast, Card, Button), under one rule: no export ships
without a live consumer in the same slice. The roadmap's E2E journey — signup → create org →
invite → accept → create project — runs end to end.

**1D — An audit trail nothing can rewrite.** An owner opens Actividad and sees who invited whom,
who changed a role, who removed a member — including anything Metrika support did on their
behalf. `AuditLog` and `PlatformRoleAssignment` land with a `pg_roles`-guarded
`REVOKE UPDATE, DELETE … FROM metrika_app` in the migration that creates them, because
`packages/database/sql/00-app-role.sql:38-41` grants all four verbs to every future table
automatically — append-only is **false by default**. The elevated BYPASSRLS client lands here
too, bound to the `AuditRecorder`, which buys the invariant this ordering exists for: **nothing
bypasses RLS until bypassing is auditable.**

Three things 1D owns explicitly, so none of them is left to be noticed:

- **`PlatformRoleAssignment` is 1D's table**, not a loose end of 1A. It is in the roadmap's
  Phase 1 Database list (`docs/ROADMAP.md:284`) and the roadmap's "every elevated-client use
  audited" (`:292`) is what it exists for, so it lands with the client it authorises. Its Prisma
  `PlatformRole` enum lands with it — 1A ships the Zod vocabulary only, because a Postgres enum
  type with no column is a schema object nothing can be wrong about. `AuthContext` gains
  `platformRoles` here, in the same slice as the table the factory reads it from.
- **Phase 1's four events**, on the mechanism declared in item 6 below, each emitted inside the
  transaction that causes it: `OrganizationCreated` and `MemberJoined` in the provisioning
  use case 1A wrote, `MemberInvited` and `MemberRemoved` in 1C's. They arrive with
  `AuditRecorder`, which is their first and only Phase 1 subscriber.
- **`StatusTransition`**, per item 3.

## Why projects (1B) before teams (1C)

The objection is that a personal organization exercises only one row of the role truth table, so
authorization looks trivial until teams exist. That premise is false for pure policy functions
over a loaded resource: 1B's fixtures construct an `AuthContext` at OWNER, ADMIN, MEMBER,
BILLING and PLATFORM_ADMIN directly and reach 100% branch coverage with zero TEAM organizations
in existence. That is precisely why ADR-0013 made them pure. Two users with two personal
organizations is already two tenants, so the IDOR suite is non-vacuous in 1B.

Ordering teams first would instead establish the cursor contract, the IDOR generator and the RLS
policy template on the phase's most complicated resource — one with a cross-tenant token lookup
and an invariant no database constraint can express (`docs/DOMAIN_MODEL.md:66`).

## Declared deviations from the roadmap

1. **1.6 is split.** Its RLS mechanism, the per-table policies and the meta-gate land in 1A;
   its "separate elevated client for platform admins with mandatory audit" clause lands in 1D
   with `AuditModule`. Reason: the elevated client has no consumer in 1A — the two reads that
   look like they need one are answered by **transaction-local settings with their own
   predicates**, not by bypass. `/me`'s cross-org membership read is answered by a second GUC
   (`app.current_user_id`), and the `externalAuthId → User` lookup that must run before any user
   id is known is answered by a third pair (`app.current_auth_provider` +
   `app.current_external_auth_id`) behind a second, read-only named policy on `User`. Both are
   narrower than BYPASSRLS by construction: the identity pair can only ever return the one row
   whose external identifier the caller already proved. Shipping a BYPASSRLS role with no caller
   is the unproven-control state this repository has already regretted once
   (`apps/web/src/components/ui/button.tsx:22-46`, "DELIBERATELY IMPORTED BY NOTHING").
   Every later slice's migration is still policed by 1A's meta-gate.
2. **1.9 is distributed by construction.** "Web: signup/login, org switcher, member management,
   invitation acceptance, project list/detail" names five screens belonging to three journeys.
   It is bookkept against 1C because three of the five live there; 1A ships the auth screens
   (the roadmap's own Location column for 1.1 already says `apps/web/src/features/auth`) and 1B
   ships the project screens.
3. **`StatusTransition` has no writer in Phase 1.** It is in the roadmap's Database list, but no
   Phase 1 entity is declared with a `state` column — invitation lifecycle is `expiresAt` /
   `acceptedAt` / `revokedAt` timestamps — and the generic `transition()` helper is ROADMAP 2.3.
   **1D owns the decision**: ship the table with the same append-only REVOKE as `AuditLog` and
   no writer, or defer it to Phase 2 and record the deviation. Do not create it earlier.
4. **1.11 (Terraform staging) stays deferred**, with 0.14 and for the same reason: no AWS
   account exists.
5. **`AuthContext` and `PolicyResult` are not `packages/contracts` types**, though
   `docs/ROADMAP.md:282` lists both under **Contracts**. Neither is a wire type: `AuthContext` is
   what a guard hands a repository, `PolicyResult` is what a policy function returns, and
   `packages/contracts` is the package whose every export is a candidate for the pydantic
   codegen. Putting them there would push `OrganizationRole` semantics into a shape
   `apps/workers` inherits for no reason, and ADR-0019 has already closed the package to router
   and DTO objects. **Both live in `apps/api/src/authorization/`** — `auth-context.ts` from 1A
   Task 4, `policy-result.ts` from 1B. What DOES stay in contracts is the vocabulary they are
   typed against: `OrganizationRole`, `PlatformRole`, `OrganizationKind`, the branded IDs.
   1A records the decision (ADR-0039 §Consequences) and corrects ROADMAP.md:282 in Task 9 —
   for the same reason as item 7, and in the same edit.
6. **Phase 1's four events are in-process Nest `EventEmitter` domain events**, not outbox
   integration events. `docs/ARCHITECTURE.md:817` already draws that line, and `:811` names the
   outbox's four users — upload completion, quote creation, order creation, payment webhooks —
   none of which is in Phase 1. So no ROADMAP 2.4 pull-forward is required, and the decision
   table below no longer asks for one.
   The unreconciled half is a genuine blueprint conflict rather than a plan gap:
   `docs/ROADMAP.md:288` names `OrganizationCreated`, `MemberInvited`, `MemberJoined` and
   `MemberRemoved`; `docs/ARCHITECTURE.md` §24's catalogue omits all four and then states
   "Events explicitly _not_ created: … anything with no consumer." **Both are right about
   different moments**, and that is the reconciliation: the four events have no subscriber until
   `AuditRecorder` exists, so each ships in **1D**, emitted inside the transaction that causes
   it, together with the subscriber that makes it not a maintenance liability. 1A and 1C emit
   none and say so; 1D adds the emit to the provisioning use case 1A wrote — a line inside an
   existing `application/` transaction, not a re-architecture — and to 1C's. The document
   reconciliation ships in 1D's pull request, in the same commit as the code, and §24's
   catalogue gains the four rows with `AuditRecorder` named as their consumer.
7. **The three named `*Contract` modules are not built, by ADR-0019.**
   `docs/ROADMAP.md:282` names `organizationsContract`, `projectsContract` and `usersContract`.
   Those names describe a ts-rest router object, and ADR-0019 rejected ts-rest:
   `docs/CONTRACTS_AND_API.md:350` states that `packages/contracts` "can hold neither
   `initContract().router()` nor `createZodDto()`". What Phase 1 builds instead is one Zod
   module per subject — `packages/contracts/src/organization.ts`, `src/auth.ts`,
   `src/project.ts` — with the routes living in `apps/api`. 1A Task 9 corrects the roadmap line
   with a pointer to the ADR, so a later reader tracing Phase 1 completeness does not find three
   named contracts that were never built and no record of why.

## Sizing, and the split candidate

1A is nine tasks. 1B is eight to ten. **1C is the fattest and is the one to watch**:
organizations, members, roles, invitations with hashed tokens, last-owner protection, the org
switcher, three screen families and the `packages/ui` extraction is realistically twelve-plus.
The natural seam inside it (membership vs invitation) divides roadmap task 1.3, so splitting it
means one task spanning two sub-plans. Decide that during plan writing, not during execution.

## Cross-slice decisions, and who owns each

| Decision                                                                                                                                                                                                                                                                                                                | Owner  | What the answer changes                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can Phase 1 contracts be exported at all? `test/json-schema.test.ts:128-132` forces every exported Zod schema into the pydantic codegen, and the allowlist at :271-297 rejects `.optional()`, arrays and booleans                                                                                                       | **1A** | Blocks the first response schema in every slice. ADR-0039.                                                                                                                                                                         |
| Where a repository may physically live — `ARCHITECTURE.md:527-539` says `modules/<name>/infrastructure/`, `boundaries.js:122` exempts only `src/infrastructure/persistence/**`                                                                                                                                          | **1A** | The file layout of every module in every later phase. ADR-0041.                                                                                                                                                                    |
| How a cross-organization read is expressed (`/me`, the switcher, invitation acceptance), **and how the pre-identity read is expressed** — the `externalAuthId → User` lookup runs on every request with neither GUC known                                                                                               | **1A** | Every RLS predicate and every repository signature. ADR-0040, which names three tenancy primitives, not two.                                                                                                                       |
| Where the active organization comes from — header claim, path segment, or session cookie                                                                                                                                                                                                                                | **1A** | Every route signature and every TanStack Query cache key.                                                                                                                                                                          |
| How the authenticated identity reaches the log line and the span — `RequestContext` is a readonly single-field `{ requestId }` (`apps/api/src/shared/request-context/request-context.ts:4-12`) established in middleware, before any guard runs, so a mutable slot or a nested `storage.run` from the guard is the fork | **1A** | Whether `userId`/`organizationId` appear on every line for the rest of the product, or on none. `docs/OBSERVABILITY.md:58` names this phase as the blocker.                                                                        |
| Where the IDOR route table comes from — `@Policy()` metadata via `DiscoveryService`, the emitted `openapi.json`, or a hand list                                                                                                                                                                                         | **1B** | Whether the suite is a generator or a one-time audit. Only the first makes an **undecorated** route a CI failure.                                                                                                                  |
| Which of 403 / 404 each route answers (`SECURITY.md:115`)                                                                                                                                                                                                                                                               | **1B** | Leaks existence, or breaks a legitimate 403 UX.                                                                                                                                                                                    |
| Whether the invitation token stays in the URL path — `isRedactedKey('url.path')` is **false** and `RedactingSpanProcessor` handles only the query of `url.full`/`http.url`/`http.target`                                                                                                                                | **1C** | A raw token exported verbatim on every server span, to OTLP and Sentry.                                                                                                                                                            |
| The payload shape and emit site of the four Phase 1 events — the mechanism is **settled** (in-process `EventEmitter`, deviation 6), the slice is **settled** (1D, with their subscriber); what is open is what each payload carries and whether the emit is a method on the use case or an interceptor                  | **1D** | The `AuditLog` row shape, and how much of it is derived rather than passed. Not whether the events exist.                                                                                                                          |
| Whether `StatusTransition` ships in Phase 1                                                                                                                                                                                                                                                                             | **1D** | A table with no writer, or a recorded deviation from the roadmap's Database list.                                                                                                                                                  |
| The RLS policy for `AuditLog`'s **nullable** `organizationId` — `WITH CHECK (organizationId = app_current_org_id())` rejects a platform-level NULL row outright                                                                                                                                                         | **1D** | Whether the audit write that must accompany every elevated-client use can happen through the app role at all.                                                                                                                      |
| The RLS policy for `PlatformRoleAssignment`, which is keyed on `userId` and must not be self-writable — its correct write predicate is `WITH CHECK (false)`, granted only to the elevated client                                                                                                                        | **1D** | Whether 1D writes a wrong policy or weakens 1A's meta-gate. 1A's gate already admits a literal `false` for exactly this row, so neither is forced — but the answer is recorded here so it is not rediscovered under time pressure. |

## Decompositions rejected, and why

- **The roadmap's own order, 1.1 → 1.10.** A horizontal layer cake. Nothing is demonstrable
  until 1.9, all integration risk lands in the last two deliverables, and cross-tenant
  isolation becomes provable last when it should become provable at the first tenant-scoped
  route and stay provable by construction.
- **One slice per roadmap task (ten slices).** Four of the ten (1.5, 1.6, 1.8, 1.10) have no
  user journey at all and several are not independently shippable: 1.6 without a tenant table
  has nothing to protect, and 1.10 without a screen ships eight primitives in exactly the state
  `apps/web/src/components/ui/button.tsx` is in today.
- **Module-per-slice (Auth | Users | Organizations | Projects | Audit).** Horizontal in
  disguise: every slice ships an API with no page and no proof of isolation, `packages/api-client`
  and `packages/ui` have no home, and both the IDOR suite and the RLS backstop land after every
  module is written — the shape where an unprotected route ships and nothing catches it. It also
  maximises re-touching the closed surfaces: four independent additions to `DomainErrorCode`
  means four pydantic re-emits and four edits to `error-mapping.ts`, and four migrations means
  four edits to `SOFT_DELETABLE_MODELS` and four chances to write a `USING`-only policy that
  `migration-sql.test.ts:51-57` cannot catch (its `USING` and `WITH CHECK` assertions are
  whole-history substring checks already satisfied forever by the init migration).
- **Layer-first: contracts + policy kernel, then the whole schema, then routes, then the web.**
  The strongest runner-up, and the source of this cut's ripple-surface discipline. Rejected
  because it writes policy functions against authz view types invented before the schema exists,
  and it ships two consecutive slices — a contracts package with no caller, then eight tables
  with no writer — that leave the product no more capable. Its best ideas are grafted: open
  `packages/contracts` as few times as possible, settle the emission fork before writing any
  contract, and treat `/me` as the route that lands the shared HTTP infrastructure once.
- **Control-first: all eight tables plus RLS plus the elevated client plus audit in one opening
  slice.** Also a strong runner-up, and the source of this cut's "controls upstream of their
  subjects" rule — which survives as an ordering rule _inside_ each slice (the RLS policy is in
  the same migration as the `CREATE TABLE`; the append-only REVOKE is in the migration that
  creates the ledger). Rejected as a slice boundary because it ships a BYPASSRLS role with no
  caller, and because its follow-on slice was self-identified at eleven to thirteen tasks.
- **A verification slice at the end** — the IDOR suite, the RLS-bypass tests and the E2E journey
  gathered into one "prove it" plan. Rejected outright: a security control written after the
  code it guards is a retrofit, the property `docs/TESTING.md:145` claims never holds during the
  phase itself, and `CONTRIBUTING.md:87` is explicit that a control without a test is an
  intention.
- **Splitting 1.1 so the Nest guard lands with identity and the Next middleware lands with the
  screens.** The middleware is auth plumbing, not a screen; it belongs beside the JWKS decision
  and the token-acquisition path it shares an ADR with.

## Plans

- `docs/superpowers/plans/2026-08-14-phase-1a-sign-up-and-metrika-knows-who-you-are.md` — written.
- 1B, 1C and 1D are written after their predecessor merges, so each is written against a tree
  that exists rather than one that is planned.
