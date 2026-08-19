# Metrika — Local Development

> Target: clone to a working end-to-end quote flow in five commands, verified by CI on
> a clean checkout. **Not yet reachable** — there is no quote flow to run: `apps/api` is
> a health-probe skeleton, `apps/web` is a one-page localised shell that calls no API,
> and `apps/workers` has two worker processes that connect to Temporal and register one
> stub activity each — no geometry and no slicing. What is reachable today is a clean clone to a
> running API with a migrated database and a web shell that renders, and CI verifies
> that across five jobs (`verify`, `integration`, `web`, `openapi`, `contracts`). See §2.

---

## 1. Prerequisites

| Tool   | Version                | Install                                                                      |
| ------ | ---------------------- | ---------------------------------------------------------------------------- |
| mise   | latest                 | `curl https://mise.run \| sh` — manages Node, Python and uv from `mise.toml` |
| Node   | from `.nvmrc`          | `mise install`                                                               |
| Python | from `.python-version` | `mise install`                                                               |
| pnpm   | from `packageManager`  | `corepack enable`                                                            |
| uv     | from `mise.toml`       | `mise install`                                                               |
| Docker | 24+                    | Docker Desktop or OrbStack                                                   |

**Docker is not optional.** It runs the local stack (`pnpm infra:up`) _and_ every
integration test: `pnpm test:integration` starts its own Postgres through
Testcontainers — and, since Plan 0B-3, its own MinIO for `apps/workers` and its
own Temporal server (plus a second Postgres for it to store history in) for
`packages/testing` — and `packages/testing`'s preflight fails with a readable
`DockerUnavailableError` when no daemon is reachable rather than hanging. A
change to `packages/database`, `apps/api` or `apps/workers` cannot be verified
without it.

`pnpm verify` deliberately does **not** need Docker, on either side. The Python
storage suite is marked `integration` and deselected by `addopts` in
`apps/workers/pyproject.toml` for exactly that reason.

**The Python workers read `METRIKA_WORKER_*`, and the `_WORKER_` is
load-bearing.** `metrika_core.WorkerSettings` sets `extra="forbid"` over its
whole namespace, so an unrecognised variable in it is a startup error — right
for a typo, hostile over a prefix somebody else writes to. `METRIKA_` is shared:
`packages/testing` publishes `METRIKA_TEST_DATABASE_URL`, and measured under the
wider prefix, a shell that had run the Node integration harness could not
construct worker settings at all. The seven variables are documented in
`.env.example`; none of them is a database URL, and none ever will be
(ADR-0007).

`mise` is recommended over nvm + pyenv because a polyglot repository with two version managers has two ways to be subtly wrong. `.nvmrc` and `.python-version` are committed anyway so nobody is forced to adopt it.

**`uv` is no longer a `curl | sh` install**, and the change is not cosmetic: [ADR-0027](./adr/0027-python-toolchain.md)'s spike found `uv` on that machine reachable only through a _global_ `~/.config/mise/config.toml` carrying `uv = "latest"` — an unpinned, unreviewed, per-machine version that no checkout reproduces. `mise.toml` now pins it exactly (`uv = "0.12.3"`), which is what makes `uv.lock` mean the same thing on a second machine. Without `mise` on `PATH`, `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm format` and `pnpm format:check` all fail in `apps/workers` with `uv: command not found`; a project-local install of the same version works too, but a global `latest` is the thing to avoid.

---

## 2. Getting running

Working today, in this order — every line below runs on a fresh clone:

```bash
git clone git@github.com:<org>/metrika.git && cd metrika
mise install                    # Node + Python + uv at the pinned versions
pnpm install --frozen-lockfile  # workspace dependencies
cp .env.example .env            # every value works out of the box for local dev
                                # `.env` is the ONLY local environment file — see §8

pnpm infra:up                   # postgres, redis, minio, temporal, temporal-ui,
                                # mailpit — waits for healthy
pnpm db:deploy                  # apply committed migrations (prisma migrate deploy)
pnpm dev                        # every runtime that exists: apps/api on API_PORT
                                # (3001) and apps/web on 3000. One at a time:
                                #   pnpm --filter @metrika/api dev
                                #   pnpm --filter @metrika/web dev

pnpm verify                     # the pre-push gate
pnpm test:integration           # Testcontainers; needs Docker, not `infra:up`
```

`pnpm dev` covers the two Node runtimes; the Python workers join it in Plan
0B-3. `pnpm db:seed` does not exist yet. `pnpm db:migrate`
(`prisma migrate dev`) is for authoring a new migration; `pnpm db:deploy` is
what a fresh clone wants.

`WEB_PORT` reaches `pnpm dev`, and it takes two mechanisms to do it.
`apps/web`'s `dev` script runs `scripts/next.mjs`, which reads it,
turbo runs in strict env mode and drops any variable a task does not declare —
measured, a task sees both `NEXT_PUBLIC_` keys and not `WEB_PORT` — so
`turbo.json`'s `dev` task declares it, and `scripts/turbo.mjs` is what loads
`.env` in the first place. Remove either and the value goes inert with no error.

Two paths still bypass `.env` and need it **exported**:
`pnpm --filter @metrika/web start`, which loads nothing, and
`pnpm --filter @metrika/web test:e2e` — `playwright.config.ts` builds every URL
from `WEB_PORT`, and neither pnpm nor Playwright reads `.env`.
That one bites rather than merely fails: `reuseExistingServer` is on outside CI,
so a default-port run on a machine where something else holds 3000 adopts that
server and grades it.

| Service         | URL                        | Notes                                                                    |
| --------------- | -------------------------- | ------------------------------------------------------------------------ |
| Web             | http://localhost:3000      | The localised shell — one page, no API calls yet                         |
| API             | http://localhost:3001      | `/health/{live,ready,deep}` and `/api/v1/openapi.json` today             |
| API docs        | http://localhost:3001/docs | Scalar — not mounted yet                                                 |
| Temporal UI     | http://localhost:8233      | Workflow history; no workflows exist yet                                 |
| Temporal (gRPC) | localhost:7233             | Namespace `default`; what a worker or client dials                       |
| MinIO console   | http://localhost:9001      | `metrika` / `metrika-local`                                              |
| Mailpit         | http://localhost:8025      | Catches all outbound email                                               |
| Postgres        | localhost:5432             | `metrika` / `metrika` / `metrika_dev`; the API connects as `metrika_app` |

Every port in that table is a **default**, not a fixture. A host port is shared
with the whole machine, and a native Postgres service or a second project's
compose stack owning one fails `pnpm infra:up` with `address already in use` and
no indication of whose it is. So each published port in
`infra/docker/docker-compose.yml` reads `${*_HOST_PORT:-<default>}` and `.env`
carries the eight knobs at their defaults — `POSTGRES_HOST_PORT`,
`REDIS_HOST_PORT`, `MINIO_HOST_PORT`, `MINIO_CONSOLE_HOST_PORT`,
`TEMPORAL_HOST_PORT`, `TEMPORAL_UI_HOST_PORT`, `MAILPIT_SMTP_HOST_PORT`,
`MAILPIT_UI_HOST_PORT`. Container ports never move, so nothing on the compose
network is affected.

**Nothing is derived.** Moving a port does not move the URL that names it:
`DATABASE_URL`, `DATABASE_ADMIN_URL`, `REDIS_URL`, `S3_ENDPOINT` and `SMTP_URL`
each carry their own copy, and `API_PORT`/`WEB_PORT` are separate again. Change
both halves in the same edit.

`.env` reaches compose only through `scripts/compose.mjs` (`node
--env-file-if-exists=.env`), which the `infra:*` scripts run. Compose's own
`--env-file` defaults to the **project directory** — `infra/docker/`, because
`-f` names a file there — so the repository root's `.env` is invisible to it
otherwise. Passing `-f` also disables compose's automatic
`docker-compose.override.yml` pickup, which is why the knobs live in the
committed file rather than in a per-machine override.

The Temporal service is `temporalio/auto-setup`, which stores its history and
visibility data in the **same Postgres** as the application, in two databases it
creates itself on first boot: `temporal` and `temporal_visibility`. They are not
Prisma-managed and no migration in this repository knows about them.
`pnpm infra:reset` drops them along with everything else, and the next
`infra:up` re-creates them from scratch — that is the supported way to get a
clean workflow history. It is a local-development image only; production is
Temporal Cloud ([ADR-0006](./adr/0006-temporal.md)).

Every published port binds to `127.0.0.1`, not `0.0.0.0` — Docker's publish path
inserts firewall rules that would otherwise expose Postgres and the MinIO console
to the whole LAN.

Application code runs **on the host**, not in Docker. Compose provides only stateful dependencies. Running the API in a container for local development costs file-watching reliability and debugger attachment for no benefit.

---

## 3. Fakes by default

_Nothing in this section exists yet — the fakes land with the subsystems they stand in for (Phases 2, 3, 6 and 9). Mailpit is the exception: it is already in `docker-compose.yml`._

Local development uses deterministic fakes so the full flow works without heavyweight dependencies:

| Dependency | Local default                                                   | Real via                                                        |
| ---------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| Slicer     | `FakeSlicerEngine` — metrics derived from a hash of the request | `METRIKA_SLICER=real` + `docker compose --profile slicer up -d` |
| Payments   | `FakePaymentProvider` — deterministic success/failure by amount | Provider sandbox credentials in `.env`                          |
| Email      | Mailpit                                                         | —                                                               |
| Auth       | Clerk development instance                                      | —                                                               |
| Geometry   | **Real** — Trimesh runs natively; there is no reason to fake it | —                                                               |

`FakeSlicerEngine` is deterministic: the same request always produces the same metrics. This makes local quote prices stable and makes E2E assertions possible.

---

## 4. Seed data

_`pnpm db:seed` does not exist yet — it arrives with the entities below, from Phase 1 onward. The initial migration creates one `RlsProbe` table and nothing else. This section is the target shape._

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
pnpm dev                       # apps/api + apps/web
pnpm verify                    # format:check + build + lint + typecheck + unit — the pre-push gate
pnpm build                     # tsc -b per package + next build, topological through Turbo

pnpm test:unit                 # fast, and needs no Docker on either side
pnpm test:integration          # Testcontainers — Postgres, MinIO and Temporal; Docker must
                               # be running

pnpm infra:up                  # start postgres, redis, minio, temporal, temporal-ui and
                               # mailpit, and wait for healthy
pnpm infra:down                # stop them, keeping the volumes
pnpm infra:reset               # stop them AND drop the volumes — this is what re-runs
                               # packages/database/sql/00-app-role.sql on a fresh Postgres

pnpm db:generate               # regenerate the Prisma client
pnpm db:migrate                # create + apply a migration (prisma migrate dev)
pnpm db:deploy                 # apply committed migrations (prisma migrate deploy)
pnpm db:reset                  # drop and re-migrate — destructive
pnpm db:studio                 # Prisma Studio, on :51212 — Prisma 7's default port.
                               # It was :5555 through Prisma 6; a bookmark from then
                               # will now hit nothing.

pnpm --filter @metrika/api openapi:emit  # regenerate apps/api/openapi/openapi.json
pnpm lint:fix
```

**Run every `db:*` command from the repository root.** They go through
`scripts/prisma.mjs`, which loads the root `.env` and passes `--schema`
explicitly. `cd packages/database && pnpm exec prisma migrate deploy` fails with

```
Failed to load config file ".../packages/database" as a TypeScript/JavaScript module.
Error: PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_ADMIN_URL.
```

**Prisma 7 does no dotenv loading at all** — not beside the schema, not in the
cwd, not at the repository root. The root `.env` reaches Prisma only because the
`db:*` scripts are `node --env-file-if-exists=.env scripts/prisma.mjs …`, and
nothing else in the chain would put it there. The error above comes from
`prisma.config.ts` resolving `env('DATABASE_ADMIN_URL')`, before any database is
contacted — a different subsystem from Prisma 6's `Environment variable not
found`, which is unreachable on 7. See [ADR-0037](./adr/0037-prisma-7-driver-adapter.md).

**`pnpm build`, `pnpm dev`, `pnpm test:unit` and `pnpm test:integration` load the
root `.env`**, through `scripts/turbo.mjs` (`node --env-file-if-exists=.env`).
All four can end up running `next build` or `next dev` — the two test tasks
because they declare `dependsOn: ["^build", "build"]`, which schedules
`@metrika/web#build` — and `src/app/layout.tsx` imports `clientEnv`, which parses
at module scope. So a missing `NEXT_PUBLIC_` key fails the **build**, by name —
measured, with both unset:

```
Error: Failed to collect configuration for /_not-found
  [cause]: Error [ZodError]: [
    { "path": ["NEXT_PUBLIC_API_BASE_URL"],    "message": "Invalid input: expected string, received undefined" },
    { "path": ["NEXT_PUBLIC_DEFAULT_LOCALE"], "message": "Invalid option: expected one of \"es-CO\"|\"en-US\"" }
  ]
      at module evaluation (src/config/env.ts:95:53)
      at module evaluation (src/app/layout.tsx:104:1)
```

That is the intended behaviour, not a papercut — a misconfigured deployment must
fail at build rather than on a visitor's first render. `cp .env.example .env`
supplies both. CI has no `.env` and sets them at the workflow level instead;
`--env-file-if-exists` is what makes the absent file fine, and a real environment
variable wins over the file, so both paths behave identically.

The Playwright suite is **package-scoped**, not a root script:

```bash
pnpm --filter @metrika/web exec playwright install chromium   # once, per machine
pnpm --filter @metrika/web test:e2e
```

It starts its own server — `pnpm build && pnpm start` in `apps/web`, on
`127.0.0.1:$WEB_PORT` (3000 by default) — rather than assuming one is up, and it
supplies the two `NEXT_PUBLIC_` keys itself, so no `.env` is needed for it. A
production build, not `next dev`: dev-mode hydration and CSS delivery differ
enough that a green dev run says nothing about what ships.

`WEB_PORT` is read from the **shell**, not from `.env` — neither
pnpm nor Playwright loads that file. On a machine where those ports are moved,
export them for this command or the suite runs against the defaults:

```bash
WEB_PORT=3100 pnpm --filter @metrika/web test:e2e
```

One thing to know before trusting a red-to-green cycle: `reuseExistingServer` is
on outside CI, so a `pnpm dev` you forgot about on that port will be used as-is
and will serve an old build. If a change does not show up, kill that first. The
worse version of the same mechanism is why the ports are variables at all: if
some **other** project holds the port, its server is adopted and graded, and
every assertion is about an application this repository has never seen.

There is deliberately no root `pnpm test:e2e`: it would put a browser download in
the path of `pnpm verify`, which is what everyone runs before every push. CI pays
that cost instead — the **`web` job** installs chromium
(`playwright install --with-deps chromium`) and runs this suite on every pull
request, after a full `pnpm build`.

That `pnpm build` is load-bearing there, and worth knowing locally too:
Playwright's `webServer` runs apps/web's OWN `pnpm build`, a bare `next build`,
which builds that package and nothing else. On a tree that has never been built,
`test:e2e` therefore dies inside `webServer.command` with
`src/lib/formatting/money.ts(1,38): error TS2307: Cannot find module
'@metrika/contracts'`, and Playwright reports only "Process from
config.webServer was not able to start". Run `pnpm build` from the root first.

`pnpm contracts:emit` regenerates the committed pydantic models from the Zod
schemas — run it after touching `packages/contracts` and commit the result, or
CI's `contracts` job fails on the diff. It needs `uv` on `PATH` and nothing else;
it builds `@metrika/contracts` itself. `pnpm db:seed` arrives in Plan 0B-3.

---

## 6. Debugging

Everything in this section except **Database** describes a runtime that does not
exist yet. It is kept as the intended shape, marked for what it is.

**Workflows** — the Temporal UI at :8233 shows event history, inputs, outputs and failures for every workflow. Replay a failed workflow locally against modified code to reproduce a non-determinism error, which is otherwise the hardest class of bug here. The server and the UI are in `docker-compose.yml` as of Plan 0B-3; there is no workflow to look at yet, so today it is an empty `default` namespace that proves the stack is wired.

A container that stays `Up` while logging `Waiting for PostgreSQL` forever means `DB_PORT` was dropped from the `temporal` service — it defaults to **3306**, MySQL's port. `docker ps` shows a healthy-looking container and `docker compose up -d` returns 0, so the first symptom is a worker connection timeout with nothing obviously broken upstream.

That service takes **six** environment variables, and they are recorded across two ADRs rather than one: [ADR-0027](./adr/0027-python-toolchain.md) has five and states that count as complete, and [ADR-0028](./adr/0028-temporal-bind-on-ip.md) corrects it with the sixth, `BIND_ON_IP`. Read both. The sixth is the one behind the other confusing failure here — a `temporal` container that is permanently `unhealthy` while its own logs show a server serving normally means `BIND_ON_IP` is missing, so the server bound one arbitrary interface and the loopback healthcheck can never reach it.

**API** — `pnpm --filter @metrika/api dev` runs `tsc -b --watch` alongside `node --watch dist/main.js`, reading the root `.env`. A `dev:debug` script and a committed `.vscode/launch.json` attach configuration are intended and do not exist yet; until then, `node --inspect --env-file=.env dist/main.js` from `apps/api` is the equivalent.

**Python workers** — `pnpm dev` does not start them yet. Run one by hand with the compose stack up:

```bash
cd apps/workers
METRIKA_WORKER_TEMPORAL_TASK_QUEUE=geometry-small METRIKA_WORKER_S3_BUCKET=metrika-models \
  uv run --locked --all-packages python -m metrika_geometry
```

Both processes refuse to start without those two variables rather than defaulting — a worker polling a queue nobody publishes to looks exactly like an idle system. `Ctrl-C` (or SIGTERM) shuts one down gracefully; ignoring SIGTERM would mean every deploy killing a worker mid-poll, so `metrika_core.temporal.run_worker` handles it.

**Telemetry needs no local collector.** `METRIKA_WORKER_OTLP_ENDPOINT` is unset by default and no exporter is constructed without it, so a worker run this way emits spans nowhere and still writes `requestId`, `traceId` and `spanId` onto every log line inside an activity — those come from the live OpenTelemetry context, not from an exporter. Set the variable only when there is something listening on `/v1/traces`.

_(Plan 0B-3, intended and not yet done)_ — `debugpy` in dev mode, with the corresponding attach configuration committed.

**Database** — `pnpm db:studio`, or connect directly. Note that RLS is active locally: a `psql` session **as `metrika_app`** sees nothing until `SET app.current_org_id`. This is intentional — local development should behave like production, and discovering RLS in staging is worse than discovering it on day one. `metrika`, the owner role the compose stack creates and that migrations run as, is a Postgres superuser and therefore bypasses RLS unconditionally — which is exactly why `DATABASE_URL` names `metrika_app` and only `DATABASE_ADMIN_URL` names `metrika`. Connect as `metrika` and you are not testing what production does. Both halves are asserted against a live connection rather than trusted: `packages/database/test/harness.integration.test.ts` checks that `metrika_app` is neither `SUPERUSER` nor `BYPASSRLS`, and `packages/database/test/rls.integration.test.ts` checks that `relforcerowsecurity` is actually set on the applied table.

**SSE** _(Phase 3)_ — `curl -N -H "Authorization: Bearer <token>" localhost:3001/api/v1/model-versions/<id>/events` streams the raw events.

---

## 7. Common problems

| Symptom                                                                                                                                                              | Cause                                                                                                                                                                                 | Fix                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Cannot find module '@metrika/contracts'`                                                                                                                            | Packages not resolved, or not built                                                                                                                                                   | `pnpm install`, then `pnpm build` — the package resolves to `dist/`, not `src/`                                                                                                                  |
| `Cannot find module '@prisma/client'` from `pnpm --filter @metrika/database build`                                                                                   | That command bypasses turbo's graph, and the build script no longer generates the client — `turbo.json`'s `db:generate` task is the sole writer, deliberately                         | Run `pnpm db:generate` first, or use the root `pnpm build`. The reason is in `turbo.json` above `db:generate`                                                                                    |
| Prisma client type errors after a schema edit                                                                                                                        | Client not regenerated                                                                                                                                                                | `pnpm db:generate`                                                                                                                                                                               |
| `pnpm install` exits 1 with `ERR_PNPM_IGNORED_BUILDS`                                                                                                                | A new dependency has an install script                                                                                                                                                | Add it to `allowBuilds` in `pnpm-workspace.yaml`                                                                                                                                                 |
| `PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_ADMIN_URL`                                                                                      | A Prisma command was run from inside `packages/database`                                                                                                                              | Use the root `pnpm db:*` scripts — Prisma 7 loads no `.env` at all, so `--env-file-if-exists` in those scripts is the only thing that sets it                                                    |
| `Cyclic dependency detected` from Turbo                                                                                                                              | Something added `@metrika/database` to `packages/testing`                                                                                                                             | Remove it; the dependency runs one way only — `database` and `api` depend on `testing`, never the reverse                                                                                        |
| Integration tests hang                                                                                                                                               | Docker not running                                                                                                                                                                    | Start Docker                                                                                                                                                                                     |
| Integration tests fail with `Port mapping for container … is not available`, then a cascade of `409 … container name "/testcontainers-ryuk-…" is already in use`     | Docker published the port after testcontainers read it. `metrika_core`'s `conftest.py` patches `DockerClient.port` to wait for the binding; the comment there carries the measurement | If it recurs, check no reaper survived an interrupted run: `docker ps -aq --filter name=testcontainers-ryuk`, then `docker rm -f` each — its name carries a session id a later run collides with |
| Temporal worker not picking up tasks                                                                                                                                 | Namespace or task queue mismatch                                                                                                                                                      | Check `.env`; confirm the worker registered in the Temporal UI                                                                                                                                   |
| Uploads fail with a signature error                                                                                                                                  | MinIO path-style addressing                                                                                                                                                           | `S3_FORCE_PATH_STYLE=true` in `.env`                                                                                                                                                             |
| Empty query results in `psql`                                                                                                                                        | RLS active                                                                                                                                                                            | `SET app.current_org_id = '<uuid>';`                                                                                                                                                             |
| `exactOptionalPropertyTypes` errors on a Prisma update                                                                                                               | Expected                                                                                                                                                                              | Use the conditional-spread pattern in [TYPESCRIPT_AND_TOOLING.md](./TYPESCRIPT_AND_TOOLING.md#the-exactoptionalpropertytypes--prisma-pattern)                                                    |
| Slicing never completes locally                                                                                                                                      | Real slicer selected without its container                                                                                                                                            | Unset `METRIKA_SLICER` or start the `slicer` compose profile                                                                                                                                     |
| `infra:up` fails with `address already in use`, or with Docker Desktop's `bind: An attempt was made to access a socket in a way forbidden by its access permissions` | A native service or another project's compose stack already owns that host port                                                                                                       | Move it with the matching `*_HOST_PORT` in `.env` (§2), and change the URL that names it in the same edit. `docker ps --format '{{.Names}}\t{{.Ports}}'` finds the other owner                   |
| E2E passes against changes that are not in the build, or asserts against a page you do not recognise                                                                 | `reuseExistingServer` adopted a server that was already on the port                                                                                                                   | Export `WEB_PORT` before `pnpm --filter @metrika/web test:e2e` — Playwright reads neither `.env` nor turbo's environment                                                                         |

---

## 8. Environment configuration

`.env` is the **only** local environment file. There is no `.env.local`: the
Prisma CLI loads `.env` natively through `scripts/prisma.mjs`, and the API is
started with `node --env-file=.env`. A second file would be a second way to be
wrong.

`.env.example` is committed with working local defaults for every key, and
**both apps assert it is a superset of what their Zod schema requires** —
`apps/api/test/env-example.test.ts` and `apps/web/test/env-example.test.ts` — so
a fresh clone can never fail with an unexplained missing-variable error. They are
unit tests, so they run in `pnpm verify`; letting `.env.example` drift fails the
build rather than the next new clone.

```bash
# .env.example (excerpt) — see the file itself for the authoritative list
NODE_ENV=development
API_PORT=3001
LOG_LEVEL=debug
HEALTH_DEEP_TOKEN=local-health-deep-token

# Two URLs, two roles, deliberately: the API connects as metrika_app, which is
# NOSUPERUSER NOBYPASSRLS so RLS actually applies to it. Migrations connect as
# the owner; prisma.config.ts names DATABASE_ADMIN_URL — schema.prisma carries
# no datasource url on Prisma 7. No `?schema=public`: the
# Prisma 7 driver adapter never sees that parameter, so it is inert — select a
# non-public schema with `new PrismaPg(url, { schema })` instead (ADR-0037).
DATABASE_URL=postgresql://metrika_app:metrika_app@localhost:5432/metrika_dev
DATABASE_ADMIN_URL=postgresql://metrika:metrika@localhost:5432/metrika_dev

# --- Local infrastructure host ports ---
# Read only by infra/docker/docker-compose.yml, through scripts/compose.mjs.
# Every value is the documented default; override one when the port is already
# owned on this machine, and change the URL that names it in the same edit —
# nothing here is derived. See §2.
POSTGRES_HOST_PORT=5432
REDIS_HOST_PORT=6379
MINIO_HOST_PORT=9000
MINIO_CONSOLE_HOST_PORT=9001
TEMPORAL_HOST_PORT=7233
TEMPORAL_UI_HOST_PORT=8233
MAILPIT_SMTP_HOST_PORT=1025
MAILPIT_UI_HOST_PORT=8025

# --- Web ---
# WEB_PORT is expanded in the shell by apps/web's own scripts. `pnpm dev` honours
# it (turbo.json's `dev` task declares it); `pnpm --filter @metrika/web start`
# and `test:e2e` need it EXPORTED. See §2. Both NEXT_PUBLIC_ keys are read at
# module scope and are what `next build` fails without.
WEB_PORT=3000
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
NEXT_PUBLIC_DEFAULT_LOCALE=es-CO

# --- Telemetry ---
# All four are read and all four default to OFF, which is the point: an empty
# OTLP endpoint constructs no exporter at all, and an empty SENTRY_DSN builds a
# Sentry client with ZERO integrations. Correlation does not depend on either —
# `requestId`, `traceId` and `spanId` come from the live trace context, so they
# are on every log line whether or not anything is exported.
SENTRY_DSN=
OTLP_TRACES_ENDPOINT=
TRACES_SAMPLE_RATE=1
NEXT_PUBLIC_SENTRY_DSN=

# --- Workers --- (METRIKA_WORKER_*; the OTLP one is commented out in the file)
# METRIKA_WORKER_OTLP_ENDPOINT=http://localhost:4318/v1/traces

# Present in docker compose, wired up in later plans
REDIS_URL=redis://localhost:6379
S3_ENDPOINT=http://localhost:9000
S3_BUCKET=metrika-local
S3_FORCE_PATH_STYLE=true
SMTP_URL=smtp://localhost:1025
```

Both `SENTRY_DSN` keys are safe to populate: each Sentry client runs the shared
redaction walk in its `beforeSend`, so an event is cleaned before it leaves the
process — see [OBSERVABILITY.md](./OBSERVABILITY.md#the-sinks-counted--there-are-four-and-all-four-are-controlled).
Empty is still the default, because a local run has nothing to send events to.

Note what an empty DSN costs you as a local signal, since it is not obvious:
`@sentry/node` constructs **no integrations at all** for a client with no DSN, so
running locally with it empty tells you nothing about how Sentry behaves — the
integration suite runs against a local sink for exactly that reason.

Configuration is read in exactly two files — `apps/api/src/config/env.ts` and `apps/web/src/config/env.ts`, both of which now exist. Each is a Zod schema parsed at startup. A missing or malformed value crashes the process immediately with a readable list of what is wrong — never a mysterious `undefined` three layers into a request. A lint rule forbids `process.env` everywhere else; `apps/web/playwright.config.ts` carries the single narrow exemption, documented in the file and in `apps/web/eslint.config.js`, because a Playwright config has to load with no environment at all.
