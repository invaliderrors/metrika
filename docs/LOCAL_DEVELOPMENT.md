# Metrika — Local Development

> Clone to a working end-to-end quote flow in five commands. Verified by CI on a clean checkout.

---

## 1. Prerequisites

| Tool   | Version                | Install                                                                   |
| ------ | ---------------------- | ------------------------------------------------------------------------- |
| mise   | latest                 | `curl https://mise.run \| sh` — manages Node and Python from `.mise.toml` |
| Node   | from `.nvmrc`          | `mise install`                                                            |
| Python | from `.python-version` | `mise install`                                                            |
| pnpm   | from `packageManager`  | `corepack enable`                                                         |
| uv     | latest                 | `curl -LsSf https://astral.sh/uv/install.sh \| sh`                        |
| Docker | 24+                    | Docker Desktop or OrbStack                                                |

`mise` is recommended over nvm + pyenv because a polyglot repository with two version managers has two ways to be subtly wrong. `.nvmrc` and `.python-version` are committed anyway so nobody is forced to adopt it.

---

## 2. Getting running

```bash
git clone git@github.com:<org>/metrika.git && cd metrika
mise install                    # Node + Python at the pinned versions
pnpm install                    # workspace dependencies
cp .env.example .env.local      # every value works out of the box for local dev

docker compose up -d            # postgres, redis, minio, temporal, temporal-ui, mailpit
pnpm db:migrate                 # apply migrations
pnpm db:seed                    # deterministic fixtures
pnpm dev                        # web + api + workflow worker + python workers
```

| Service       | URL                        | Notes                                 |
| ------------- | -------------------------- | ------------------------------------- |
| Web           | http://localhost:3000      |                                       |
| API           | http://localhost:3001      | OpenAPI at `/api/v1/openapi.json`     |
| API docs      | http://localhost:3001/docs | Scalar                                |
| Temporal UI   | http://localhost:8233      | Inspect and replay workflows          |
| MinIO console | http://localhost:9001      | `metrika` / `metrika-local`           |
| Mailpit       | http://localhost:8025      | Catches all outbound email            |
| Postgres      | localhost:5432             | `metrika` / `metrika` / `metrika_dev` |

Application code runs **on the host**, not in Docker. Compose provides only stateful dependencies. Running the API in a container for local development costs file-watching reliability and debugger attachment for no benefit.

---

## 3. Fakes by default

Local development uses deterministic fakes so the full flow works without heavyweight dependencies:

| Dependency | Local default                                                   | Real via                                                        |
| ---------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| Slicer     | `FakeSlicerEngine` — metrics derived from a hash of the request | `METRIKA_SLICER=real` + `docker compose --profile slicer up -d` |
| Payments   | `FakePaymentProvider` — deterministic success/failure by amount | Provider sandbox credentials in `.env.local`                    |
| Email      | Mailpit                                                         | —                                                               |
| Auth       | Clerk development instance                                      | —                                                               |
| Geometry   | **Real** — Trimesh runs natively; there is no reason to fake it | —                                                               |

`FakeSlicerEngine` is deterministic: the same request always produces the same metrics. This makes local quote prices stable and makes E2E assertions possible.

---

## 4. Seed data

Deterministic, fixed UUIDs, idempotent. `pnpm db:seed` can run repeatedly.

**Organizations**

- `Estudio Botero` (TEAM) — the primary fixture, with a full project and models in every state.
- `Ana Rodríguez` (PERSONAL) — a solo architect, for testing the personal-org path.

**Users** — one per role, all password-less through the Clerk dev instance:

| Email                   | Role                 |
| ----------------------- | -------------------- |
| `owner@metrika.test`    | Organization OWNER   |
| `admin@metrika.test`    | Organization ADMIN   |
| `member@metrika.test`   | Organization MEMBER  |
| `billing@metrika.test`  | Organization BILLING |
| `ana@metrika.test`      | Personal org only    |
| `platform@metrika.test` | PLATFORM_ADMIN       |
| `ops@metrika.test`      | OPERATIONS           |

**Manufacturing configuration** — three printer profiles (256³, 350³, and a large-format 500×500×500), four materials (PLA, PETG, ABS, TPU) each with colours, four print profiles (Borrador / Estándar / Alta definición / Maqueta fina), and one **published** pricing rule set with a full component chain plus a draft version for testing the publish flow.

**Models in every state** — this is the part that matters most, because these states are tedious to reach by hand:

| Model              | State                                                        |
| ------------------ | ------------------------------------------------------------ |
| `casa-botero-v1`   | `READY` — clean, watertight, full analysis and preview       |
| `torre-norte-v1`   | `READY` — with warnings (thin walls, overhangs)              |
| `edificio-ambiguo` | **`AWAITING_UNIT_CONFIRMATION`** — the path everyone forgets |
| `malla-abierta`    | `READY` — not watertight, volume `null`, blocking issue      |
| `modelo-enorme`    | `REJECTED` — exceeded triangle limit                         |
| `procesando`       | `ANALYZING` — stuck deliberately, for testing progress UI    |
| `fallido`          | `FAILED` — for testing the retry path                        |

Plus a `READY` quote, an `ACCEPTED` quote with an order in `AWAITING_PAYMENT`, and a `PAID` order with manufacturing jobs — so the order and manufacturing screens have content on first load.

---

## 5. Everyday commands

```bash
pnpm dev                       # everything
pnpm --filter @metrika/api dev # one app
pnpm verify                    # format + lint + typecheck + unit — the pre-push gate

pnpm test:unit                 # fast
pnpm test:integration          # Testcontainers; Docker must be running
pnpm test:e2e                  # Playwright
pnpm test:e2e --ui             # interactive

pnpm db:migrate                # create + apply a migration
pnpm db:reset                  # drop, migrate, seed — refuses in production
pnpm db:studio                 # Prisma Studio

pnpm contracts:emit            # regenerate JSON Schema + pydantic models
pnpm lint:fix
```

---

## 6. Debugging

**Workflows** — the Temporal UI at :8233 shows event history, inputs, outputs and failures for every workflow. Replay a failed workflow locally against modified code to reproduce a non-determinism error, which is otherwise the hardest class of bug here.

**API** — `pnpm --filter @metrika/api dev:debug` starts with `--inspect`; a `.vscode/launch.json` attach configuration is committed.

**Python workers** — `debugpy` is enabled in dev mode; the corresponding attach configuration is committed.

**Database** — `pnpm db:studio`, or connect directly. Note that RLS is active locally: a raw `psql` session sees nothing until `SET app.current_org_id`. This is intentional — local development should behave like production, and discovering RLS in staging is worse than discovering it on day one.

**SSE** — `curl -N -H "Authorization: Bearer <token>" localhost:3001/api/v1/model-versions/<id>/events` streams the raw events.

---

## 7. Common problems

| Symptom                                                | Cause                                      | Fix                                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cannot find module '@metrika/contracts'`              | Packages not resolved                      | `pnpm install`                                                                                                                                |
| Prisma client type errors after a schema edit          | Client not regenerated                     | `pnpm db:generate`                                                                                                                            |
| Integration tests hang                                 | Docker not running                         | Start Docker                                                                                                                                  |
| Temporal worker not picking up tasks                   | Namespace or task queue mismatch           | Check `.env.local`; confirm the worker registered in the Temporal UI                                                                          |
| Uploads fail with a signature error                    | MinIO path-style addressing                | `S3_FORCE_PATH_STYLE=true` in `.env.local`                                                                                                    |
| Empty query results in `psql`                          | RLS active                                 | `SET app.current_org_id = '<uuid>';`                                                                                                          |
| `exactOptionalPropertyTypes` errors on a Prisma update | Expected                                   | Use the conditional-spread pattern in [TYPESCRIPT_AND_TOOLING.md](./TYPESCRIPT_AND_TOOLING.md#the-exactoptionalpropertytypes--prisma-pattern) |
| Slicing never completes locally                        | Real slicer selected without its container | Unset `METRIKA_SLICER` or start the `slicer` compose profile                                                                                  |

---

## 8. Environment configuration

`.env.example` is committed with working local defaults for every key, and **CI verifies it is a superset of what the Zod schemas require** — so a fresh clone can never fail with an unexplained missing-variable error.

```bash
# .env.example (excerpt)
DATABASE_URL=postgresql://metrika:metrika@localhost:5432/metrika_dev
REDIS_URL=redis://localhost:6379
S3_ENDPOINT=http://localhost:9000
S3_BUCKET=metrika-local
S3_ACCESS_KEY_ID=metrika
S3_SECRET_ACCESS_KEY=metrika-local
S3_FORCE_PATH_STYLE=true
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE=default
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
METRIKA_SLICER=fake
METRIKA_PAYMENTS=fake
OTEL_EXPORTER_OTLP_ENDPOINT=            # empty locally — telemetry to console
LOG_LEVEL=debug
```

Configuration is read in exactly two files (`apps/api/src/config/env.ts`, `apps/web/src/config/env.ts`), each a Zod schema parsed at startup. A missing or malformed value crashes the process immediately with a readable list of what is wrong — never a mysterious `undefined` three layers into a request. A lint rule forbids `process.env` everywhere else.
