# Metrika — Contracts & API Design

> One Zod definition per concept. Everything else is derived, never duplicated.

---

## 1. The single-source-of-truth problem

The naive stack maintains four definitions of "a quote": a NestJS DTO with class-validator decorators, a `@nestjs/swagger` annotation, a frontend TypeScript interface, and a worker-side model. They drift. Every drift is a production bug that types did not catch because each side was internally consistent.

Metrika defines a concept once, in Zod, in `packages/contracts`, and derives the rest:

```mermaid
graph LR
    Z["Zod schema<br/>packages/contracts"]
    Z -->|z.infer| T[TypeScript types]
    Z -->|nestjs-zod| V[Runtime request/response validation]
    Z -->|nestjs-zod + @nestjs/swagger| O[OpenAPI 3.1]
    Z -->|orval, from the emitted document| C[Typed client + hooks]
    Z -->|zod-to-json-schema → datamodel-codegen| P[pydantic models — Python workers]
    Z -->|z.infer| E[Event payload types]
```

There is no hand-written DTO, no hand-written frontend interface, no hand-written worker model, anywhere in the repository. A lint rule flags `interface` declarations in `apps/api/src/**/api/**` to catch the drift at the moment it starts.

---

## 2. `nestjs-zod` — the decision and its escape hatch

ADR-0009 chose ts-rest, gated on a Phase 0 spike. The spike ran and ts-rest
failed it — `@ts-rest/core` hard-pinned to Zod 3 internals, no publish of any
kind in fourteen months, and `@ts-rest/open-api` emitting silently empty schemas
against Zod 4. The documented fallback was taken. See
[ADR-0019](./adr/0019-nestjs-zod-contracts.md), which supersedes ADR-0009 and
records the measurements.

A schema in `packages/contracts` becomes a DTO in `apps/api`, and the controller
is type-checked against it:

```ts
// apps/api/src/modules/quotes/quotes.dto.ts
import { metrikaDto } from '../../shared/http/zod-dto.js';
import { CreateQuoteRequest, QuoteResponse } from '@metrika/contracts';

export class CreateQuoteRequestDto extends metrikaDto(CreateQuoteRequest) {}
export class QuoteResponseDto extends metrikaDto(QuoteResponse) {}
```

```ts
// apps/api/src/modules/quotes/quotes.controller.ts
@Post()
@ZodResponse({ status: 202, type: QuoteResponseDto })
async create(@Body() body: CreateQuoteRequestDto): Promise<QuoteResponseDto> { … }
```

`packages/contracts` stays pure Zod — `createZodDto()` drags in a framework, and
the boundary rule there permits only `zod`. The DTO wrappers therefore live in
`apps/api`, next to the controllers that use them, and nothing outside `apps/api`
needs them because the client is generated from the emitted OpenAPI document
rather than from the wrapper objects.

**Two registrations, or response validation is off.** `metrikaDto()` passes
`{ codec: true }`, which is what makes `@ZodResponse` check the handler's return
against the schema's _output_ type — `.brand()` is output-only in Zod, so
without it a plain unbranded string satisfies a branded-ID response field and
ships. `@ZodResponse` then only ATTACHES metadata; the global
`{ provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor }` provider in
`AppModule` is what reads it and parses the response at request time. Either one
alone is silent. A lint rule makes `metrikaDto()` the only sanctioned
`createZodDto` call site, and `apps/api/test/health.integration.test.ts` plus
`apps/api/test/response-validation.test.ts` fail if either registration is
removed.

**The risk, stated plainly:** `@nestjs/swagger` drags `class-transformer` and
`class-validator` in as peers even though `nestjs-zod` replaces them for
validation, and neither library's default OpenAPI path emits a 3.1-versioned
document — the version is overridden by hand, in exactly one function that every
emitter calls.

**Why the risk is acceptable:** the source of truth is Zod, not `nestjs-zod`.
The DTO classes are one-line structural wrappers around schemas that would
survive unchanged. That is the same bounded migration cost ADR-0009 predicted,
and paying it once is the evidence that it stays bounded.

---

## 3. REST design

Base path `/api/v1`. Resource-oriented, plural nouns, nested only one level deep.

```
POST   /api/v1/organizations
GET    /api/v1/organizations/:organizationId/members
POST   /api/v1/organizations/:organizationId/invitations

GET    /api/v1/projects?cursor=&limit=&filter[status]=&sort=-createdAt
POST   /api/v1/projects
GET    /api/v1/projects/:projectId

POST   /api/v1/model-versions/upload-session
POST   /api/v1/upload-sessions/:uploadSessionId/complete
DELETE /api/v1/upload-sessions/:uploadSessionId
GET    /api/v1/model-versions/:modelVersionId
POST   /api/v1/model-versions/:modelVersionId/confirm-units
POST   /api/v1/model-versions/:modelVersionId/approve-repair
GET    /api/v1/model-versions/:modelVersionId/analysis
GET    /api/v1/model-versions/:modelVersionId/preview-url        → short-lived signed URL
GET    /api/v1/model-versions/:modelVersionId/events             → SSE

GET    /api/v1/materials
GET    /api/v1/print-profiles
POST   /api/v1/print-configurations/validate
POST   /api/v1/print-configurations/fit-check
POST   /api/v1/price-estimates                                   → isEstimate: true, never a Quote

POST   /api/v1/quotes
GET    /api/v1/quotes/:quoteId
GET    /api/v1/quotes/:quoteId/events                            → SSE
POST   /api/v1/quotes/:quoteId/accept

GET    /api/v1/orders/:orderId
POST   /api/v1/orders/:orderId/payment-intent
POST   /api/v1/webhooks/payments/:provider                       → unauthenticated, signature-verified
```

**Long-running operations return `202`** with the resource in its current state. The client then subscribes to SSE or polls. No HTTP request waits on geometry or slicing.

### Pagination

Cursor-based everywhere. Offset pagination is not offered — it is wrong under concurrent inserts and gets slower as tables grow.

```ts
export const CursorPaginationQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    pagination: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }),
  });
}
```

The cursor is an opaque base64 of `(sortValue, id)`, matching the `(organizationId, createdAt DESC, id)` index. The tie-break on `id` matters — without it, rows sharing a `createdAt` are skipped or duplicated.

**No endpoint returns an unbounded collection**, and no response embeds a deeply nested object graph. A quote response carries item summaries and identifiers; the client fetches details it needs. This is enforced by response schemas, so it cannot regress.

### Errors

```ts
export const ApiErrorResponse = z.object({
  error: z.object({
    code: DomainErrorCode,
    message: z.string(),               // localised, safe to display
    details: z.record(z.unknown()).optional(),
    requestId: z.string(),
    retryable: z.boolean(),
  }),
});
```

| Code                                                                                                                    | HTTP |
| ----------------------------------------------------------------------------------------------------------------------- | ---- |
| `VALIDATION_FAILED`, `INVALID_PRINT_CONFIGURATION`, `UNSUPPORTED_FILE_FORMAT`, `CHECKSUM_MISMATCH`, `MALICIOUS_ARCHIVE` | 400  |
| `UNAUTHENTICATED`                                                                                                       | 401  |
| `INSUFFICIENT_PERMISSIONS`                                                                                              | 403  |
| `MODEL_NOT_FOUND`, `QUOTE_NOT_FOUND`, `ORDER_NOT_FOUND`, `ROUTE_NOT_FOUND`                                              | 404  |
| `INVALID_STATE_TRANSITION`, `QUOTE_SUPERSEDED`, `IDEMPOTENCY_KEY_REUSED`                                                | 409  |
| `QUOTE_EXPIRED`                                                                                                         | 410  |
| `FILE_TOO_LARGE`, `MODEL_TOO_COMPLEX`                                                                                   | 413  |
| `UNITS_NOT_CONFIRMED`, `MODEL_NOT_READY`, `DOES_NOT_FIT_BUILD_VOLUME`, `MODEL_NOT_PRINTABLE`, `IMPLAUSIBLE_SCALE`       | 422  |
| `RATE_LIMITED`, `QUOTA_EXCEEDED`                                                                                        | 429  |
| `GEOMETRY_ANALYSIS_FAILED`, `SLICING_FAILED`, `PAYMENT_VERIFICATION_FAILED`                                             | 502  |
| `INTERNAL_ERROR`                                                                                                        | 500  |

This table is the whole closed union, and `apps/api`'s `DOMAIN_ERROR_RESPONSE` is a
`Record` over it, so a code added to `DomainErrorCode` without a row here fails `tsc`.
`ROUTE_NOT_FOUND` is the one code no domain operation throws: it is what the exception
filter reports for a framework 404, so that an unmatched route does not have to ship
under a code this table pins at 400.

**A framework rejection keeps the framework's status and takes only its code from us**, so
`VALIDATION_FAILED` is the one code that may appear at any 4xx. This is not a theoretical
path: Fastify raises `FST_ERR_BAD_URL` (400) for a malformed percent-escape and
`FST_ERR_MAX_PARAM_LENGTH` (414) on any route carrying a `:param`, both before a single
line of application code runs, and both before Nest's pipeline exists at all — they are
answered by the `frameworkErrors` handler rather than the exception filter. Reading the
status from the table instead would have shipped Fastify's own 415 and 414 as 400.

**An `HttpException` with a 5xx status is never described to the client.** It is reported
as `INTERNAL_ERROR` at 500 and logged. `HttpException` is the class every Nest library
throws — `@nestjs/terminus` signals an unhealthy check with `ServiceUnavailableException`
carrying per-indicator detail — and its `message` is written for an operator, not for a
customer.

**A known domain failure never returns 500.** A generic 500 for a condition the domain understands is a bug — it tells the client nothing and hides a real state from monitoring.

Stack traces never cross the boundary. Unexpected errors log at `error` with a Sentry event and return `INTERNAL_ERROR` with the `requestId`, which is the only thing a support conversation needs to find the full trace.

### Headers

| Header                  | Direction | Purpose                                                                           |
| ----------------------- | --------- | --------------------------------------------------------------------------------- |
| `Authorization: Bearer` | in        | Clerk JWT                                                                         |
| `X-Request-Id`          | both      | Client may supply; otherwise generated. Echoed on every response including errors |
| `Idempotency-Key`       | in        | Required on `POST /quotes/:id/accept` and payment intent creation                 |
| `X-Metrika-Org-Id`      | in        | A _claim_, always verified against membership. Never trusted                      |

---

## 4. The API client package

```ts
// packages/api-client
export function createMetrikaClient(config: ClientConfig): MetrikaClient;

export interface ClientConfig {
  readonly baseUrl: string;
  readonly getAccessToken: () => Promise<string | null>;
  readonly onUnauthenticated?: () => void;
  readonly requestIdFactory?: () => string;
  readonly retry?: RetryPolicy;    // idempotent methods only, exponential backoff + jitter
}
```

Responsibilities, so components never touch `fetch`:

- Injects the bearer token and a request ID on every call.
- Retries only idempotent methods (`GET`, `HEAD`, and explicitly-marked safe `POST`s), with backoff and jitter, never on `4xx`.
- Normalises every failure into a typed `MetrikaApiError` carrying `code`, `requestId` and `retryable` — so `error.code === 'QUOTE_EXPIRED'` is exhaustively switchable in the UI.
- Threads `AbortSignal` for cancellation.
- Exports TanStack Query hooks with consistent query keys and sensible `staleTime` per resource.

A lint rule forbids raw `fetch` in `apps/web/src/features/**`. There is one HTTP layer.

---

## 5. Crossing into Python

`packages/contracts` emits JSON Schema for the schemas the workers need (activity inputs/outputs, geometry results, slice metrics, unit interpretation), and `datamodel-code-generator` turns those into pydantic models committed under `apps/workers/packages/metrika_core/generated/`.

CI runs the emission and fails on `git diff --exit-code`. A TypeScript contract change that is not reflected in the Python models breaks the build immediately, at the point of change, rather than at runtime in a worker three weeks later.

This is deliberately a build-time artefact rather than a runtime dependency — the workers stay a pure Python project with no Node requirement in their image.

---

## 6. OpenAPI

Generated from the Zod DTOs by `@nestjs/swagger` + `nestjs-zod`, served at
`/api/v1/openapi.json`, with Scalar as the documentation UI. No generator in
this space emits a 3.1-versioned document by default, so the version must be
overridden explicitly — in exactly one `buildOpenApiDocument`, so a second
emitter added later cannot silently claim 3.0 while containing 3.1-only
constructs. See [ADR-0019](./adr/0019-nestjs-zod-contracts.md).

That function is `apps/api/src/openapi/build-document.ts`, and both consumers go
through it: `bootstrap.ts` builds the document once at boot and serves it, and
`apps/api/src/scripts/emit-openapi.ts` writes it to
`apps/api/openapi/openapi.json`, which is committed.

```bash
pnpm --filter @metrika/api openapi:emit
```

The emit script runs against the module graph, never against a running system:
it calls `NestFactory.create()` — which instantiates every provider, all
`SwaggerModule.createDocument` reads — and deliberately never calls
`app.init()`, whose lifecycle hooks include `PrismaService.onModuleInit`'s
`$connect()`. So emission needs **no reachable database**. `DATABASE_URL` and
`HEALTH_DEEP_TOKEN` still have to be present and well-formed, because
`ConfigModule` validates the environment while the graph is built; they do not
have to point at anything that exists.

`@ZodResponse` documents the one status it also enforces, so every other status
a route really answers is declared beside it with `@ApiResponse` — the probes'
503 is in the document for that reason. A route documented as 200-only generates
a client that models its real failure as an unmodelled error.

`apps/api/openapi/` is in `.prettierignore`. The document is machine-generated
with `JSON.stringify(doc, null, 2)` and diffed byte-for-byte; Prettier's
`printWidth: 100` collapses short arrays that `JSON.stringify` expands, so
leaving it formatted makes `format:check` and the diff gate disagree with the
emitter permanently.

CI diffs the generated spec against the committed baseline. A breaking change — a removed field, a narrowed type, a new required request property — fails the build unless the pull request carries an `api-breaking-change` label and updates the baseline. This is the mechanism that makes "do not break the client" a rule rather than an aspiration.

---

## 7. API versioning

`/api/v1` is in the path from day one. Since the only consumer is our own frontend, deployed together, v1 will live a long time. The policy for when a v2 becomes necessary:

- **Additive changes** (new optional fields, new endpoints, new enum values on responses) ship in v1.
- **Breaking changes** require v2 for the affected routes only. Under [ADR-0019](./adr/0019-nestjs-zod-contracts.md) that means a second controller and DTO set in `apps/api` mounted alongside the first — **not** two routers exported from `packages/contracts`, which imports nothing but `zod` and can hold neither `initContract().router()` nor `createZodDto()`. `packages/contracts` holds the schemas both versions parse against; the routes live in the app.
- A deprecated version is supported for 6 months after its successor ships, with `Deprecation` and `Sunset` headers.

New enum values are a subtle breaking change for a strict client, so response enums are typed as unions with a documented "unknown value" handling rule in the client — it surfaces unknown values rather than throwing.
