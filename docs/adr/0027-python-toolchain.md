# ADR-0027 — Python 3.12 and the pinned worker toolchain

**Status:** Accepted · **Date:** 2026-08-10 · **Scopes** the toolchain half of
[ADR-0007](./0007-python-workers.md), which chose Python for the geometry and
slicing workers without naming a version for anything.

## Context

[`ARCHITECTURE.md`](../ARCHITECTURE.md) names **Python 3.12** and
`python:3.12-slim-bookworm`, and `mise.toml` already carries `python = "3.12"`
alongside `.python-version` at `3.12.13`. Plan 0B-3 Tasks 2–6 install twelve
packages; a pin chosen ad hoc inside one of those tasks is a pin nobody
reviewed, and a wrong one is discovered three tasks later.

This repository has lost a whole class of checking twice to the softer failure —
a dependency that installs, warns, and then silently does less than it appears
to. TypeScript resolved outside `typescript-eslint`'s peer range and every
type-aware rule stopped running with no error ([ADR-0021](./0021-next-major-and-frontend-stack.md)).
`eslint-plugin-react`'s peer range excluded the pinned ESLint major, and that
one was real ([ADR-0023](./0023-eslint-plugin-resolution.md)). **`requires_python`
is the same check on this side of the repository**, so it was answered per
package _before_ anything was installed, and an exclusion would have been
treated as a spike failure rather than a warning to scroll past.

Because an install exiting 0 is weak evidence, each of the five integrations was
additionally exercised for the shape it would take _if it silently did nothing_:
settings that ignore the environment and return defaults, a money model that
accepts a decimal string, codegen that drops its constraints, a type checker
that checks nothing, and a Temporal client that imports but cannot run a worker.

The spike ran in one throwaway directory outside the workspace (`mktemp -d`), on
uv 0.12.3 and CPython 3.12.13, with a real Temporal server and Postgres in
Docker, and was destroyed afterwards. Exit codes were read from `$?` immediately
after each command, never off a pipe.

### Registry state, measured 2026-08-10

From the PyPI JSON API (`https://pypi.org/pypi/<pkg>/json`). "Direct" means a
declared dependency of `apps/workers` rather than something another package
brings transitively.

| Package                    | Latest  | **Pin**   | Direct?                         |
| -------------------------- | ------- | --------- | ------------------------------- |
| `temporalio`               | 1.31.0  | `1.31.0`  | yes (dep)                       |
| `pydantic`                 | 2.13.4  | `2.13.4`  | yes (dep)                       |
| `pydantic-settings`        | 2.15.0  | `2.15.0`  | yes (dep)                       |
| `structlog`                | 26.1.0  | `26.1.0`  | yes (dep)                       |
| `boto3`                    | 1.43.67 | `1.43.67` | yes (dep)                       |
| `botocore`                 | 1.43.67 | `1.43.67` | **no** — from `boto3`           |
| `protobuf`                 | 7.35.1  | `7.35.1`  | **no** — from `temporalio`      |
| `trimesh`                  | 5.0.0   | `5.0.0`   | yes (dep) — geometry worker     |
| `numpy`                    | 2.5.2   | `2.5.2`   | **no** — from `trimesh`         |
| `ruff`                     | 0.16.2  | `0.16.2`  | yes (dev)                       |
| `mypy`                     | 2.3.0   | `2.3.0`   | yes (dev)                       |
| `pytest`                   | 9.1.1   | `9.1.1`   | yes (dev)                       |
| `pytest-asyncio`           | 1.4.0   | `1.4.0`   | yes (dev)                       |
| `datamodel-code-generator` | 0.72.2  | `0.72.2`  | yes (dev)                       |
| `boto3-stubs[s3]`          | 1.43.67 | `1.43.67` | yes (dev) — **mandatory**       |
| `botocore-stubs`           | 1.43.67 | `1.43.67` | **no** — from `boto3-stubs`     |
| `mypy-boto3-s3`            | 1.43.66 | `1.43.66` | **no** — from `boto3-stubs[s3]` |
| `types-s3transfer`         | 0.16.0  | `0.16.0`  | **no** — from `boto3-stubs`     |

Toolchain, not packages:

| Tool                    | **Pin**   | Notes                                                                |
| ----------------------- | --------- | -------------------------------------------------------------------- |
| CPython                 | `3.12.13` | already in `.python-version`; `mise.toml` floats the patch as `3.12` |
| `uv`                    | `0.12.3`  | released 2026-08-07                                                  |
| `temporalio/auto-setup` | `1.29.7`  | **not** `:latest` — see below                                        |

`boto3-stubs[s3]` was **not** on the plan's list and is not optional — see
"What did not work". `mypy-boto3-s3` resolving one patch behind `boto3` itself
(`1.43.66` against `1.43.67`) is normal for that family and was measured
working; it is recorded so the skew is not mistaken for a resolution error.

### `requires_python`, checked before installing

This is the step that mattered. Answered per package from the same metadata,
against the declared classifiers, **before** `uv add` was run once.

| Package                    | `requires_python` | Python classifiers | 3.12   | 3.13   | 3.14       |
| -------------------------- | ----------------- | ------------------ | ------ | ------ | ---------- |
| `temporalio`               | `>=3.10`          | 3.10 – 3.14        | **in** | **in** | in         |
| `pydantic`                 | `>=3.9`           | 3.9 – 3.14         | **in** | **in** | in         |
| `pydantic-settings`        | `>=3.10`          | 3.10 – 3.14        | **in** | **in** | in         |
| `structlog`                | `>=3.10`          | 3.10 – 3.15        | **in** | **in** | in         |
| `boto3` / `botocore`       | `>=3.10`          | 3.10 – 3.14        | **in** | **in** | in         |
| `ruff`                     | `>=3.7`           | 3.7 – 3.14         | **in** | **in** | in         |
| `mypy`                     | `>=3.10`          | 3.10 – 3.15        | **in** | **in** | in         |
| `pytest`                   | `>=3.10`          | 3.10 – 3.15        | **in** | **in** | in         |
| `pytest-asyncio`           | `>=3.10`          | 3.10 – 3.14        | **in** | **in** | in         |
| `datamodel-code-generator` | `>=3.10`          | 3.10 – 3.14        | **in** | **in** | in         |
| `trimesh`                  | `>=3.10`          | **3.10 – 3.13**    | **in** | **in** | **absent** |

**No package excludes 3.12, and no package excludes 3.13.** Nothing here decides
the major by exclusion, so the blueprint's 3.12 stands on its own terms rather
than by elimination. The one asymmetry is `trimesh@5.0.0`, whose classifiers
stop at 3.13 — its `requires_python` has no upper bound, so it would _install_
on 3.14 with no warning at all, which is precisely the shape this check exists
to catch. It is the constraint to watch, and it is the only one.

Wheel availability was checked separately, because `requires_python` describes
intent and a wheel describes reality. Ten of the twelve are pure Python
(`py3-none-any`). `mypy` ships a compiled `cp312` wheel plus a pure fallback.
`temporalio` ships **`cp310-abi3`** wheels only — the stable ABI, forward
compatible — so 3.12 gets a binary wheel and never builds its Rust core from
source, and `manylinux_2_17` covers `python:3.12-slim-bookworm` on both
`x86_64` and `aarch64`.

### Gate results

`uv` 0.12.3, CPython 3.12.13, cold `.venv`. Exit codes read from `$?`
immediately after each command.

| Gate                                           | Exit  | Evidence beyond the exit code                                          |
| ---------------------------------------------- | ----- | ---------------------------------------------------------------------- |
| `uv init --python 3.12`                        | **0** | resolved CPython 3.12.13                                               |
| `uv add` (5 runtime)                           | **0** | 20 packages, **zero resolution warnings**                              |
| `uv add --dev` (5 dev)                         | **0** | 27 packages, zero warnings — but see `black`/`isort` below             |
| `uv add trimesh`                               | **0** | pulled `numpy==2.5.2`                                                  |
| `uv add --dev 'boto3-stubs[s3]'`               | **0** | 5 packages                                                             |
| `uv run python spike_check.py`                 | **0** | structlog emitted `{"ok": true, "event": "spike"}` — JSON, not console |
| `uv run mypy --strict spike_check.py`          | **0** | see the bait file below; **0 here is not evidence on its own**         |
| `uv run ruff check spike_check.py`             | **1** | 6 findings on deliberately sloppy source — a pass, not a failure       |
| negative assertions (money, settings)          | **0** | 11 bad money strings rejected, prefix honoured, unprefixed ignored     |
| `mypy --strict` on a deliberately wrong file   | **1** | 7 errors; every bait line reported                                     |
| `datamodel-codegen` (default flags)            | **0** | output **not** deterministic — see below                               |
| `datamodel-codegen` (final recipe)             | **0** | three runs byte-identical by `sha256`                                  |
| `docker run temporalio/auto-setup:latest`      | **1** | container **exited 1** — see "What did not work"                       |
| `uv run python spike_connect.py`               | **0** | `connected, namespace: default` against `auto-setup:1.29.7`            |
| end-to-end worker + workflow + activity        | **0** | real workflow executed and its pydantic payload round-tripped          |
| sandbox rejects `datetime.now()` in a workflow | —     | `RestrictedWorkflowAccessError`, as required                           |

`RUFF_EXIT=1` is a pass for the same reason `LINT_EXIT=1` was in ADR-0021: the
run was pointed at source written to be wrong. What matters is _which_ rules
fired — `I001`, `F401`, `BLE001` — because a linter that exits 1 on nothing in
particular is a linter nobody has checked.

**The money boundary was verified negatively, which is the assertion that
matters.** `Money(amount_minor="3500.00")` raises `ValidationError`
(`string_pattern_mismatch`), and so do `"3.5e5"`, `"0350"`, `"+350"`, `"-0"`,
`""`, `" 350"`, `"350 "`, `"abc"` and `"1_000"`. An `int` is **not** coerced to
`str` (`string_type`) — pydantic v2 does not widen there, so a Python caller
cannot smuggle a machine integer through the field that exists to keep money out
of floats. `exponent` rejects `-1`, `5` and `100`. `"0"`, `"350000"`,
`"-350000"` and a 40-digit value are accepted and round-trip unchanged.

**`pydantic-settings` was verified to actually read the environment.** The
plan's snippet only asserts a default, which is exactly what a settings library
that silently did nothing would also produce. Measured: `METRIKA_S3_BUCKET` and
`METRIKA_TEMPORAL_ADDRESS` are honoured, an **unprefixed** `TEMPORAL_ADDRESS` is
correctly ignored, and a missing required setting raises rather than defaulting.

## Decision

**Pin Python 3.12.13** and the tables above. `apps/workers` targets 3.12, as the
blueprint said, now on measurement rather than on assertion.

Seven things the spike proved are required, and are therefore obligations on
Plan 0B-3 Tasks 2–6 rather than suggestions.

1. **`uv.lock` is committed, and CI runs `uv sync --frozen`.** `uv add` writes
   **`>=` ranges** into `pyproject.toml` (`temporalio>=1.31.0`), not pins. The
   exact versions in this ADR's table live only in `uv.lock`. A workflow that
   runs a bare `uv sync` re-resolves and every pin above becomes decorative —
   this is the Python-side twin of a lockfile-less `pnpm install`.

2. **`uv` is pinned in `mise.toml`, not inherited.** See below.

3. **`boto3-stubs[s3]@1.43.67` is a declared dev dependency.** `boto3` and
   `botocore` are the only two packages here that ship **no `py.typed`** marker.
   Without the stubs, `mypy --strict` reports `import-untyped` on the import and
   every S3 call is unchecked `Any`. With them, `boto3.client("s3")` resolves to
   `S3Client` and a wrong `Key` type is a type error. The failure mode without
   them is the dangerous one: relaxing `--strict` or adding
   `ignore_missing_imports` silences the import error and leaves the whole S3
   surface untyped, with nothing to show that it happened.

4. **`datamodel-codegen` runs with `--disable-timestamp --use-annotated
--formatters ruff-format ruff-check`.** All four are load-bearing; none is
   stylistic. See the three codegen answers below.

5. **The codegen gate imports the generated module.** `mypy --strict`, `ruff
check` and `ruff format --check` all exit **0** on a generated model that
   cannot be imported. Only an import catches it.

6. **A module defining a `@workflow.defn` contains no module-scope side
   effects.** Temporal's sandbox re-executes that module to build its
   deterministic import graph. Workflow definitions live in their own module and
   the process entrypoint stays behind `if __name__ == "__main__":`.

7. **`pyproject.toml` sets `asyncio_mode = "auto"` under
   `[tool.pytest.ini_options]`**, and the suite carries a test asserting an
   async test both runs and can fail.

### How `uv` is obtained

**By a developer: `mise.toml` gains `uv = "0.12.3"`,** beside the `node` and
`python` entries already there. This repository already uses `mise` to pin Node
24.19.0 and Python 3.12, and a second version manager would be a second thing to
get wrong.

That line is not cosmetic. On the machine this spike ran on, `uv` was **not on
`PATH`** and was reachable only through a _global_ `~/.config/mise/config.toml`
carrying `uv = "latest"` — an unpinned, unreviewed, per-machine version that no
checkout can reproduce and no reviewer ever saw. Every measurement in this ADR
would have been taken against whatever that global entry happened to resolve to
that morning. A project-scoped exact pin is what makes the table above mean
something on a second machine.

**By CI: `astral-sh/setup-uv@v9.0.0`** (released 2026-07-21), pinned to
`version: 0.12.3`, followed by `uv sync --frozen`. **No `actions/setup-python`
step is needed**, and this is measured rather than assumed: `uv` ignored `mise`'s
CPython entirely and provisioned its own `cpython-3.12.13-macos-aarch64-none`
from `.python-version`. So `uv` is the only thing CI has to install, and the
interpreter follows from a file already in the repository. This mirrors the
shape of the existing jobs, which install a tool and read the version from a
committed file (`node-version-file: .nvmrc`) rather than restating it in YAML.

### The three codegen answers

Task 4 commits the generated output and diffs it in CI, so all three are things
it needs to know in advance rather than discover.

1. **The pattern and the bounds survive — with the right flag.** By default the
   generator emits `constr(pattern=r'…')` and `conint(ge=0, le=4)`, so the
   constraints are carried and the boundary is not decorative. But those are
   **function calls in annotation position**, and `mypy --strict` rejects the
   file it just generated: `Invalid type comment or annotation [valid-type]`,
   `Cannot use a function call in a type annotation`, exit 1. `--use-annotated`
   emits `Annotated[str, Field(pattern="…")]` instead, which keeps every
   constraint and passes `mypy --strict` at exit 0. An `enum` becomes a
   `StrEnum`; numeric `minimum`/`maximum` become `Field(ge=…, le=…)`.

2. **Deterministic only with `--disable-timestamp`.** The default output carries
   a `#   timestamp: 2026-08-10T08:25:36+00:00` header, and two runs seconds
   apart differ on exactly that line — `diff` exit **1**. Committed and diffed
   in CI, that gate is red on every run that is not in the same second as the
   last. With `--disable-timestamp`, three runs spaced over several seconds were
   byte-identical by `sha256`. Nothing else in the output was unstable: no
   dict-ordering wobble was observed across any run.

3. **`format: uuid` becomes `uuid.UUID`, and branding is erased.** Not `str`.
   The wire type therefore changes across the boundary: `model_dump()` yields a
   `UUID` _object_ while `model_dump_json()` yields the string again, so
   anything hand-assembling a payload from `model_dump()` will not produce JSON.
   And because every branded ID collapses to the same `UUID`, `quoteId` and
   `orgId` are **freely interchangeable** in Python — [ADR-0018](./0018-branded-types.md)'s
   type identity does not cross this boundary and cannot be made to. Python gets
   validation, not identity. Related: `format: date-time` becomes
   `AwareDatetime` and correctly rejects a naive datetime (`timezone_aware`),
   which is a genuine gain; `format: uri` becomes `AnyUrl`.

### The Temporal image tag

**Pin `temporalio/auto-setup:1.29.7`**, and add a row to
[`IMAGE_PINS.md`](../../infra/docker/IMAGE_PINS.md) when Task 5 adds the service
— `infra/docker/docker-compose.yml` currently runs postgres, redis, minio and
mailpit, and has no Temporal service at all.

`:latest` is what a spike uses and what a compose file must not, and here that
is not a stylistic point. **`temporalio/auto-setup:latest` resolves to 1.29.3** —
digest `sha256:9be7b8d9…`, shared with tags `1.29.3` and `1`, while `1.29.7` is
published. The tag named "latest" is four patch releases stale, so a compose
file using it would pin _older_ than one naming a version, silently, with the
word "latest" on screen to say otherwise.

`auto-setup` is the right image for local development specifically because it
provisions the default namespace and search attributes on first boot; it is not
a production topology, and Temporal Cloud ([ADR-0006](./0006-temporal.md)) is
what production uses.

### Fallback

If any integration fails during Tasks 2–6, the fallback is **Python 3.13**, not
3.11 and not a different library. Every package in the table declares 3.13 in
both `requires_python` and its classifiers, `temporalio`'s `cp310-abi3` wheel
covers it without a rebuild, and ten of the twelve are pure Python — so the
move costs `.python-version`, `mise.toml`, the `--target-python-version` flag
and the base image tag, and nothing else.

The condition needs a trigger measurement rather than "if it fails", so:

| Integration        | Trigger measurement that justifies moving off 3.12                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`temporalio`**   | A published release whose `requires_python` lower bound exceeds 3.12, **or** an end-to-end workflow that fails on 3.12 and passes unchanged on 3.13. Import success is not evidence; the worker must execute a workflow. |
| **`trimesh`**      | A release this project needs whose classifiers **drop** 3.12. This is the one package whose classifiers already stop short of the newest major, so it is the likely first mover in either direction.                     |
| **codegen**        | `datamodel-codegen` emitting output on 3.12 that `mypy --strict` rejects under `--use-annotated`, where the same input on 3.13 passes.                                                                                   |
| **the base image** | `python:3.12-slim-bookworm` leaving security support. 3.12 is in security-only maintenance and is supported to **2028-10**, so this is the slow, scheduled trigger rather than a surprise.                               |

**A move to 3.14 is explicitly _not_ the fallback today**, and the reason is one
measurement: `trimesh@5.0.0` classifies 3.10–3.13 and its `requires_python` has
no upper bound, so it would install on 3.14 with no warning and no error — the
exact silent-degradation shape that cost this repository its type-aware linting.
Taking 3.14 requires re-running this check against a `trimesh` release that
claims it.

## Alternatives

- **Python 3.13**, the newer supported major. Rejected on the blueprint plus a
  tie: nothing excludes it and nothing requires it, so it buys no capability
  this plan needs while diverging from `ARCHITECTURE.md`, `mise.toml`,
  `.python-version` and the documented `python:3.12-slim-bookworm` base image
  all at once. It is kept as the fallback precisely because the spike found no
  obstacle to it — a fallback nobody has measured is a wish.
- **`pip` + `venv`, or Poetry, instead of `uv`.** Rejected: `uv` produces a
  cross-platform `uv.lock` with a resolution valid for a declared
  `requires-python` range, and it provisions the interpreter itself, which
  removed the `actions/setup-python` step from CI. Poetry would reintroduce a
  second tool to pin and a lock format with no interpreter management.
- **A global or `curl | sh` install of `uv`.** Rejected, and this is the
  situation the spike actually found: an unpinned global `uv = "latest"` that no
  checkout reproduces. It is what makes "works on my machine" unarguable in the
  wrong direction.
- **Let `mise` provide the interpreter and have `uv` use it.** Not chosen
  because it is not what happens: `uv` provisioned its own CPython 3.12.13 and
  ignored `mise`'s, and both happened to be 3.12.13 so nothing looked wrong.
  Fighting that would add configuration to make two tools agree about something
  `.python-version` already states. The consequence is recorded below.
- **Skip stubs and relax `mypy` for `boto3`.** Rejected: it converts a loud
  `import-untyped` error into a silently `Any`-typed S3 surface, in the one part
  of the worker that touches storage the workers are otherwise not allowed to
  reach directly.

## Consequences

### What did not work

A spike reporting unqualified success is the one to distrust. Six things broke
or surprised, and one of them is a defect in code already committed.

**The same money regex means two different things on the two sides of the
boundary.** This is the spike's most valuable finding and it is not
hypothetical: `packages/contracts/src/money.ts:28` ships
`/^(0|-?[1-9]\d*)$/`. In JavaScript `\d` is ASCII-only, so Zod is correct
today. In Python — both `re` and the Rust engine pydantic uses — **`\d` matches
any Unicode decimal digit**. Measured with that exact pattern:

| Input   | pydantic | Node regex | `BigInt()`           | `int()` |
| ------- | -------- | ---------- | -------------------- | ------- |
| `3٥٠`   | ACCEPTED | no match   | throws `SyntaxError` | `350`   |
| `3５０` | ACCEPTED | no match   | throws `SyntaxError` | `350`   |
| `1৪`    | ACCEPTED | no match   | throws `SyntaxError` | `14`    |

So the moment that schema is emitted to JSON Schema and generated into a
pydantic model, **the Python side becomes strictly more permissive than the
TypeScript side that defines it** — and Python would compute happily with `350`
on a value TypeScript refuses to parse at all. Writing the character class
explicitly, `^(0|-?[1-9][0-9]*)$`, was measured to accept and reject _identically_
in both engines. The emitted pattern must be engine-independent, because the
whole point of one schema is that both sides agree. This is a defect in
`packages/contracts`, not in the toolchain, and it is recorded here because this
is where it was found.

**`temporalio/auto-setup:latest` does not start.** The plan's Step 7 command,
run verbatim, exits 1:

```
TEMPORAL_ADDRESS is not set, setting it to 172.17.0.2:7233
CASSANDRA_SEEDS env must be set if DB is cassandra.
```

The image defaults to Cassandra and there is no single-container form of it. A
Postgres backend and four environment variables (`DB=postgres12`,
`POSTGRES_SEEDS`, `POSTGRES_USER`, `POSTGRES_PWD`) plus a shared network is what
actually boots — which is fine, because `infra/docker/docker-compose.yml`
already runs Postgres. `docker run` exiting 0 is not the signal here; the
container exited 1 twenty seconds later, and only `docker ps -a` showed it.

**The Temporal sandbox re-executes the workflow's module.** The first end-to-end
attempt failed with `RuntimeError: Failed validating workflow QuoteWorkflow`,
caused by `asyncio.run() cannot be called from a running event loop` — the
module-scope `asyncio.run(main())` in the same file as the `@workflow.defn` was
re-entered by the sandbox while it built its import graph. Splitting definitions
into their own side-effect-free module fixed it and the workflow then ran
end to end. Hence obligation 6. The sandbox itself was then verified to be doing
its job rather than merely present: `datetime.now()` inside a workflow raises
`RestrictedWorkflowAccessError`, which is the enforcement behind this
repository's workflow-determinism rule.

**Codegen produces a file that passes every static gate and cannot be
imported.** A schema with `format: email` generates `EmailStr`, which needs the
optional `email-validator` package. Without it, `datamodel-codegen` exits 0,
`ruff check` passes, `ruff format --check` passes, and `mypy --strict` reports
`Success: no issues found` — and `import ids_model` raises `ImportError:
email-validator is not installed`. Three green gates and a broken artifact.
Hence obligation 5.

**`datamodel-code-generator` installs `black` and `isort`** — 19 transitive
packages, including a second formatter that disagrees with the one this repo
would use. The default output is single-quoted and `ruff format --check` exits 1
on it, so a committed generated file would fail `format:check` forever. It also
warns on every run:

> `FutureWarning: The default external formatters (black, isort) will become
opt-in in a future version.`

Passing `--formatters ruff-format ruff-check` fixes the formatting, silences the
warning, and pins the behaviour before that default changes underneath us. The
flag takes **space-separated** values; repeating `--formatters` keeps only the
last, which looks identical on the command line and silently applies one
formatter instead of two.

**`uv` ignored `mise`'s interpreter.** `mise` resolves `python = "3.12"` to
3.12.13, and `uv` provisioned its own `cpython-3.12.13` under
`~/.local/share/uv/python/` regardless. Both are 3.12.13, so nothing looked
wrong and nothing would have — this is recorded because two independent Python
installations agreeing today is not the same as one source of truth, and the
next person to debug a version discrepancy will need to know there are two
places to look. `.python-version` is what both read, which is why it, and not
`mise.toml`'s floating `3.12`, is the file that pins the patch.

**Benign, but recorded.** `ruff@0.16.2` enables far more than the historical
`E4,E7,E9,F` default: with `--isolated` and no configuration at all, `I001`
(import sorting), `DTZ005` (`datetime.now()` without a timezone), `S110` and
`BLE001` all fire. Task 3 should therefore choose its rule set deliberately
rather than inherit one — and note that `DTZ005` happens to enforce something
this project wants anyway. Separately, `pytest@9.1.1` **fails** an unmarked
async test rather than skipping it with a warning, which closes the vacuous-pass
hazard that made `asyncio_mode` a footgun in older pytest; obligation 7 still
stands, because the fix for that failure must be configuration rather than a
developer quietly deleting the test.

### What is now true

**Accepted:** every version above is a floor in `pyproject.toml` and a pin only
in `uv.lock`, so the lockfile is load-bearing in a way `package.json`'s exact
pins are not — a `uv sync` without `--frozen` silently re-resolves the whole
table. `apps/workers` carries a generated model whose correctness depends on
four codegen flags, and three of this repository's static gates were measured
unable to tell whether that model imports. Branded IDs stop at the Python
boundary and cannot be recovered there. Two Python installations exist on a
developer machine and agree only by coincidence of version. The spike never
exercised `trimesh` on a real mesh, never ran a slicer, and never connected to
Temporal Cloud — only a local `auto-setup` container — so TLS, namespaces and
mTLS credentials are unverified.

**Gained:** every pin Tasks 2–6 install was measured against this project's
actual Python major on the day, with `requires_python` answered _before_
installation rather than inferred from a successful one. All five integrations
were verified by evidence that a no-op could not produce — a rejected decimal
string, an honoured environment prefix, a constraint surviving codegen, a bait
file producing seven type errors, and a real workflow executing through a real
server — rather than by the absence of an error. And the check found a live
defect in `packages/contracts` that no TypeScript test could ever have seen,
because on the TypeScript side the pattern is correct.
