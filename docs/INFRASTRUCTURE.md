# Metrika — Infrastructure, Deployment & Cost

> Docker, Terraform, AWS, CI/CD, migrations, backups and a cost model. No manual console configuration, ever.

---

## 1. Docker

Three images. All multi-stage, non-root, pinned by digest, no build tooling in the runtime layer.

None of these Dockerfiles exist yet — they are written in Plan 0D. The
production image tag tracks the toolchain major pinned in `.nvmrc` (24), and is
pinned by digest in the Dockerfile that Plan 0D writes — the tag here names the
major, the digest there names the bytes.

### API

```dockerfile
FROM node:24-bookworm-slim@sha256:<digest> AS base
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/*/package.json packages/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @metrika/database generate \
 && pnpm --filter @metrika/api build \
 && pnpm deploy --filter @metrika/api --prod /out

FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://localhost:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["dumb-init","--"]
CMD ["node","dist/main.js"]
```

`pnpm deploy --prod` produces a self-contained output directory with production dependencies only — no workspace symlinks, no dev tooling, no source. Prisma engine binaries are copied explicitly, because a missing engine at runtime is a confusing failure.

### Geometry worker

```dockerfile
FROM python:3.12-slim-bookworm@sha256:<digest> AS base
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

FROM base AS deps
WORKDIR /app
COPY apps/workers/pyproject.toml apps/workers/uv.lock ./
COPY apps/workers/packages/metrika_core/pyproject.toml packages/metrika_core/
COPY apps/workers/geometry/pyproject.toml geometry/
RUN uv sync --frozen --no-dev --package metrika-geometry

FROM base AS runtime
WORKDIR /app
COPY --from=deps /app/.venv /app/.venv
COPY apps/workers/packages/metrika_core ./packages/metrika_core
COPY apps/workers/geometry ./geometry
RUN useradd --system --uid 10001 --no-create-home metrika
USER 10001
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
ENTRYPOINT ["python","-m","metrika_geometry.worker"]
```

Runtime task definition adds: `readonlyRootFilesystem: true`, a `tmpfs` scratch mount with a size cap, `cap_drop: ALL`, `no-new-privileges`, and memory/CPU limits per queue.

### Slicer worker

Same shape, plus the OrcaSlicer binary extracted from a checksum-verified AppImage, and `infra/docker/slicer/PROVENANCE.md` recording the upstream version, source URL, image digest and an unmodified-binary attestation — see [SLICING.md](./SLICING.md#3-licensing--an-open-launch-blocking-question).

---

## 2. AWS architecture

```mermaid
graph TB
    subgraph Internet
        CF[CloudFront<br/>signed URLs · previews only]
        V[Vercel — apps/web]
    end
    subgraph VPC["VPC 10.0.0.0/16"]
        subgraph Public["Public subnets"]
            ALB[Application Load Balancer]
        end
        subgraph Private["Private subnets — no NAT"]
            API[ECS Fargate: api<br/>on-demand · min 1]
            WRK[ECS Fargate: api-workflow-worker]
            GEO[ECS Fargate: geometry-worker<br/>small + large]
            SLC[ECS Fargate: slicer-worker<br/>SPOT]
        end
        subgraph Data["Isolated subnets"]
            RDS[(RDS PostgreSQL 16<br/>encrypted · PITR)]
            RED[(ElastiCache Redis)]
        end
        VPCE[VPC Endpoints<br/>S3 · ECR · Secrets · Logs · KMS]
    end
    S3[(S3)]
    TC[Temporal Cloud]

    V -->|"REST · bearer JWT"| ALB
    CF --> S3
    ALB --> API
    API --> RDS
    API --> RED
    API --> VPCE --> S3
    API -.->|mTLS| TC
    WRK -.-> TC
    GEO -.-> TC
    SLC -.-> TC
    GEO --> VPCE
    SLC --> VPCE
```

**VPC endpoints instead of a NAT Gateway.** This is both the primary security control for the workers (no internet egress at all) and the single largest cost saving available in a small AWS footprint — a NAT Gateway is roughly $32/month plus per-GB processing before it moves a single useful byte. Only the Temporal Cloud connection needs egress, handled by a narrow route rather than a general-purpose NAT.

| Service                           | Configuration                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| ECS Fargate `api`                 | 0.5 vCPU / 1 GB, min 1 / max 4, target-tracking on CPU and ALB request count                                                    |
| ECS Fargate `api-workflow-worker` | Separate service, same image, different command. Isolates workflow processing from HTTP                                         |
| ECS Fargate `geometry-worker`     | Two services: small (1 vCPU / 2 GB) and large (2 vCPU / 8 GB), scaled on Temporal queue depth                                   |
| ECS Fargate `slicer-worker`       | 2 vCPU / 4 GB, **Fargate Spot**, scaled on queue depth                                                                          |
| RDS                               | `db.t4g.small` staging (single-AZ), `db.t4g.medium` production (Multi-AZ), gp3, encrypted with a CMK, deletion protection, PITR |
| PgBouncer                         | Sidecar in transaction mode — Fargate scaling multiplies Prisma's per-process pool quickly                                      |
| ElastiCache                       | `cache.t4g.micro`; deferred until the rate limiter needs it                                                                     |
| S3                                | Versioning on `originals/`, Intelligent-Tiering, lifecycle rules per prefix, Block Public Access                                |
| Secrets Manager                   | All secrets; injected as ECS task secrets, never as plain environment variables                                                 |
| KMS                               | Separate CMKs for S3 originals, RDS and Secrets Manager                                                                         |
| CloudFront                        | Preview derivatives only, signed URLs, OAC to S3                                                                                |

**Temporal Cloud rather than self-hosted.** Self-hosting means running frontend, history, matching and worker services plus Cassandra or a large Postgres. The trade-off is a monthly bill and a dependency outside the VPC; the alternative is a platform team. See [ADR-0006](./adr/0006-temporal.md).

**Vercel for `apps/web` rather than ECS.** Better RSC support, preview deployments per pull request, edge caching, and no container to operate for the frontend. The cost is two deploy surfaces, two secret stores and a cross-origin API — the last of which is neutralised by using bearer tokens rather than cookies ([SECURITY.md](./SECURITY.md#4-authentication-and-session-security)). Revisit if the split becomes a genuine operational drag.

---

## 3. Terraform

```
infra/terraform/
├── modules/
│   ├── network/          # VPC, subnets, endpoints, security groups
│   ├── database/         # RDS, parameter group, PgBouncer, backups
│   ├── cache/            # ElastiCache
│   ├── storage/          # S3 buckets, lifecycle, CloudFront, OAC
│   ├── ecs-cluster/      # cluster, capacity providers, execution roles
│   ├── ecs-service/      # reusable service: task def, autoscaling, logs, alarms
│   ├── secrets/          # Secrets Manager, KMS
│   ├── observability/    # alarms, dashboards, OTLP egress
│   └── github-oidc/      # deploy roles, no long-lived keys
├── envs/
│   ├── staging/          # separate AWS account, own state
│   └── production/       # separate AWS account, own state
└── shared/               # ECR, state bucket, DNS, OIDC provider
```

- **Separate AWS accounts** for staging and production. Account boundaries are the strongest available blast-radius control, and AWS Organizations makes them free.
- State in S3 with DynamoDB locking, versioned, encrypted, in the `shared` account.
- Every module is versioned; environments differ only by `tfvars`. If staging and production diverge structurally, staging stops being a test of production.
- `terraform plan` runs on every pull request touching `infra/` and posts the plan as a comment. `apply` requires an approved merge to `main` and a manual gate for production.
- **No manual console changes.** Drift detection runs nightly and opens an issue on any difference. A hand-edited resource is an outage waiting for the next apply.

---

## 4. CI/CD

`.github/workflows/ci.yml` — **what runs today**, on every pull request and on
pushes to `main`:

| Job           | Runs                                                                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify`      | `pnpm install --frozen-lockfile` · `format:check` · `build` · `lint` (`--max-warnings=0`) · `typecheck` · `test:unit` · the two suppression greps                                                         |
| `integration` | `pnpm build` then `pnpm test:integration` — Testcontainers starts its own Postgres, so there is no `services:` block and no `docker compose up`                                                           |
| `web`         | `pnpm build` · `playwright install --with-deps chromium` · `pnpm --filter @metrika/web test:e2e` — Playwright's `webServer` builds and starts the app itself                                              |
| `openapi`     | `pnpm --filter @metrika/api openapi:emit` then `git diff --exit-code -- apps/api/openapi/openapi.json`                                                                                                    |
| `contracts`   | `pnpm contracts:emit` then `git diff --exit-code` on the generated pydantic models **and on `packages/contracts/redaction-corpus.json`** — the only job besides `verify`/`integration` that installs `uv` |

The corpus path was added by Plan 0C Task 6 and is not decoration.
`scripts/contracts-emit.mjs` writes that file as well as the models, and this
step named only the models directory. MEASURED: delete a row from the corpus and
`git diff --exit-code -- apps/workers/…/contracts/` exits **0** — the gate did
not merely pass, the corpus was outside it. It is the 956 declared verdicts that
every redaction traversal grades itself against, and `apps/workers` reads it
from disk, so a stale copy is every sink agreeing with a snapshot of a rule that
has moved.

**There is deliberately no `workers` job, and its absence is not an omission.**
`apps/workers` exposes `lint`, `typecheck`, `test:unit` and `format:check` as
`uv run …` shims, so Turbo already schedules every one of them inside `verify`
— MEASURED with `turbo run <task> --dry=json`, which lists
`uv run --locked --all-packages ruff check .`, `… mypy .`, `… pytest` and
`… ruff format --check .` for `@metrika/workers`. `integration` and
`contracts` install `uv` for their own reasons. A separate job would re-run
all of that on a second runner: slower CI, no additional coverage, and a
second place to forget a pin.

The five jobs are independent and run in parallel; each does its own install
and build, because nothing is shared between GitHub Actions jobs. The two
`NEXT_PUBLIC_` keys and `DATABASE_ADMIN_URL` are set once at the **workflow**
level rather than per job, so a job added later inherits them instead of
rediscovering their absence as a build failure.

`integration` is a separate job rather than a step in `verify` because
everything it proves is invisible to `verify`'s gates: an `import type` on an
injected provider, a dynamic `Module.forRoot()` slipping past the `AppModule`
import guard, an RLS policy that stops isolating a tenant, a probe that answers
200 while its dependency is down, a stack trace escaping the exception filter.
`format:check`, `lint`, `typecheck` and `test:unit` are green for every one of
them.

`web` is separate for the same reason plus one of its own. What it proves —
`next-intl` resolving a catalogue, the stylesheet loading rather than merely
being referenced, the skip link being the first focusable node, `clientEnv`
reaching the rendered document — needs a real browser, and it needs a browser
**download**: keeping that out of `pnpm verify` is why there is no root
`test:e2e` script. Its `pnpm build` step is not redundant with the build
Playwright runs: `webServer.command` is `apps/web`'s own `next build`, which
does not build `@metrika/contracts`, and without the workspace build the job
fails with `TS2307: Cannot find module '@metrika/contracts'`.

**Turborepo remote caching is deliberately off, and `.turbo` is deliberately not
cached between runs.** No tsconfig in this repository declares project
`references`, so `tsc -b`'s up-to-date check cannot see a workspace
dependency's emitted `.d.ts` change and skips the consumer against a stale
build-info. What keeps CI honest is that a fresh checkout has no build-info at
all. Restoring one — which is exactly what a `.turbo` cache step does — would
silently convert the cross-package type gate into a pass. The measurement and
the conditions for lifting this are in the workflow file itself; read them
before adding a cache step.

**Growing into this table** as the runtimes that need them land: `ruff` and
`mypy --strict` and the Python test job (Plan 0B-3), Redis/MinIO/Temporal
Testcontainers (with their harnesses), per-package coverage gates, bundle-size
budgets for `web` (Phase 4), container
builds, and `security` (`pnpm audit`, gitleaks, Trivy, CodeQL — Plan 0D).
`main`-only deployment — push images to ECR, `terraform apply` to staging,
`prisma migrate deploy`, ECS rolling deploy, smoke tests, then a **manual
gate** before production — arrives with the Terraform environments.

Nightly: slicer regression suite, dependency audit, Terraform drift detection, estimate-calibration report.

**Nothing deploys if any gate fails.** There is no override; a broken gate is fixed, not bypassed.

---

## 5. Database migrations

`prisma migrate dev` is a **local-only** tool. Production uses `prisma migrate deploy` against reviewed, committed SQL.

### Expand/contract, always

Renaming `Quote.total` to `Quote.totalMinor` is four deploys, not one:

```
1. ADD COLUMN "totalMinor" BIGINT NULL                    -- additive, safe
2. Backfill in batches; write to both columns             -- application change
3. Read from "totalMinor"; stop writing "total"           -- application change
4. DROP COLUMN "total"                                    -- destructive, marked
```

Rules to be enforced by a CI check that parses generated SQL. **That check does
not exist yet.** What does exist is `packages/database/test/migration-sql.test.ts`,
a unit test that parses the committed migrations for a narrower set of
properties — every table that `ENABLE`s row-level security also `FORCE`s it,
every policy constrains writes as well as reads, and no later migration reopens
what an earlier one closed. The expand/contract rules below are conventions
until the parser lands:

| Statement                                       | Rule                                                  |
| ----------------------------------------------- | ----------------------------------------------------- |
| `ADD COLUMN ... NOT NULL` without a default     | **Blocked** — rewrites the table                      |
| `DROP COLUMN` / `DROP TABLE` / type narrowing   | Requires `-- metrika:destructive-ok <reason>`         |
| `CREATE INDEX`                                  | Must be `CONCURRENTLY`, outside a transaction         |
| `ALTER TABLE ... SET NOT NULL` on a large table | Requires a validated check constraint first           |
| Long-running backfill                           | Must be a batched script, never inline in a migration |

Migrations run as a one-off ECS task before the service rolling update, with `statement_timeout` and `lock_timeout` set so a migration that would block writes fails fast rather than taking the site down. Every migration is to be tested up **and** down against a seeded database in CI; today CI applies them forward only, as `prisma migrate deploy` against a fresh Testcontainers Postgres on every integration run.

---

## 6. Backups and disaster recovery

| Objective                      | Target                                                     |
| ------------------------------ | ---------------------------------------------------------- |
| RPO (database)                 | 5 minutes — PITR                                           |
| RTO (database)                 | 1 hour                                                     |
| RPO (S3)                       | 0 — versioning + cross-region replication for `originals/` |
| RTO (full environment rebuild) | 4 hours from Terraform                                     |

- RDS automated backups: 7 days staging, 30 days production, plus monthly manual snapshots retained 12 months.
- **Restore testing quarterly** — restore production's latest snapshot into a scratch environment, run migrations, run smoke tests, record the elapsed time. A backup that has never been restored is a hypothesis.
- S3 versioning on `originals/` protects against accidental or malicious overwrite; cross-region replication protects against a regional event.
- Terraform state is versioned and backed up; a full environment can be rebuilt from `main` plus a database restore.
- The DR runbook lives in `docs/runbooks/disaster-recovery.md` and names who does what, in order.

---

## 7. Cost model

Rough monthly estimates at low volume. **These are planning figures, not quotes — verify current pricing before committing.** AWS, Temporal and Clerk all change pricing, and Colombian data-transfer patterns may differ from assumptions.

| Item                          | Staging                     | Production (low volume)     | Scales with                                                 |
| ----------------------------- | --------------------------- | --------------------------- | ----------------------------------------------------------- |
| RDS PostgreSQL                | ~$30 (t4g.small, single-AZ) | ~$90 (t4g.medium, Multi-AZ) | Data volume, connections                                    |
| ECS Fargate — api             | ~$18                        | ~$36 (2 tasks)              | Traffic                                                     |
| ECS Fargate — workflow worker | ~$18                        | ~$18                        | Workflow volume                                             |
| ECS Fargate — geometry        | ~$10                        | ~$25                        | **Model uploads**                                           |
| ECS Fargate — slicer (Spot)   | ~$5                         | ~$20                        | **Slice requests** — the main variable                      |
| ElastiCache                   | ~$12                        | ~$12                        | —                                                           |
| S3 storage                    | ~$1                         | ~$5                         | **Model storage growth**                                    |
| S3 requests + CloudFront      | ~$2                         | ~$10                        | Preview traffic                                             |
| ALB                           | ~$18                        | ~$18                        | Fixed                                                       |
| **NAT Gateway**               | **$0**                      | **$0**                      | _Avoided via VPC endpoints — would otherwise be ~$35+ each_ |
| VPC endpoints                 | ~$15                        | ~$22                        | Endpoint count                                              |
| Secrets Manager, KMS          | ~$5                         | ~$8                         | —                                                           |
| Temporal Cloud                | shared                      | ~$100+                      | Actions per month — **verify current pricing**              |
| Vercel                        | free                        | ~$20                        | Bandwidth, build minutes                                    |
| Clerk                         | free                        | ~$25+                       | MAU                                                         |
| Grafana Cloud                 | free                        | free → ~$50                 | Ingest volume                                               |
| Sentry                        | free                        | ~$26                        | Event volume                                                |
| **Total**                     | **~$135**                   | **~$485**                   |                                                             |

### Cost drivers, ranked

1. **Slicing CPU.** A slice is 10–60 s of 1–2 vCPU. At 1,000 slices/month that is roughly 10–30 vCPU-hours — trivially cheap. At 100,000 it is the largest line item. The mitigations are already structural: the content-addressed cache, Fargate Spot, and per-org rate limits.
2. **S3 storage growth.** Originals accumulate forever unless lifecycle rules move them. Intelligent-Tiering plus Glacier IR at 90 days keeps this small; without it, it compounds.
3. **Temporal actions.** Priced per action. Chatty workflows (frequent heartbeats, many small activities) cost more than coarse ones — a real design consideration, not just a billing footnote.
4. **RDS.** Steady, predictable, upgradeable.
5. **Data transfer.** Preview downloads through CloudFront. Small per-model because previews are decimated; another payoff of that decision.

### What stays small, and what does not

Staying small indefinitely: RDS at this data volume, Redis, ALB, secrets, observability. Growing directly with usage: geometry and slicing CPU, S3 storage, CloudFront egress, Temporal actions, Clerk MAU.

Guardrails from day one: AWS Budgets alarms at 50/80/100% of a monthly target, per-service cost anomaly detection, and a weekly cost report on the Cost dashboard. A runaway slicing loop should page before it is a four-figure surprise.
