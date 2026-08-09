# ADR-0019 — Zod as the single source of truth, delivered via `nestjs-zod`

**Status:** Accepted · **Date:** 2026-08-08 · **Supersedes:** [ADR-0009](./0009-ts-rest-contracts.md)

## Context

ADR-0009 chose ts-rest, gated on a spike (ROADMAP 0.15): compatibility with the
chosen Zod major, NestJS on the Fastify adapter, and valid OpenAPI 3.1 emission.
The spike ran. ts-rest failed two of the three gates and the project's own
abandonment criterion.

**Zod 4.** `@ts-rest/core@latest` is 3.52.1, published 2025-03-04, and its
declarations are hard-pinned to Zod 3 internals. Type-checking a trivial branded
contract against it with `zod@4.4.3` produces 34 errors out of ts-rest's own
`.d.ts` files — `'…/zod/v4/classic/external' has no exported member named
'AnyZodObject'`, `no exported member 'ZodEffects'`. Not a peer warning: total
breakage. The only Zod-4-capable line is `3.53.0-rc.1`, behind the `rc`
dist-tag.

**Maintenance.** `npm view @ts-rest/core time.modified` is `2025-06-02`. No
publish of any kind — alpha, rc or stable — in the fourteen months since. The
last stable release is seventeen months old. ADR-0009 called abandonment "a real
if unlikely risk"; it is now observed, not hypothesised.

**OpenAPI 3.1.** `@ts-rest/open-api` emits `"openapi": "3.0.2"` and, against Zod
4 schemas, **silently empty** `"schema": {}` objects for every body and
response — `@anatine/zod-openapi`'s Zod-3 shape detection never matches and
falls through without erroring. A custom `SchemaTransformer` using Zod 4's
native `z.toJSONSchema()` fixes the content; the version field still has to be
overwritten by hand.

**What did work.** `@ts-rest/nest@3.53.0-rc.1` booted on Fastify and served real
requests; `.brand()` survived into inferred client types; missing-field and
wrong-base-type controller returns failed to compile. The concept is sound. The
package is not maintained.

## Decision

Take ADR-0009's own documented fallback:

- **`nestjs-zod@5.5.0`** for validation and OpenAPI metadata. It peer-declares
  `zod: "^3.25.0 || ^4.0.0"` — first-class Zod 4 — and was published two weeks
  before this ADR.
- **`@nestjs/swagger@11.4.6`** for document generation, run through
  `cleanupOpenApiDoc({ version: '3.1' })` **and** an explicit
  `document.openapi = '3.1.1'` override. No tool tested emits 3.1 natively; the
  override is mandatory and belongs in one function that every emitter calls.
- **`orval`** to generate the TanStack-Query client from the emitted document,
  in `packages/api-client` (Plan 0B-2). This leg was version-checked but never
  run; 0B-2 must prove it before the fallback is treated as fully verified.

Three obligations travel with the decision:

1. **Response validation defaults ON, project-wide.** Without it, both
   libraries type a controller's return against the schema's _input_ type, and
   `.brand()` is output-only in Zod — so a plain `string` satisfies a branded-ID
   field at construction, compiles, and ships unvalidated. `nestjs-zod`'s
   response validation is the equivalent of ts-rest's `validateResponses`, and
   both default to **off**. Turning it on takes **two** registrations, and
   either one alone is silent:
   - `{ codec: true }` on every DTO, funnelled through `metrikaDto()` in
     `apps/api/src/shared/http/zod-dto.ts`. This is the compile-time half: it
     is what makes `@ZodResponse` check the handler's return against the
     schema's _output_ type. It is a convention enforced by a lint rule, not by
     the type system — `@ZodResponse` has overloads that accept a non-codec DTO
     and simply check the weaker side.
   - `{ provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor }` in
     `apps/api/src/app.module.ts`. This is the runtime half. `@ZodResponse` only
     attaches metadata; the interceptor is what reads it and parses the
     response. Measured on this codebase's exact DTO shape: with the provider a
     handler returning an out-of-enum value answers 500, without it the same
     handler answers 200 and ships the invalid body.

   Neither may become opt-in per route, and a change that removes either one
   must fail a test. `apps/api/test/health.integration.test.ts` is that test:
   `/health/ready`'s handler hands the DTO the service's full result and lets
   `HealthReadySchema`'s `omit` remove `latencyMs`, so if nothing parses the
   response, an unauthenticated endpoint starts reporting per-dependency
   latency and the fixture goes red. Redaction that only happens when
   validation runs is the cheapest available canary; every app added later
   needs one of its own.

2. **`packages/contracts` stays pure Zod.** Neither `initContract().router()`
   nor `createZodDto()` can live there — both drag in a framework, and
   CLAUDE.md's boundary rule allows only `zod`. The DTO wrappers live in
   `apps/api`, alongside the controllers that use them. Because the client is
   generated from the emitted document rather than from the wrapper objects,
   nothing outside `apps/api` needs them.
3. **Fixtures, not assertions.** A controller whose return omits a required
   field or supplies the wrong base type must fail `tsc`, and the emitted
   document's schemas must be non-empty. Both are asserted in
   `apps/api/test/openapi.integration.test.ts` — because "the schema is empty
   but nothing errored" is the exact failure mode that made ts-rest look like it
   worked. The first is a compile-time property and has a compile-time fixture:
   two decorator applications carrying an expect-error directive, which `tsc`
   reports as unused the day `@ZodResponse` stops checking the return. The
   second reads the real emitted document and asserts `HealthDeepDto` has
   populated `properties`. The same file also pins the `openapi` version
   override, without which the document claims 3.0 while containing 3.1-only
   constructs.

## Alternatives

- **Pin `@ts-rest/*@3.53.0-rc.1` anyway.** It works end to end today. Rejected:
  a repository whose central property is that an accepted quote stays
  reconstructible indefinitely should not anchor its contract layer on a
  non-GA prerelease with no publishes in fourteen months.
- **class-validator + `@nestjs/swagger`.** Rejected in ADR-0009 and still
  rejected: it requires a second schema definition alongside Zod.
- **tRPC.** Rejected in ADR-0009: abandons REST and OpenAPI.

## Consequences

**Accepted:** a codegen step (`orval`) the ts-rest path would not have needed,
and a less pleasant client than ts-rest's inferred one. `@nestjs/swagger` drags
`class-transformer` and `class-validator` in as peers even though `nestjs-zod`
replaces them for validation. Neither library's default OpenAPI path emits a
3.1-versioned document, so a second document generator added later that skips
the override would silently claim 3.0 while containing 3.1-only constructs —
which is why there is exactly one `buildOpenApiDocument`.

**Gained:** one definition per concept across four consumers and two languages,
on packages that are actually maintained, with the source of truth still Zod in
`packages/contracts` — so the migration cost this ADR just paid is the same
bounded cost ADR-0009 predicted, and it stays bounded.
