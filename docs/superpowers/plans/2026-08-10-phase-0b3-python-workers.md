# Phase 0B-3 — `apps/workers` and the Temporal runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `apps/workers` as a uv workspace with a shared `metrika_core` library and two worker entry points that connect to Temporal, cross the contract boundary into Python with generated pydantic models, and are gated by the same kind of CI this repository already applies to `apps/api` and `apps/web` — with no geometry, no slicing and no real activity logic.

**Architecture:** Two Python workers, one uv workspace, one shared library, separate container images. Workers are **stateless compute with no database credentials** — they receive fully-formed inputs as Temporal activity arguments, read and write S3 under prefix-scoped IAM, and return structured results. The contract boundary is crossed by emitting JSON Schema from `packages/contracts` and generating pydantic models from it, committed and diffed in CI. The Python workspace is separate from pnpm's; Turbo reaches it through thin `package.json` shims so `pnpm lint` and `pnpm test:unit` cover Python without pnpm trying to manage Python dependencies.

**Tech Stack:** Python 3.12, uv, `temporalio`, pydantic + pydantic-settings, structlog, boto3, ruff, mypy `--strict`, pytest, Testcontainers.

## Global Constraints

Copy these values verbatim. Every task's requirements implicitly include this section.

- **Python versions are decided by Task 1's spike, not assumed here.** Later tasks write `<pin>` and read ADR-0027's table. The blueprint names **Python 3.12** and `python:3.12-slim`; the spike confirms or supersedes that with a measurement.
- **Node-side exact pins, no ranges:** TypeScript `6.0.3` · ESLint `10.8.0` · Vitest `4.1.10` · Zod `4.4.3` · Node `24.19.0`. `packages/typescript-config/test/dependency-pins.test.ts` fails on any caret, tilde, range, `*` or dist-tag in any workspace manifest.
- **Python pins are exact too**, and `uv.lock` is committed. Task 2 decides whether the existing pin gate extends to `pyproject.toml` or a sibling gate is added — a Python range must not be able to land ungated just because the existing test only reads `package.json`.
- **`mypy --strict` and `ruff check` with an equivalently strict rule set.** An untyped worker is exactly as capable of producing a wrong price as an untyped service.
- **Workers never touch Postgres.** No `psycopg`, no SQLAlchemy, no `DATABASE_URL` in any worker settings model. This is a security control first: an attacker achieving code execution in the mesh parser must land somewhere with no database credentials. It needs a fixture asserting rejection, not a convention.
- **`packages/contracts` imports nothing but `zod`.** Zod 4 has native `z.toJSONSchema()`, so the emit chain needs no `zod-to-json-schema` dependency — measured before this plan was written.
- **Branding does not cross the language boundary.** `z.string().uuid().brand('QuoteId')` emits a plain string with a `format` and `pattern`; the brand is erased. Python gets validation, not type identity. Say so where the generated models are documented rather than letting a reader assume otherwise.
- **Workflow code is deterministic.** `apps/api/src/workflows/**` may not use `Date`, `Math`, `crypto`, `node:*` or any infrastructure import. Side effects go in activities. The ESLint profile enforcing this is Task 7's, and ROADMAP 0.3 defers it here.
- **Money is `bigint` minor units + currency + explicit exponent**, an integer string on the wire. Every physical quantity carries its unit in its name (`lengthMm`, `massG`, `volumeMm3`, `durationS`).
- **Do not add an `actions/cache` step for `.turbo`, and do not enable a Turbo remote cache.** `tsc -b` skips re-checking when only a workspace dependency's `.d.ts` changed; a fresh checkout carrying no build-info is the only reason CI catches it. See [R19](../../RISK_REGISTER.md#r19--tsc--b-skips-stale-cross-package-dependencies) and the banner at the top of `.github/workflows/ci.yml`.
- **Documentation ships in the same commit as the code it describes.** ADRs are immutable — supersede or scope with a new ADR; only a status line may change.
- **Conventional commits, scoped by package** (`feat(workers): …`). **No `Co-Authored-By` trailers or any other AI attribution.**
- **Gates, all from `$?` directly** — never off a pipe, since `cmd | tail; echo $?` reports `tail`'s status:
  - `pnpm verify` exit 0 (it runs `format:check`, `build`, `lint`, `typecheck`, `test:unit`)
  - `pnpm test:integration` exit 0
  - `tsc -b --force` exit 0 for every Node package
  - `uv run mypy --strict` and `uv run ruff check` exit 0 in `apps/workers`

## What Task 1's spike measured, which Tasks 2–6 must not rediscover

Recorded here because each of these would otherwise cost a task, and three of
them contradict what a reasonable person would assume.

- **`uv add` writes `>=` ranges, not pins.** The pin table in ADR-0027 is only
  real because `uv.lock` is committed and every install uses `--frozen`. A task
  that runs a bare `uv add` has silently widened a dependency.
- **`temporalio/auto-setup` defaults to Cassandra**, so the naive
  `docker run temporalio/auto-setup` in the brief does not boot. Task 5's compose
  service must configure the datastore explicitly.
- **`datamodel-codegen`'s default output is non-deterministic AND mypy-invalid.**
  Task 4 commits that output and diffs it in CI, so the flags ADR-0027 recorded
  are load-bearing, not cosmetic — a timestamp header alone makes the gate
  permanently red.
- **A generated model can pass ruff, mypy, pytest collection AND import, and
  still raise on every payload.** A schema carrying both `format: date-time`
  and a `pattern` — which is exactly what `z.iso.datetime()` emits — generates
  `Annotated[AwareDatetime, Field(pattern=…)]`: ruff 0, mypy `--strict` 0,
  import 0, then `TypeError: Unable to apply constraint 'pattern' … for schema
of type 'datetime'` on the first real payload. Not a `ValidationError` — an
  uncaught `TypeError`. **Task 4's gate must instantiate and validate, not
  import.**
- **Codegen output is a function of the ruff config, not just of time.** Adding
  `[tool.ruff] line-length` — which Task 2 does — reflows the generated
  annotations and changes the committed bytes. **Task 2 and Task 4 are
  coupled**: whoever changes ruff's config regenerates and re-commits, or the
  CI diff gate goes red on an unrelated PR and gets disabled.
- **Zod's own built-in patterns carry `\d` and cannot be edited.** `z.e164()`,
  `z.iso.datetime()`, `z.iso.date()` and `z.iso.time()` all emit it, so
  `+1٥٠٥٠٥٠٥` is rejected by Zod and accepted by the generated model.
  ADR-0027 decides this deliberately: the emitter does **not** post-process
  patterns — rewriting a regex the TypeScript side believes it owns would
  reintroduce the divergence one layer down while looking like a fix — so
  **Task 4 carries a Python-side test per emitted built-in format, each with a
  non-ASCII-digit case**. `z.uuid()` is already safe (explicit `[0-9a-fA-F]`).
- **`trimesh` needs the `[easy]` extra to export 3MF at all.** The bare pin
  raises `ModuleNotFoundError: networkx`, then `lxml` — and does so **lazily**:
  the module imports and the exporter registers, so nothing short of an actual
  export catches it. Relevant to the geometry phase rather than to this plan's
  tasks, but the pin table is what that task will copy from.
- **`boto3` and `botocore` ship no `py.typed`**, so without `boto3-stubs[s3]`
  every S3 call is `Any` and `mypy --strict` is decorative across the whole
  storage module. It is a mandatory dependency, not a convenience.

## Method notes that cost the previous plan real time

- Run a Node package's tests with **that package's own** `./node_modules/.bin/vitest` from inside the package. `node node_modules/vitest/vitest.mjs` from the repo root exits 1 with `MODULE_NOT_FOUND`, which looks exactly like a failing test.
- `pnpm --filter … run` and `pnpm exec` auto-install when a manifest is mutated, so a manifest mutation exits 1 for pnpm's reason rather than your test's.
- `${PIPESTATUS[0]}` is **empty in zsh** (it is `$pipestatus[1]`), which makes a passing run look like it produced no exit code at all.
- The ambient shell is Node 26.5.0; the repo pins 24.19.0 and `preinstall` fails outright. Use `mise exec` or put `/Users/mike/.local/share/mise/installs/node/24.19.0/bin` on `PATH`.
- `pnpm --filter @metrika/nonexistent test:unit` exits **0** with "No projects matched the filters". Use `--fail-if-no-match` when a step is meant to fail.

## What this plan does **not** build

Named so no task grows into them: real geometry analysis, real slicing, the OrcaSlicer container image, any Temporal workflow with business logic, `packages/pricing-engine`, S3 bucket provisioning, `infra/terraform`, and the `contracts:emit` **event** payloads (only the schemas that exist in `packages/contracts` today are emitted).

## File structure

| File                                                              | Responsibility                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| `docs/adr/0027-python-toolchain.md`                               | The spike result: Python major, and every pin                     |
| `apps/workers/pyproject.toml`                                     | uv workspace root, ruff and mypy config                           |
| `apps/workers/uv.lock`                                            | Committed lockfile                                                |
| `apps/workers/package.json`                                       | Turbo shim only — no Node dependencies                            |
| `apps/workers/packages/metrika_core/`                             | Shared library: settings, logging, S3, Temporal base              |
| `apps/workers/packages/metrika_core/src/metrika_core/settings.py` | `pydantic-settings`; the only reader of the process environment   |
| `apps/workers/packages/metrika_core/src/metrika_core/logging.py`  | structlog configuration and the redaction list                    |
| `apps/workers/packages/metrika_core/src/metrika_core/storage.py`  | S3 client; the only module that names `boto3`                     |
| `apps/workers/packages/metrika_core/src/metrika_core/temporal.py` | Client and worker construction                                    |
| `apps/workers/packages/metrika_core/src/metrika_core/contracts/`  | Generated pydantic models — committed, never hand-edited          |
| `apps/workers/geometry/`                                          | Geometry worker entry point                                       |
| `apps/workers/slicer/`                                            | Slicer worker entry point                                         |
| `packages/contracts/src/json-schema.ts`                           | `emitJsonSchemas()` — the Zod → JSON Schema half                  |
| `packages/contracts/scripts/emit.ts`                              | Writes the schema files                                           |
| `scripts/contracts-emit.mjs`                                      | Drives emit + `datamodel-codegen`, wired to `pnpm contracts:emit` |
| `packages/eslint-config/src/workflows.js`                         | The determinism profile                                           |
| `infra/docker/docker-compose.yml`                                 | Adds `temporal` and `temporal-ui`                                 |
| `packages/testing/src/temporal.ts`                                | Temporal test-environment harness                                 |
| `.github/workflows/ci.yml`                                        | A `workers` job and the `contracts:emit` diff gate                |

---

### Task 1: The Python toolchain spike, and the ADR that records it

The previous plan's spike found four problems that would each have cost a later task, and its cost was one throwaway directory. Do the same here. Nothing in this task ships in `apps/workers`.

**Files:**

- Create: `docs/adr/0027-python-toolchain.md`
- Modify: `docs/adr/README.md`
- Test: none — the deliverable is a measurement, recorded

**Interfaces:**

- Consumes: nothing
- Produces: the exact pin for every Python package Tasks 2–6 install, plus the Python major, written into ADR-0027 as a table. Later tasks write `<pin>` and read it.

- [ ] **Step 1: Build the spike outside the workspace**

```bash
SPIKE=$(mktemp -d); echo "SPIKE=$SPIKE"; cd "$SPIKE"
```

A workspace member that fails to install breaks `pnpm install` for the whole repo.

- [ ] **Step 2: Record what the index actually offers**

```bash
for p in temporalio pydantic pydantic-settings structlog boto3 botocore \
         ruff mypy pytest pytest-asyncio datamodel-code-generator trimesh; do
  echo -n "$p: "
  curl -s "https://pypi.org/pypi/$p/json" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['info']['version'],'| requires_python:',d['info'].get('requires_python'))"
done
```

Every package Tasks 2–6 install must appear. A pin decided ad hoc in a later task is a pin nobody reviewed.

- [ ] **Step 3: Check the Python major against `requires_python`, before installing**

The blueprint says **3.12** and `python:3.12-slim`. Answer in writing, per package: does its `requires_python` include 3.12? Does it include 3.13?

This is the step that matters. The equivalent check in the previous plan found `eslint-plugin-react`'s peer range excluding the pinned ESLint major — a package that installs with a warning and then silently degrades. Treat a `requires_python` that excludes your major as a spike failure for that package, not a warning to scroll past.

If a package this plan needs supports 3.13 but not 3.12, or the reverse, that decides the major — say which, and say it in the ADR.

- [ ] **Step 4: Install and prove the toolchain composes**

```bash
cd "$SPIKE"
uv init --python 3.12 spike && cd spike
uv add temporalio pydantic pydantic-settings structlog boto3
uv add --dev ruff mypy pytest pytest-asyncio datamodel-code-generator
echo "INSTALL_EXIT=$?"
```

Record every resolution warning. Then check `uv` itself is present and pinned — if it is not installed, say how a developer and CI are each expected to get it, because that answer belongs in the ADR.

- [ ] **Step 5: Exercise each integration, not just the install**

Ask of each "what would this look like if it silently did nothing?" and check for _that_.

```bash
cat > spike_check.py <<'PY'
import asyncio, json
import structlog
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

class S(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="METRIKA_")
    temporal_address: str = "localhost:7233"
    s3_bucket: str

class Money(BaseModel):
    amount_minor: str = Field(pattern=r"^(0|-?[1-9]\d*)$")
    currency: str
    exponent: int = Field(ge=0, le=4)

def main() -> None:
    structlog.configure(processors=[structlog.processors.JSONRenderer()])
    log = structlog.get_logger()
    log.info("spike", ok=True)

    s = S(s3_bucket="b")
    assert s.temporal_address == "localhost:7233"

    m = Money(amount_minor="350000", currency="COP", exponent=0)
    assert m.amount_minor == "350000"
    try:
        Money(amount_minor="3500.00", currency="COP", exponent=0)
        raise SystemExit("REGEX DID NOT REJECT A DECIMAL STRING")
    except Exception as e:
        print("rejected as expected:", type(e).__name__)

    import temporalio.client, temporalio.worker  # import only; no server yet
    print("temporalio imported")

main()
PY
uv run python spike_check.py; echo "RUN_EXIT=$?"
uv run mypy --strict spike_check.py; echo "MYPY_EXIT=$?"
uv run ruff check spike_check.py; echo "RUFF_EXIT=$?"
```

The negative assertion — that the integer-string pattern **rejects** `"3500.00"` — is the one that matters. A pydantic model that accepts a decimal string would silently reintroduce float money on the Python side of the boundary.

- [ ] **Step 6: Prove the contract boundary actually generates**

```bash
cat > money.schema.json <<'JSON'
{ "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Money", "type": "object",
  "properties": {
    "amountMinor": { "type": "string", "pattern": "^(0|-?[1-9]\\d*)$" },
    "currency": { "type": "string", "enum": ["COP","USD","EUR","MXN"] },
    "exponent": { "type": "integer", "minimum": 0, "maximum": 4 } },
  "required": ["amountMinor","currency","exponent"] }
JSON
uv run datamodel-codegen --input money.schema.json --input-file-type jsonschema \
  --output money_model.py --target-python-version 3.12 \
  --output-model-type pydantic_v2.BaseModel
echo "CODEGEN_EXIT=$?"; cat money_model.py
```

Answer three things in the ADR, because Task 4 depends on all three:

1. Does the generated model **carry the pattern and the bounds**, or only the types? A generated model that drops `pattern` gives Python no validation at all and the boundary becomes decorative.
2. Is the output **deterministic** across two runs (`diff`)? Task 4 commits the output and diffs it in CI; a timestamp header or dict-ordering instability makes that gate permanently red.
3. What does it do with a `format: uuid` string — and note that **branding is erased** at this boundary, so Python gets validation, not type identity.

- [ ] **Step 7: Start a real Temporal server and connect**

`temporalio` importing is not evidence that a worker can run.

```bash
docker run -d --name spike-temporal -p 7233:7233 temporalio/auto-setup:latest
cat > spike_connect.py <<'PY'
import asyncio
from temporalio.client import Client
async def main() -> None:
    c = await Client.connect("localhost:7233")
    print("connected, namespace:", c.namespace)
asyncio.run(main())
PY
uv run python spike_connect.py; echo "CONNECT_EXIT=$?"
docker rm -f spike-temporal
```

Also record the **image tag you would pin** — `:latest` is what a spike uses and what a compose file must not.

- [ ] **Step 8: Write ADR-0027**

Follow the house style — read `docs/adr/0021-next-major-and-frontend-stack.md` and `docs/adr/0026-web-consumes-compiled-contracts.md` first. Number it **0027**; `docs/adr/README.md` currently ends at 0026, so confirm that before writing and adjust if another ADR landed meanwhile.

It must contain the version table with the date measured, the `requires_python` answers quoted, every exit code from Steps 4–7, the three codegen answers, the Temporal image tag, how `uv` itself is obtained by a developer and by CI, **a stated fallback** naming the trigger measurement that would justify a different Python major, and **what did not work**. A spike reporting unqualified success is the one to distrust.

- [ ] **Step 9: Destroy the spike and commit**

```bash
rm -rf "$SPIKE"; docker rm -f spike-temporal 2>/dev/null
```

```bash
git add docs/adr/0027-python-toolchain.md docs/adr/README.md
git commit -m "docs(adr): pin the Python toolchain against a measured spike"
```

---

### Task 2: The uv workspace, the Turbo shim, and the Python half of the gates

Ends with `pnpm lint`, `pnpm typecheck` and `pnpm test:unit` covering Python, and `format`/`format:check` gaining the `ruff` half that `docs/TYPESCRIPT_AND_TOOLING.md` records as missing.

**Files:**

- Create: `apps/workers/pyproject.toml`, `apps/workers/uv.lock`, `apps/workers/package.json`, `apps/workers/.python-version`, `apps/workers/README.md`
- Modify: root `package.json`, `turbo.json`, `pnpm-workspace.yaml` if needed, `.gitignore`
- Test: `apps/workers/tests/test_toolchain.py`

**Interfaces:**

- Consumes: Task 1 (pins, Python major)
- Produces: `pnpm --filter @metrika/workers lint | typecheck | test:unit`; the uv workspace root at `apps/workers/pyproject.toml` with `[tool.uv.workspace] members = ["packages/*", "geometry", "slicer"]`

- [ ] **Step 1: Write the failing toolchain test**

`apps/workers/tests/test_toolchain.py`:

```python
"""The gates this repository relies on, asserted rather than assumed.

Every one of these has a Node-side equivalent that was once documented and
absent. The point of the file is that `mypy --strict` and `ruff` are not
optional and not silently downgradeable.
"""
from __future__ import annotations

import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _pyproject() -> dict[str, object]:
    with (ROOT / "pyproject.toml").open("rb") as handle:
        return tomllib.load(handle)


def test_python_major_matches_the_pinned_version_file() -> None:
    pinned = (ROOT / ".python-version").read_text().strip()
    assert sys.version.startswith(pinned), (
        f"running {sys.version.split()[0]}, .python-version says {pinned}"
    )


def test_mypy_runs_in_strict_mode() -> None:
    config = _pyproject()
    tool = config.get("tool")
    assert isinstance(tool, dict)
    mypy = tool.get("mypy")
    assert isinstance(mypy, dict)
    assert mypy.get("strict") is True, "mypy must be strict; an untyped worker can price wrongly"


def test_ruff_check_is_clean() -> None:
    result = subprocess.run(
        ["uv", "run", "ruff", "check", "."], cwd=ROOT, capture_output=True, text=True
    )
    assert result.returncode == 0, result.stdout + result.stderr
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/workers && uv run pytest tests/ -v; echo "EXIT=$?"
```

Expected: **non-zero** — there is no `pyproject.toml` yet.

- [ ] **Step 3: Write the workspace root**

`apps/workers/pyproject.toml`, with versions from ADR-0027:

```toml
[project]
name = "metrika-workers"
version = "0.0.0"
requires-python = "==<pin>.*"
dependencies = []

[tool.uv.workspace]
members = ["packages/*", "geometry", "slicer"]

[tool.ruff]
target-version = "py<pin>"
line-length = 100

[tool.ruff.lint]
# Deliberately broad. The Node side runs typescript-eslint's strict and
# stylistic sets plus type-aware rules; an equivalently strict Python side is
# what ADR-0007 promised when it accepted a second toolchain.
select = ["E", "F", "I", "N", "UP", "B", "A", "C4", "SIM", "ARG", "PTH", "RUF", "ASYNC", "S"]
ignore = []

[tool.ruff.lint.per-file-ignores]
# assert is the point of a test file; S101 bans it everywhere else.
"tests/**" = ["S101"]

[tool.mypy]
strict = true
python_version = "<pin>"
warn_unreachable = true
disallow_any_explicit = true

[dependency-groups]
dev = ["ruff==<pin>", "mypy==<pin>", "pytest==<pin>", "pytest-asyncio==<pin>"]
```

`apps/workers/.python-version` carries the major from ADR-0027.

- [ ] **Step 4: Write the Turbo shim**

`apps/workers/package.json` — a shim, with **no Node dependencies**:

```json
{
  "name": "@metrika/workers",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "lint": "uv run ruff check .",
    "format": "uv run ruff format .",
    "format:check": "uv run ruff format --check .",
    "typecheck": "uv run mypy .",
    "test:unit": "uv run pytest"
  }
}
```

`typecheck` is `mypy` and not `tsc -b`, so it must **not** inherit `turbo.json`'s `build`-dependent wiring in a way that makes it wait on Node builds it does not need. Check what `turbo.json` currently declares for `typecheck` and say in your report whether the shim gets what it should.

- [ ] **Step 5: Wire the root `format` and `format:check`**

`docs/TYPESCRIPT_AND_TOOLING.md` records that the `ruff` half is missing "because there is no `apps/workers` to format yet". There is now. Make both root scripts cover Python, and update that sentence in the same commit.

- [ ] **Step 6: Close the Python-pin gap**

`packages/typescript-config/test/dependency-pins.test.ts` walks every `package.json` and fails on a range. It cannot see `pyproject.toml`, so a Python range would land ungated.

Extend it, or add a sibling gate — your call, but say which and why. Then prove it: put `ruff>=0.16` in `pyproject.toml`, confirm the gate exits non-zero naming it, and restore.

- [ ] **Step 7: Run everything**

```bash
cd apps/workers && uv run pytest tests/ -v; echo "PYTEST=$?"
cd ../.. && pnpm verify; echo "VERIFY=$?"
```

Expected: both **0**.

- [ ] **Step 8: Mutation — prove the gates are not decorative**

Each of these, restoring between:

1. Set `strict = false` under `[tool.mypy]` → `test_mypy_runs_in_strict_mode` must fail.
2. Add a file with an unused import → `pnpm lint` must exit non-zero.
3. Add a file with an untyped function → `pnpm typecheck` must exit non-zero.

If (3) passes, `mypy` is not actually reaching your sources — check what it is being pointed at, and say so.

- [ ] **Step 9: Commit**

```bash
git add apps/workers package.json turbo.json docs/TYPESCRIPT_AND_TOOLING.md packages/typescript-config
git commit -m "feat(workers): add the uv workspace and wire the Python gates into turbo"
```

---

### Task 3: `metrika_core` — settings, logging, and S3

**Files:**

- Create: `apps/workers/packages/metrika_core/pyproject.toml`, `src/metrika_core/__init__.py`, `settings.py`, `logging.py`, `storage.py`
- Test: `apps/workers/packages/metrika_core/tests/test_settings.py`, `test_logging.py`, `test_storage.py`

**Interfaces:**

- Consumes: Task 2
- Produces:
  - `WorkerSettings` (pydantic-settings, env prefix `METRIKA_`) with `temporal_address: str`, `temporal_namespace: str`, `temporal_task_queue: str`, `s3_bucket: str`, `s3_endpoint_url: str | None`, `log_level: str`
  - `configure_logging(level: str) -> None`
  - `REDACTED_KEYS: frozenset[str]`
  - `ObjectStore` with `get_object(key: str) -> bytes`, `put_object(key: str, body: bytes) -> None`, `presigned_get(key: str, expires_s: int) -> str`

- [ ] **Step 1: Write the failing settings tests**

`apps/workers/packages/metrika_core/tests/test_settings.py`:

```python
from __future__ import annotations

import pytest
from pydantic import ValidationError

from metrika_core.settings import WorkerSettings


def test_reads_the_metrika_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("METRIKA_S3_BUCKET", "metrika-models")
    monkeypatch.setenv("METRIKA_TEMPORAL_TASK_QUEUE", "geometry-small")
    settings = WorkerSettings()
    assert settings.s3_bucket == "metrika-models"
    assert settings.temporal_task_queue == "geometry-small"


def test_defaults_the_temporal_address(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("METRIKA_S3_BUCKET", "b")
    monkeypatch.setenv("METRIKA_TEMPORAL_TASK_QUEUE", "q")
    assert WorkerSettings().temporal_address == "localhost:7233"


def test_rejects_a_missing_bucket_and_names_it(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("METRIKA_S3_BUCKET", raising=False)
    monkeypatch.setenv("METRIKA_TEMPORAL_TASK_QUEUE", "q")
    with pytest.raises(ValidationError, match="s3_bucket"):
        WorkerSettings()


def test_has_no_database_field_at_all() -> None:
    """ADR-0007: a worker must have no database credentials.

    This is a security control, not a style rule — an attacker achieving code
    execution in the mesh parser must land somewhere with nothing to steal.
    A field named for a database is the first way that erodes, and it would
    erode silently because nothing else in the system would break.
    """
    forbidden = ("database", "postgres", "db_", "dsn", "sql")
    for name in WorkerSettings.model_fields:
        assert not any(token in name.lower() for token in forbidden), (
            f"WorkerSettings.{name} looks like database configuration; see ADR-0007"
        )


def test_rejects_an_unknown_metrika_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    """Typos must fail loudly rather than silently taking a default."""
    monkeypatch.setenv("METRIKA_S3_BUCKET", "b")
    monkeypatch.setenv("METRIKA_TEMPORAL_TASK_QUEUE", "q")
    monkeypatch.setenv("METRIKA_S3_BUKCET", "typo")
    with pytest.raises(ValidationError):
        WorkerSettings()
```

The last two are the ones worth having. The database test asserts an **absence**, which is the shape most likely to be written vacuously — so Step 8's mutation must prove it fires.

- [ ] **Step 2: Write the failing logging test**

`apps/workers/packages/metrika_core/tests/test_logging.py`:

```python
from __future__ import annotations

import json

import structlog

from metrika_core.logging import REDACTED_KEYS, configure_logging


def test_emits_json(capsys) -> None:  # type: ignore[no-untyped-def]
    configure_logging("info")
    structlog.get_logger().info("sliced", cache_key="abc123")
    payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert payload["event"] == "sliced"
    assert payload["cache_key"] == "abc123"


def test_redacts_a_presigned_url(capsys) -> None:  # type: ignore[no-untyped-def]
    """A signed URL in a log is a credential in a log.

    SECURITY.md requires signed URLs and file names to be redacted from every
    log line. structlog will happily serialise whatever it is handed, so the
    redaction has to be a processor rather than a convention.
    """
    configure_logging("info")
    structlog.get_logger().info(
        "downloaded", presigned_url="https://s3/x?X-Amz-Signature=deadbeef"
    )
    out = capsys.readouterr().out
    assert "X-Amz-Signature" not in out
    assert "deadbeef" not in out
    assert "[redacted]" in out


def test_the_redaction_list_is_not_empty() -> None:
    assert REDACTED_KEYS, "an empty list would make every redaction test vacuous"
```

- [ ] **Step 3: Run both and watch them fail**

```bash
cd apps/workers && uv run pytest packages/metrika_core -v; echo "EXIT=$?"
```

Expected: **non-zero**, import errors.

- [ ] **Step 4: Write `settings.py`**

```python
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class WorkerSettings(BaseSettings):
    """Configuration for both workers.

    There is deliberately no database field of any kind. Workers receive
    fully-formed inputs as Temporal activity arguments and read and write S3
    under a prefix-scoped role; the API is the only writer to Postgres. See
    ADR-0007, and `tests/test_settings.py` for the assertion that keeps it
    true.

    `extra="forbid"` so a typo'd variable fails at startup rather than
    silently taking a default — the same reason `apps/api` parses its
    environment with Zod instead of reading `process.env` directly.
    """

    model_config = SettingsConfigDict(env_prefix="METRIKA_", extra="forbid")

    temporal_address: str = "localhost:7233"
    temporal_namespace: str = "default"
    temporal_task_queue: str
    s3_bucket: str
    s3_endpoint_url: str | None = None
    log_level: str = "info"
```

- [ ] **Step 5: Write `logging.py`**

```python
from __future__ import annotations

import logging
from typing import Any

import structlog

REDACTED_KEYS: frozenset[str] = frozenset(
    {
        "presigned_url",
        "signed_url",
        "url",
        "file_name",
        "filename",
        "original_filename",
        "authorization",
        "token",
        "secret",
        "password",
    }
)

_REDACTED = "[redacted]"


def _redact(
    _logger: object, _method: str, event: dict[str, Any]
) -> dict[str, Any]:
    for key in list(event):
        if key.lower() in REDACTED_KEYS:
            event[key] = _REDACTED
    return event


def configure_logging(level: str) -> None:
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            _redact,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.getLevelNamesMapping()[level.upper()]
        ),
        cache_logger_on_first_use=True,
    )
```

- [ ] **Step 6: Write `storage.py` and its test**

`ObjectStore` wraps `boto3` and is the only module that names it. Its test uses a **real MinIO container** through Testcontainers rather than a mock — a mocked S3 client proves the code calls a method, not that the call is correct. `infra/docker/docker-compose.yml` already runs MinIO, and `packages/testing` already has the Postgres precedent to follow.

Write the test first, watch it fail, then implement. It must cover: a round-trip `put_object`/`get_object`, a `get_object` for a missing key raising rather than returning empty, and `presigned_get` returning a URL that actually resolves.

- [ ] **Step 7: Run and watch them pass**

```bash
cd apps/workers && uv run pytest packages/metrika_core -v; echo "EXIT=$?"
cd ../.. && pnpm verify; echo "VERIFY=$?"
```

- [ ] **Step 8: Mutations**

Record each exit code, restoring between:

1. Add `database_url: str = ""` to `WorkerSettings` → the ADR-0007 test must fail. **If it does not, the test is vacuous** — fix it before continuing.
2. Remove `_redact` from the processor chain → the redaction test must fail.
3. Empty `REDACTED_KEYS` → both the redaction test _and_ the non-empty guard must fail.
4. Change `extra="forbid"` to `extra="ignore"` → the typo test must fail.

- [ ] **Step 9: Commit**

```bash
git add apps/workers
git commit -m "feat(workers): add metrika_core settings, logging and object storage"
```

---

### Task 4: `contracts:emit` — Zod to JSON Schema to pydantic

`docs/ARCHITECTURE.md` names this and says plainly that it does not exist yet and lands here.

**Files:**

- Create: `packages/contracts/src/json-schema.ts`, `packages/contracts/scripts/emit.ts`, `scripts/contracts-emit.mjs`, `apps/workers/packages/metrika_core/src/metrika_core/contracts/` (generated, committed)
- Modify: root `package.json`, `packages/contracts/package.json`, `.github/workflows/ci.yml`, `docs/ARCHITECTURE.md`
- Test: `packages/contracts/test/json-schema.test.ts`, `apps/workers/packages/metrika_core/tests/test_generated_contracts.py`

**Interfaces:**

- Consumes: Tasks 1–3
- Produces: `emitJsonSchemas(): Record<string, unknown>`; `pnpm contracts:emit`; the generated pydantic modules

- [ ] **Step 1: Use Zod 4's native emitter — no new dependency**

`packages/contracts` may import nothing but `zod`, and it does not need to: **Zod 4 ships `z.toJSONSchema()`**. Measured before this plan was written, on the repo's own pinned `zod@4.4.3`:

```
z.toJSONSchema(Money) →
{ "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "amountMinor": { "type": "string", "pattern": "^(0|-?[1-9]\\d*)$" },
    "currency":    { "type": "string", "enum": ["COP","USD","EUR","MXN"] },
    "exponent":    { "type": "integer", "minimum": 0, "maximum": 4 } },
  "required": ["amountMinor","currency","exponent"] }
```

The `pattern` and the bounds survive, which is what makes the Python side validate rather than merely deserialise. `docs/ARCHITECTURE.md` describes the chain as `zod-to-json-schema → datamodel-codegen`; correct that sentence in this task's commit, since adding a dependency to `packages/contracts` requires justification and there is none.

**Branding is erased.** Measured: `z.string().uuid().brand('QuoteId')` emits a plain string with `format: "uuid"` and a pattern. Python gets validation, not type identity. Document that where the generated models live.

**The digit class is already fixed, and must stay fixed.** `INTEGER_STRING` in `money.ts` spells `[0-9]`, not `\d`, because Python's `\d` is Unicode-aware while JavaScript's is not — the `\d` form let a generated pydantic model accept `"3\u0665\u0660"`, which Zod rejects and `BigInt` throws on, and read it as `350`. `packages/contracts/test/money.test.ts` guards the source text, since a behavioural test passes against both forms. If a schema you emit here carries any other `\d`, fix it the same way before generating from it.

- [ ] **Step 2: Write the failing emitter test**

`packages/contracts/test/json-schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { emitJsonSchemas } from '../src/json-schema.js';

describe('emitJsonSchemas', () => {
  const schemas = emitJsonSchemas();

  it('emits every schema the Python side needs, by name', () => {
    expect(Object.keys(schemas).sort()).toEqual(['Money' /* …the rest… */].sort());
  });

  it('keeps the integer-string pattern on Money.amountMinor', () => {
    // Without the pattern the Python model accepts "3500.00" and float money
    // re-enters the system at the language boundary — the one place no
    // TypeScript test can see.
    const money = schemas['Money'] as { properties: { amountMinor: { pattern?: string } } };
    expect(money.properties.amountMinor.pattern).toBeDefined();
    expect(new RegExp(money.properties.amountMinor.pattern!).test('3500.00')).toBe(false);
    expect(new RegExp(money.properties.amountMinor.pattern!).test('350000')).toBe(true);
  });

  it('keeps the exponent bounds', () => {
    const money = schemas['Money'] as { properties: { exponent: { minimum?: number; maximum?: number } } };
    expect(money.properties.exponent.minimum).toBe(0);
    expect(money.properties.exponent.maximum).toBe(4);
  });

  it('is deterministic across two calls', () => {
    expect(JSON.stringify(emitJsonSchemas())).toBe(JSON.stringify(emitJsonSchemas()));
  });
});
```

Fill the first assertion's list from what `packages/contracts` actually exports — read `src/index.ts` rather than guessing.

- [ ] **Step 3: Run it and watch it fail**

```bash
cd packages/contracts && ./node_modules/.bin/vitest run json-schema; echo "EXIT=$?"
```

Expected: **non-zero**, module not found.

- [ ] **Step 4: Implement and wire the script**

`scripts/contracts-emit.mjs` drives both halves and mirrors `scripts/prisma.mjs`'s shape. `datamodel-codegen` flags come from ADR-0027's Step 6 measurements — in particular whichever flag makes the output deterministic, because Step 6 asks for that specifically.

Root `package.json` gains `"contracts:emit"`.

- [ ] **Step 5: Write the Python-side tests**

`test_generated_contracts.py` must **instantiate and validate**, never merely import — a model that imports cleanly can still raise `TypeError` on every payload (see the traps section).

Cover: the generated `Money` **rejects** `"3500.00"` and accepts `"350000"`; an out-of-range exponent is rejected; and a **non-ASCII-digit case per emitted built-in format**, because Zod's own `\d` patterns cross this boundary unfixed and ADR-0027 decided deliberately not to post-process them. `"3٥٠"` is the canonical probe.

These are the assertions that prove the constraints crossed the boundary rather than being dropped by codegen.

- [ ] **Step 6: Add the CI diff gate**

The generated models are committed. Add a step mirroring the existing `openapi` job: run `pnpm contracts:emit`, then `git diff --exit-code -- apps/workers/packages/metrika_core/src/metrika_core/contracts/`.

**Prove it fires**: change a schema in `packages/contracts`, re-emit, and confirm the exact command the job runs exits non-zero. Then restore. A gate whose failure has never been observed is a gate nobody knows works — the `openapi` gate shipped unwired for two whole tasks before anyone noticed.

Check whether the emitted output needs a `.prettierignore` entry, as `apps/api/openapi/openapi.json` did: `JSON.stringify(…, null, 2)` and Prettier disagree about short arrays, and that disagreement makes `format:check` and the diff gate permanently contradict each other.

- [ ] **Step 7: Gates and mutations**

```bash
pnpm verify; echo "VERIFY=$?"
git diff --exit-code -- apps/workers/packages/metrika_core/src/metrika_core/contracts/; echo "CLEAN_AFTER_EMIT=$?"
pnpm format && git diff --exit-code -- apps/workers/packages/metrika_core/src/metrika_core/contracts/; echo "CLEAN_AFTER_FORMAT=$?"
```

Then: drop the `pattern` from the emitter output and confirm the Python test goes red. That is the mutation that proves the whole chain, end to end.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts scripts apps/workers .github/workflows/ci.yml docs/ARCHITECTURE.md
git commit -m "feat(contracts): emit JSON Schema and generate the pydantic models"
```

---

### Task 5: Temporal in compose, and the test harness

**Files:**

- Modify: `infra/docker/docker-compose.yml`, `docs/LOCAL_DEVELOPMENT.md`, `docs/ROADMAP.md`
- Create: `packages/testing/src/temporal.ts`, `packages/testing/test/temporal.integration.test.ts`

**Interfaces:**

- Consumes: Task 1 (the pinned Temporal image tag)
- Produces: `startTemporal(): Promise<TemporalHandle>`, `stopTemporal(): Promise<void>`, `TemporalHandle` with `address: string`

- [ ] **Step 1: Add `temporal` and `temporal-ui` to compose**

The file's header comment already records that ROADMAP 0.10 lists them and that they land here — read it, and update it in this commit so it stops describing a future.

Match the existing services' conventions exactly: **ports bound to `127.0.0.1`**, an image pinned by tag (never `:latest`), and a healthcheck.

**`auto-setup` needs five environment variables, not four.** `DB_PORT` defaults to **3306**, so a Postgres datastore configured without it leaves the container sitting `Up` and looping `Waiting for PostgreSQL` forever — `docker ps` reports it healthy-looking while nothing works, which is a worse failure than the Cassandra default it replaces. ADR-0027 records the full set. Read the `postgres` service's healthcheck first — it uses `CMD-SHELL` with an explicit `-h 127.0.0.1` because a bare `pg_isready` passed before the server was actually reachable. Apply the same suspicion here: a healthcheck that passes before Temporal accepts connections makes every dependent test flaky.

- [ ] **Step 2: Verify it actually comes up, and that the healthcheck means something**

```bash
docker compose -f infra/docker/docker-compose.yml up -d temporal temporal-ui
docker compose -f infra/docker/docker-compose.yml ps
```

Then prove the healthcheck is not decorative: confirm the service reports healthy only once a client can connect, not before.

- [ ] **Step 3: Write the harness and its test**

`packages/testing/src/temporal.ts` follows `packages/testing/src/database.ts`'s shape — read it first. Two properties from that file are load-bearing and must carry over: **one container per run**, started in `globalSetup` rather than per file; and `stopTemporal` must be a documented no-op in a worker where the handle is `undefined`, which is what makes the shared-container model safe.

The integration test asserts a client can connect and that the namespace is reachable.

- [ ] **Step 4: Run it**

```bash
pnpm test:integration; echo "EXIT=$?"
```

- [ ] **Step 5: Mutation**

Point the harness at a dead port and confirm the test fails with a connection error rather than hanging until the suite timeout. A harness that hangs is worse than one that fails.

- [ ] **Step 6: Reconcile the docs and commit**

`docs/LOCAL_DEVELOPMENT.md` gains the two services and the UI's URL. `docs/ROADMAP.md`'s 0.10 row moves off `◐` and its progress paragraph must agree with the table — they have contradicted each other before.

```bash
git add infra packages/testing docs
git commit -m "feat(testing): add temporal to compose and a test-environment harness"
```

---

### Task 6: The Temporal base and the two worker entry points

**Files:**

- Create: `apps/workers/packages/metrika_core/src/metrika_core/temporal.py`, `apps/workers/geometry/pyproject.toml`, `geometry/src/metrika_geometry/__main__.py`, `apps/workers/slicer/pyproject.toml`, `slicer/src/metrika_slicer/__main__.py`
- Test: `apps/workers/packages/metrika_core/tests/test_temporal.py`, `apps/workers/geometry/tests/test_entrypoint.py`

**Interfaces:**

- Consumes: Tasks 2, 3, 5
- Produces:
  - `build_client(settings: WorkerSettings) -> Client`
  - `build_worker(client: Client, settings: WorkerSettings, activities: Sequence[Callable[..., object]]) -> Worker`
  - `python -m metrika_geometry` and `python -m metrika_slicer` as entry points

- [ ] **Step 1: Write the failing test against a real Temporal**

Use the harness from Task 5, not a mock. Assert that `build_worker` registers the activities it is given, that the worker connects to the task queue named in settings, and that a trivial round-trip activity returns.

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement `temporal.py`, then the two entry points**

Each entry point reads `WorkerSettings`, calls `configure_logging`, builds a client and a worker, and runs it. The two differ only in task queue and registered activities. **No geometry, no slicing** — one stub activity each, returning a typed result, is the deliverable.

- [ ] **Step 4: Assert the security boundary at the worker level**

`apps/workers/geometry/tests/test_entrypoint.py` must assert that the geometry package's dependency closure contains **no database driver** — no `psycopg`, no `asyncpg`, no `sqlalchemy`. Read the resolved lock rather than the declared dependencies, so a transitive one is caught too.

This is ADR-0007's central promise and the only place it can be checked mechanically.

- [ ] **Step 5: Run, then mutate**

Add `asyncpg` to the geometry package's dependencies, re-lock, and confirm the test goes red naming it. Restore and re-lock.

- [ ] **Step 6: Commit**

```bash
git add apps/workers
git commit -m "feat(workers): add the temporal base and both worker entry points"
```

---

### Task 7: The `workflows` ESLint profile

ROADMAP 0.3 lists this profile and defers it to "the plan that adds `apps/api/src/workflows`". This is that plan. `apps/api/src/workflows/**` does not exist yet, which is the right moment: the rule lands before the code it constrains.

**Files:**

- Create: `packages/eslint-config/src/workflows.js`, `packages/eslint-config/test/eslint.workflows.config.js`, `packages/eslint-config/test/workflows.test.ts`
- Modify: `packages/eslint-config/src/index.js`, `apps/api/eslint.config.js`

**Interfaces:**

- Consumes: nothing
- Produces: `workflows({ tsconfigRootDir, project }): FlatConfig[]`, exported from `@metrika/eslint-config`

- [ ] **Step 1: Write the failing fixture test**

Workflow code must be deterministic: replay reconstructs state by re-executing it, so `Date.now()`, `Math.random()`, `crypto.randomUUID()`, `node:*` and any infrastructure import make a workflow that passes today and fails on replay after a deploy — the worst failure shape in the system, because it appears long after the change that caused it.

Follow `packages/eslint-config/test/web-boundaries.test.ts`'s structure — read it first. Cover, as **rejects**: `new Date()`, `Date.now()`, `Math.random()`, `crypto.randomUUID()`, `import 'node:fs'`, `import { PrismaClient } from '@prisma/client'`, and a dynamic `import()` of a forbidden module in **both** the string-literal and template-literal forms.

And as **accepts**: `import { proxyActivities } from '@temporalio/workflow'`, a type-only import from `@metrika/contracts`, and `Math.max(a, b)` — that last one matters, because a rule that bans the whole `Math` namespace breaks arithmetic and gets disabled within a week.

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement the profile**

Two details from `boundaries.js` are load-bearing and must carry over, both learned the hard way: set `languageOptions.parser` directly so the profile works standalone rather than depending on composition order; and `no-restricted-imports` sees only static imports, so a dynamic `import()` needs `no-restricted-syntax` with **two** selectors — a template-literal specifier is a `TemplateLiteral`, not a `Literal`.

- [ ] **Step 4: Compose into `apps/api` and prove it fires on the real app**

Scope it to `src/workflows/**`. Then write a probe file there, run `pnpm --filter @metrika/api lint`, and confirm non-zero with the profile's own message rather than a module-not-found. Delete the probe.

**Check for flat-config clobbering.** `apps/api`'s config already carries `prismaBoundary` and a `no-restricted-imports` block; a later entry naming the same rule with options replaces the earlier one wholesale. Write one probe violating both at once and confirm **two** findings, not one. This has bitten twice in this repository.

- [ ] **Step 5: Mutations, then commit**

Delete each selector in turn and confirm the corresponding fixture goes red. If any survives, the selector was never matching.

```bash
git add packages/eslint-config apps/api/eslint.config.js docs/ROADMAP.md
git commit -m "feat(eslint-config): add the workflow determinism profile"
```

---

### Task 8: CI, and documentation that matches what exists

**Files:**

- Modify: `.github/workflows/ci.yml`, `CLAUDE.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, `docs/LOCAL_DEVELOPMENT.md`, `docs/INFRASTRUCTURE.md`, `docs/TYPESCRIPT_AND_TOOLING.md`

**Interfaces:**

- Consumes: Tasks 1–7
- Produces: a `workers` CI job

- [ ] **Step 1: Read the workflow's banner before touching it**

**Do not add an `actions/cache` step for `.turbo`, and do not enable a Turbo remote cache.** The banner explains why with measurements; `docs/RISK_REGISTER.md` R19 carries them.

Note the two `NEXT_PUBLIC_*` keys live in a **workflow-level `env:` block** so every job inherits them — a job that sets what it needs locally is the trap the last plan walked into. If your job needs Python-specific configuration, follow the same placement rule.

- [ ] **Step 2: Add the `workers` job**

Model it on the existing jobs. It needs `uv` — install it the way ADR-0027 recorded — then `ruff check`, `ruff format --check`, `mypy --strict`, and `pytest`. Anything needing Temporal or MinIO belongs in the `integration` job, not here.

- [ ] **Step 3: Prove the job would fail**

Run its exact commands locally with a real break in place — a type error is the cheapest — and record both exit codes. A CI job whose failure mode has never been observed is a job nobody knows works.

- [ ] **Step 4: Reconcile the documentation, verifying every claim against the tree**

Do not trust the existing wording. This repository has repeatedly shipped documents asserting controls that did not exist, and the previous plan spent a whole task correcting a batch of them and still missed a status banner.

- `CLAUDE.md`: the current-state paragraph and the command list. `contracts:emit`, `test:e2e` and the `ruff` half of `format` are all named there as not yet created — check each against the tree.
- `docs/ROADMAP.md`: 0.9 done; 0.10 off `◐`; 0.13's Temporal harness done. Make the table and the progress paragraph agree **with each other**.
- `docs/ARCHITECTURE.md`: §6's package tree, and the §11 statement that `apps/workers` does not exist.
- `docs/TYPESCRIPT_AND_TOOLING.md` §7's script list — it was wrong in about ten ways once already and is the section most likely to drift again.
- `docs/INFRASTRUCTURE.md` §4's CI table — the canonical "what runs today" list. It has asserted the wrong job count twice.

Anything this plan did not build stays described as target state, in the honest form this repo already uses.

- [ ] **Step 5: The clean-clone run**

```bash
TMP=$(mktemp -d); git clone . "$TMP/metrika"; cd "$TMP/metrika"
pnpm install --frozen-lockfile; echo "INSTALL=$?"
pnpm verify; echo "VERIFY=$?"
cd apps/workers && uv sync && uv run pytest; echo "PYTEST=$?"
cd - && rm -rf "$TMP"
```

Every exit code must be **0**. This is the step that found a flake warm checkouts never showed in the previous plan; it is worth its runtime.

- [ ] **Step 6: Commit**

```bash
git add .github CLAUDE.md docs
git commit -m "ci(workers): run ruff, mypy and pytest, and reconcile the docs"
```

---

## Self-review notes for the executing agent

Four things this plan leaves to measurement rather than assertion:

1. **Every Python version is ADR-0027's to decide.** If the spike finds a package excluding the blueprint's 3.12, that decides the major — take the fallback rather than working around it.
2. **`z.toJSONSchema()` was measured on this repo's pinned zod before this plan was written**, and `packages/contracts` gains no dependency. If codegen output turns out non-deterministic, that is a Task 4 blocker to report, not to paper over with a `git checkout` in the script.
3. **Three assertions here are absences**, which is the shape most likely to be vacuous: no database field in `WorkerSettings`, no database driver in the geometry closure, and no non-deterministic API in workflow code. Each has a named mutation. Run them; do not reason about them.
4. **The MinIO and Temporal tests use real containers, never mocks.** A mocked S3 client proves the code calls a method, not that the call is correct — and the one thing this plan is really building is a boundary.
