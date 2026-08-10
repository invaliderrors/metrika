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

Because an install exiting 0 is weak evidence, each of the six integrations was
additionally exercised for the shape it would take _if it silently did nothing_:
settings that ignore the environment and return defaults, a money model that
accepts a decimal string, codegen that drops its constraints, a type checker
that checks nothing, a Temporal client that imports but cannot run a worker, and
a geometry library that answers a question it should refuse.

The spike ran in two rounds, each in a throwaway directory outside the workspace
(`mktemp -d`), on uv 0.12.3 and CPython 3.12.13, with a real Temporal server and
Postgres in Docker, and both were destroyed afterwards. Exit codes were read
from `$?` immediately after each command, never off a pipe.

**The second round exists because the first round's write-up was reviewed
against a re-measurement rather than against a reading, and five of its claims
moved.** Those corrections are marked in place throughout rather than quietly
folded in, because which claims survived independent re-measurement is itself
information — and because a spike document that never records being wrong is
indistinguishable from one nobody checked.

### Registry state, measured 2026-08-10

From the PyPI JSON API (`https://pypi.org/pypi/<pkg>/json`). "Direct" means a
declared dependency of `apps/workers` rather than something another package
brings transitively.

| Package                    | Latest  | **Pin**   | Direct?                                |
| -------------------------- | ------- | --------- | -------------------------------------- |
| `temporalio`               | 1.31.0  | `1.31.0`  | yes (dep)                              |
| `pydantic`                 | 2.13.4  | `2.13.4`  | yes (dep)                              |
| `pydantic-settings`        | 2.15.0  | `2.15.0`  | yes (dep)                              |
| `structlog`                | 26.1.0  | `26.1.0`  | yes (dep)                              |
| `boto3`                    | 1.43.67 | `1.43.67` | yes (dep)                              |
| `botocore`                 | 1.43.67 | `1.43.67` | **no** — from `boto3`                  |
| `protobuf`                 | 7.35.1  | `7.35.1`  | **no** — from `temporalio`             |
| `trimesh[easy]`            | 5.0.0   | `5.0.0`   | yes (dep) — **the extra is mandatory** |
| `numpy`                    | 2.5.2   | `2.5.2`   | **no** — from `trimesh`                |
| `networkx`                 | 3.6.1   | `3.6.1`   | **no** — from `trimesh[easy]`          |
| `lxml`                     | 6.1.1   | `6.1.1`   | **no** — from `trimesh[easy]`          |
| `ruff`                     | 0.16.2  | `0.16.2`  | yes (dev)                              |
| `mypy`                     | 2.3.0   | `2.3.0`   | yes (dev)                              |
| `pytest`                   | 9.1.1   | `9.1.1`   | yes (dev)                              |
| `pytest-asyncio`           | 1.4.0   | `1.4.0`   | yes (dev)                              |
| `datamodel-code-generator` | 0.72.2  | `0.72.2`  | yes (dev)                              |
| `boto3-stubs[s3]`          | 1.43.67 | `1.43.67` | yes (dev) — **mandatory**              |
| `botocore-stubs`           | 1.43.67 | `1.43.67` | **no** — from `boto3-stubs`            |
| `mypy-boto3-s3`            | 1.43.66 | `1.43.66` | **no** — from `boto3-stubs[s3]`        |
| `types-s3transfer`         | 0.16.0  | `0.16.0`  | **no** — from `boto3-stubs`            |

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

**`trimesh[easy]`, not bare `trimesh`**, and the extra is likewise not optional:
the bare pin cannot export 3MF at all. Bare `trimesh` is 3 packages;
`trimesh[easy]` is 31. See "What did not work".

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

The transitives matter as much as the direct dependencies, because a bound
inherited through a dependency constrains the interpreter just as hard as a
declared one. They were omitted from the first version of this table, which made
its central claim look weaker than the evidence actually supports:

| Package (transitive) | `requires_python` | Classifiers | 3.12   | 3.13   | 3.14                |
| -------------------- | ----------------- | ----------- | ------ | ------ | ------------------- |
| `numpy`              | **`>=3.12`**      | 3.12 – 3.15 | **in** | **in** | in                  |
| `protobuf`           | `>=3.10`          | 3.10 – 3.14 | **in** | **in** | in                  |
| `networkx`           | `!=3.14.1,>=3.11` | 3.11 – 3.14 | **in** | **in** | **excludes 3.14.1** |
| `lxml`               | `>=3.8`           | 3.8 – 3.14  | **in** | **in** | in                  |
| `boto3-stubs`        | `>=3.9`           | 3.9 – 3.14  | **in** | **in** | in                  |
| `botocore-stubs`     | `>=3.10`          | 3.9 – 3.15  | **in** | **in** | in                  |
| `mypy-boto3-s3`      | `>=3.9`           | 3.9 – 3.14  | **in** | **in** | in                  |
| `types-s3transfer`   | `>=3.9`           | 3.9 – 3.14  | **in** | **in** | in                  |

**No package excludes 3.12, and no package excludes 3.13.** Nothing here decides
the major by exclusion in the upward direction, so the blueprint's 3.12 stands
on its own terms rather than by elimination.

Downward is a different story, and this is the bound that does real work:
**`numpy@2.5.2` requires `>=3.12`.** It is the only genuinely restrictive lower
bound in the whole set, it arrives transitively through `trimesh`, and it
forecloses 3.11 as a fallback on measurement rather than on preference. Every
other lower bound in both tables is `>=3.10` or looser.

Two upper-edge asymmetries are worth naming. `trimesh@5.0.0`'s classifiers stop
at 3.13 while its `requires_python` has no upper bound, so it would _install_ on
3.14 with no warning at all — precisely the shape this check exists to catch.
And `networkx@3.6.1`, which `trimesh[easy]` pulls, carries `!=3.14.1` — a
surgical exclusion of a single patch release, which is the rarer and more
easily-missed form of the same hazard.

Wheel availability was checked separately, because `requires_python` describes
intent and a wheel describes reality. **Nine** of the twelve are pure Python
(`py3-none-any`). The other three all ship platform-specific wheels:

- `temporalio` ships **`cp310-abi3`** only — the stable ABI, forward compatible —
  so 3.12 gets a binary wheel and never builds its Rust core from source, and
  `manylinux_2_17` covers `python:3.12-slim-bookworm` on `x86_64` and `aarch64`.
- `mypy` ships a compiled `cp312` wheel plus a `py3-none-any` fallback.
- `ruff` ships **17 platform wheels and no pure fallback at all** — every one is
  `py3-none-<platform>`, e.g. `ruff-0.16.2-py3-none-macosx_11_0_arm64.whl`.

`ruff` was miscounted as pure in the first version of this table, because the
`py3` interpreter tag reads as portable and the platform tag is the part that
matters. That correction strengthens the conclusion rather than weakening it:
three of the twelve depend on a wheel existing for the target platform, so the
platform matrix is a real constraint on this toolchain and not a formality.

### Gate results

`uv` 0.12.3, CPython 3.12.13, cold `.venv`. Exit codes read from `$?`
immediately after each command.

| Gate                                           | Exit  | Evidence beyond the exit code                                                         |
| ---------------------------------------------- | ----- | ------------------------------------------------------------------------------------- |
| `uv init --python 3.12`                        | **0** | resolved CPython 3.12.13                                                              |
| `uv add` (5 runtime)                           | **0** | 20 packages, **zero resolution warnings**                                             |
| `uv add --dev` (5 dev)                         | **0** | 27 packages, zero warnings — but see `black`/`isort` below                            |
| `uv add trimesh`                               | **0** | pulled `numpy==2.5.2` — **and cannot export 3MF; see below**                          |
| `box.export(file_type="3mf")`, bare `trimesh`  | —     | raises `ModuleNotFoundError: networkx`, then `lxml`                                   |
| `box.export(file_type="3mf")`, `trimesh[easy]` | **0** | 1290 bytes; round-trip `is_watertight=True`, `volume=6000.0`                          |
| `volume` on a non-watertight mesh              | —     | returns **3000.0** where the solid is 6000.0 — see below                              |
| `uv add --dev 'boto3-stubs[s3]'`               | **0** | 5 packages                                                                            |
| `uv run python spike_check.py`                 | **0** | structlog emitted `{"ok": true, "event": "spike"}` — JSON, not console                |
| `uv run mypy --strict spike_check.py`          | **0** | see the bait file below; **0 here is not evidence on its own**                        |
| `uv run ruff check spike_check.py`             | **1** | 6 findings on deliberately sloppy source — a pass, not a failure                      |
| negative assertions (money, settings)          | **0** | 11 bad money strings rejected, prefix honoured, unprefixed ignored                    |
| `mypy --strict` on a deliberately wrong file   | **1** | 7 errors; every bait line reported                                                    |
| `datamodel-codegen` (default flags)            | **0** | output **not** deterministic — see below                                              |
| `datamodel-codegen` (final recipe)             | **0** | three runs byte-identical by `sha256`                                                 |
| the same recipe, after adding `[tool.ruff]`    | **0** | **different bytes** — output depends on the repo's ruff config                        |
| `format: date-time` **+** `pattern`, all gates | **0** | ruff 0, ruff-format 0, mypy 0, **import 0** — and every validation raises `TypeError` |
| `docker run temporalio/auto-setup:latest`      | **1** | container **exited 1** — see "What did not work"                                      |
| `uv run python spike_connect.py`               | **0** | `connected, namespace: default` against `auto-setup:1.29.7`                           |
| end-to-end worker + workflow + activity        | **0** | real workflow executed and its pydantic payload round-tripped                         |
| sandbox rejects `datetime.now()` in a workflow | —     | `RestrictedWorkflowAccessError`, as required                                          |

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

Nine things the spike proved are required, and are therefore obligations on
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

5. **The codegen gate instantiates the generated model and validates a payload
   through it.** Importing is not enough, and this obligation was weaker in the
   first version of this ADR until it was measured. `mypy --strict`, `ruff
check` and `ruff format --check` all exit **0** on a model that cannot be
   imported (`format: email`), and all of those _plus a successful import_ exit
   **0** on a model where every single validation raises an uncaught `TypeError`
   (`format: date-time` carrying a `pattern`). Only round-tripping a real
   payload separates a generated model that works from one that merely loads.

6. **The codegen output is regenerated whenever `ruff`, the ruff configuration,
   or `--target-python-version` changes**, and those changes land in the same
   commit as the regenerated file. The generated bytes are a function of all
   three, not of the schema alone — so Task 3 (which writes the ruff config) and
   Task 4 (which commits and diffs the output) are coupled, and nothing else
   says so.

7. **`trimesh[easy]@5.0.0`, never bare `trimesh`.** The bare pin cannot export
   3MF, which is the one thing `ARCHITECTURE.md` requires the geometry worker to
   produce, and it fails only when called. See "What did not work".

8. **A module defining a `@workflow.defn` contains no module-scope side
   effects.** Temporal's sandbox re-executes that module to build its
   deterministic import graph. Workflow definitions live in their own module and
   the process entrypoint stays behind `if __name__ == "__main__":`.

9. **`pyproject.toml` sets `asyncio_mode = "auto"` under
   `[tool.pytest.ini_options]`**, and the suite carries a test asserting an
   async test both runs and can fail.

### How `uv` is obtained

**By a developer: `mise.toml` gains `uv = "0.12.3"`,** beside the `node` and
`python` entries already there. This repository already uses `mise` for both
other toolchains, and a second version manager would be a second thing to get
wrong.

Note the shape of what is already there, because the `uv` entry deliberately
breaks it. `mise.toml` **floats both majors** — `node = "24"`, `python = "3.12"`
— and the exact patch lives in a separate file that the ecosystem's own tools
read: `.nvmrc` at `24.19.0`, `.python-version` at `3.12.13`. `uv` has no such
companion file, so its `mise.toml` entry has to carry the exact version itself.
It is the one floating-vs-pinned exception in that file, and it is the reason
`uv = "0.12.3"` is written out in full rather than as `"0.12"`.

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

2. **Deterministic in time with `--disable-timestamp` — but not independent of
   the toolchain.** The default output carries a
   `#   timestamp: 2026-08-10T08:25:36+00:00` header, and two runs seconds apart
   differ on exactly that line — `diff` exit **1**. Committed and diffed in CI,
   that gate is red on every run that is not in the same second as the last.
   With `--disable-timestamp`, three runs spaced over several seconds were
   byte-identical by `sha256`, with no dict-ordering wobble.

   That only settles time, which is the question as originally asked and the
   wrong question to stop at. The output is also a function of **the installed
   `ruff` and the repository's own ruff configuration**, because
   `--formatters ruff-format` runs the real formatter over the result. Measured:
   adding a `[tool.ruff] line-length` — exactly what obligation 4 has Task 3 do —
   rewrites the file.

   ```diff
   -    amountMinor: Annotated[str, Field(pattern="^(0|-?[1-9][0-9]*)$")]
   +    amountMinor: Annotated[
   +        str, Field(pattern="^(0|-?[1-9][0-9]*)$")
   +    ]
   ```

   So Task 3 and Task 4 are coupled, and the coupling is invisible from either
   side: a ruff-config change in Task 3's file turns Task 4's CI diff red in a
   file Task 3 never touched. Hence obligation 6. A diff gate that goes red for
   a reason unrelated to its subject is the kind of gate that gets disabled, and
   then it is not a gate.

   `--target-python-version` is a third input, and it was measured rather than
   assumed: 3.10, 3.12 and 3.13 produce **byte-identical** output, so the 3.13
   fallback below does not by itself change the committed model. It changes at
   **3.14**, which drops the `from __future__ import annotations` line. The
   obligation is still to regenerate and diff on any change to the flag, because
   "identical on the three schemas tested" is not "identical for all schemas".

3. **`format: uuid` becomes `uuid.UUID`, and branding is erased.** Not `str`.
   The wire type therefore changes across the boundary: `model_dump()` yields a
   `UUID` _object_ while `model_dump_json()` yields the string again, so
   anything hand-assembling a payload from `model_dump()` will not produce JSON.
   And because every branded ID collapses to the same `UUID`, `quoteId` and
   `orgId` are **freely interchangeable** in Python — [ADR-0018](./0018-branded-types.md)'s
   type identity does not cross this boundary and cannot be made to. Python gets
   validation, not identity. Related: `format: date-time` becomes
   `AwareDatetime` and correctly rejects a naive datetime (`timezone_aware`),
   which is a genuine gain **provided the schema carries no `pattern` alongside
   it** — that combination generates a model that loads and then raises on every
   payload, and it is what `z.iso.datetime()` emits by default. `format: uri`
   becomes `AnyUrl`. `format: email` becomes `EmailStr` and needs a dependency
   nothing declares. Both traps are in "What did not work".

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

The service needs **five** environment variables, not four: `DB=postgres12`,
`POSTGRES_SEEDS`, `POSTGRES_USER`, `POSTGRES_PWD` and — the one that is easy to
omit — **`DB_PORT=5432`**. `DB_PORT` defaults to **3306**, MySQL's port. With
the other four set and `DB_PORT` left out, the container does not exit; it sits
`Up`, logging "Waiting for PostgreSQL" forever. That is a worse failure than the
Cassandra one below, because `docker ps` reports a healthy-looking container and
`docker compose up -d` returns 0 — the stack simply never becomes usable, and
the first symptom is a worker connection timeout with nothing obviously wrong
upstream.

### Fallback

If any integration fails during Tasks 2–6, the fallback is **Python 3.13**, not
3.11 and not a different library. Every package in both tables declares 3.13 in
`requires_python` and in its classifiers, `temporalio`'s `cp310-abi3` wheel
covers it without a rebuild, `ruff` and `mypy` both publish 3.13 wheels, and
nine of the twelve are pure Python anyway.

**3.11 is foreclosed by measurement, not by preference:** `numpy@2.5.2` requires
`>=3.12`, it arrives transitively through `trimesh`, and it is the only
genuinely restrictive lower bound in the dependency set. Going down a major
means pinning an older `numpy`, which means an older `trimesh`, which is the
package this ADR already names as the one to watch. There is no cheap step
downward.

The move to 3.13 costs `.python-version`, `mise.toml`, the base image tag, and
`--target-python-version` — where the flag was measured to produce **identical
bytes** at 3.12 and 3.13, so the committed model does not move. Regenerate and
diff it anyway, per obligation 6: the measurement covers the schemas tested, not
every schema Task 4 will emit.

The condition needs a trigger measurement rather than "if it fails", so:

| Integration         | Trigger measurement that justifies moving off 3.12                                                                                                                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`temporalio`**    | A published release whose `requires_python` lower bound exceeds 3.12, **or** an end-to-end workflow that fails on 3.12 and passes unchanged on 3.13. Import success is not evidence; the worker must execute a workflow.                                                                                         |
| **`trimesh[easy]`** | A release this project needs whose classifiers **drop** 3.12, **or** a 3MF export that fails on 3.12 and succeeds on 3.13. This is the one package whose classifiers already stop short of the newest major, and the one whose failure mode is lazy — so the trigger is an export actually run, never an import. |
| **codegen**         | `datamodel-codegen` emitting output on 3.12 that `mypy --strict` rejects under `--use-annotated`, where the same input on 3.13 passes.                                                                                                                                                                           |
| **the base image**  | `python:3.12-slim-bookworm` leaving security support. 3.12 is in security-only maintenance and is supported to **2028-10**, so this is the slow, scheduled trigger rather than a surprise.                                                                                                                       |

**A move to 3.14 is explicitly _not_ the fallback today**, and there are now
three measurements behind that rather than one. `trimesh@5.0.0` classifies
3.10–3.13 with no `requires_python` upper bound, so it would install on 3.14
with no warning and no error — the exact silent-degradation shape that cost this
repository its type-aware linting. `networkx@3.6.1`, which `trimesh[easy]`
pulls, excludes 3.14.1 specifically. And `--target-python-version 3.14` changes
the generated model's bytes, so the move is not free at the contract boundary
either. Taking 3.14 requires re-running all three checks.

## Alternatives

- **Python 3.13**, the newer supported major. Rejected on the blueprint plus a
  tie: nothing excludes it and nothing requires it, so it buys no capability
  this plan needs while diverging from `ARCHITECTURE.md`, `mise.toml`,
  `.python-version` and the documented `python:3.12-slim-bookworm` base image
  all at once. It is kept as the fallback precisely because the spike found no
  obstacle to it — a fallback nobody has measured is a wish.
- **Python 3.11 or lower.** Foreclosed by measurement rather than rejected by
  taste: `numpy@2.5.2` requires `>=3.12` and arrives through `trimesh`. Going
  down means pinning an older `numpy`, which means an older `trimesh`, which is
  already the package with the narrowest support window here.
- **Bare `trimesh`, with the extras added only when something needs them.** That
  was the original pin and it is wrong: 3MF export is the geometry worker's
  primary output, not an optional feature, and the missing dependencies raise
  only at call time. "Add it when it breaks" and "it breaks in production"
  describe the same policy for a lazily-imported exporter.
- **Post-process the emitted JSON Schema to rewrite `\d` as `[0-9]`.** Rejected
  for Zod's built-in formats: it means the emitter silently rewriting a regex the
  TypeScript side believes it owns, and any drift between the rewrite and Zod's
  real semantics reintroduces the divergence one layer further down while
  looking like a fix. Python-side tests per emitted format are weaker but
  honest. This is a live trade rather than a settled one — if the number of
  built-in formats in use grows past a handful, revisit it.
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

A spike reporting unqualified success is the one to distrust. Ten things broke
or surprised, two of them were defects in code already committed, and three were
found only when this ADR's own claims were re-measured rather than re-read.

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
is where it was found. Fixed in `e99fe7f`.

**It was the first of a family, and the second one runs the other way.**
`brand.ts`'s `UUID_PATTERN` carried an `/i` flag, and `z.toJSONSchema()`
**silently drops regex flags**. Zod therefore accepts `A1B2C3D4-…` while the
emitted pattern rejects it — the same class of divergence as the money regex, in
the opposite direction, affecting every branded ID in the system. Fixed in
`aeb92a7` by spelling the case into the character class, guarded by a test that
asserts on the **emitted** pattern rather than on the Zod schema. That guard is
the reusable lesson: a property of the schema object is not a property of the
JSON Schema it emits, and only the latter is what Python ever sees.

**And a third variant cannot be fixed in this repository at all.** Zod's own
built-in string formats carry `\d` in their emitted patterns, and they are
library internals:

| Zod builtin        | Emitted pattern (abridged)     |
| ------------------ | ------------------------------ |
| `z.e164()`         | `^\+[1-9]\d{6,14}$`            |
| `z.iso.datetime()` | `…\d{4}-…T(?:[01]\d\|2[0-3])…` |
| `z.iso.date()`     | `…\d\d[2468][048]…`            |
| `z.iso.time()`     | `^(?:[01]\d\|2[0-3]):[0-5]\d…` |

Measured on zod 4.4.3: `+1٥٠٥٠٥٠٥` is **rejected by Zod and accepted by the
generated pydantic model**. So the general instruction "fix any other emitted
`\d` the same way" is unfollowable for these — there is no project source to
edit. The answer, and this is a decision rather than an observation: **Task 4's
Python-side tests cover each built-in format the contracts actually emit**, with
a non-ASCII-digit case per format, rather than the emitter post-processing
patterns. Post-processing would mean rewriting a regex the TypeScript side
believes it owns, and a rewrite that drifts from Zod's semantics reintroduces the
same divergence one layer further down while looking like a fix. A test that
fails when a format's two sides disagree is honest about being a check rather
than a guarantee. `z.uuid()` is safe already — it emits explicit
`[0-9a-fA-F]` and no `\d`.

**`temporalio/auto-setup:latest` does not start.** The plan's Step 7 command,
run verbatim, exits 1:

```
TEMPORAL_ADDRESS is not set, setting it to 172.17.0.2:7233
CASSANDRA_SEEDS env must be set if DB is cassandra.
```

The image defaults to Cassandra and there is no single-container form of it. A
Postgres backend and **five** environment variables (`DB=postgres12`,
**`DB_PORT=5432`**, `POSTGRES_SEEDS`, `POSTGRES_USER`, `POSTGRES_PWD`) plus a
shared network is what actually boots — which is fine, because
`infra/docker/docker-compose.yml` already runs Postgres. `docker run` exiting 0
is not the signal here; the container exited 1 twenty seconds later, and only
`docker ps -a` showed it.

The first version of this ADR said four, having listed four while the command
that actually worked passed five. **`DB_PORT` defaults to 3306** — MySQL's port
— and omitting it produces a strictly worse failure than the Cassandra one: the
container stays `Up`, logging "Waiting for PostgreSQL" indefinitely. A container
that exits is visible in `docker ps -a`; one that idles looks correct in
`docker ps`, returns 0 from `docker compose up -d`, and surfaces first as a
worker connection timeout with no obviously broken dependency.

**The Temporal sandbox re-executes the workflow's module.** The first end-to-end
attempt failed with `RuntimeError: Failed validating workflow QuoteWorkflow`,
caused by `asyncio.run() cannot be called from a running event loop` — the
module-scope `asyncio.run(main())` in the same file as the `@workflow.defn` was
re-entered by the sandbox while it built its import graph. Splitting definitions
into their own side-effect-free module fixed it and the workflow then ran
end to end. Hence obligation 8. The sandbox itself was then verified to be doing
its job rather than merely present: `datetime.now()` inside a workflow raises
`RestrictedWorkflowAccessError`, which is the enforcement behind this
repository's workflow-determinism rule.

**`trimesh==5.0.0`, as this ADR originally pinned it, cannot export 3MF.**
`ARCHITECTURE.md` requires the geometry worker to produce the slice-input 3MF,
so the pin as recorded could not do the one job it exists for. On a bare
install, `mesh.export(file_type="3mf")` raises
`ModuleNotFoundError: No module named 'networkx'`; adding `networkx` alone moves
the failure to `lxml`. `trimesh[easy]` — 31 packages against bare `trimesh`'s 3 —
exports correctly: 1290 bytes, and the round-trip reloads as
`is_watertight=True` with `volume=6000.0` against a true solid volume of 6000.0.

**The failure is lazy, and that is the whole point.** `import trimesh` succeeds,
`trimesh.exchange.threemf` imports, and the 3MF exporter **registers itself in
the export registry** — the missing dependency raises only when the exporter is
actually called. So every check short of exporting a real mesh reports success.
This is the "installs, then silently does less than it appears to" shape this
ADR is written against, landing on the exact package the `requires_python` table
names as the constraint to watch, and it was missed the first time because
`trimesh` was version-checked but never run. An import check does not cover it;
nothing short of an export does. Hence obligation 7.

**`trimesh.volume` returns a plausible wrong number on a non-watertight mesh.**
This is the single most consequential measured property of the pinned library.
On a box with two faces removed:

```
is_watertight: False
volume:        3000.0      # the true solid volume is 6000.0
is_volume:     False
```

Not an error, not `NaN`, not zero — **exactly half**, and entirely reasonable
looking. `CLAUDE.md` is explicit that "a non-watertight mesh has **no** volume.
Return `null`, never a plausible-looking number", and this is precisely the
number that rule exists to keep out of a quote: a 50% material under-report that
no reviewer would flag by eye. The divisor-theorem surface integral trimesh uses
is well-defined on any triangle soup, so it always returns something.
`is_volume` (not `is_watertight` alone) is the reliable guard, and the geometry
worker must consult it **before** reading `.volume`, never after.

**Codegen produces a file that passes every static gate and cannot be
imported.** A schema with `format: email` generates `EmailStr`, which needs the
optional `email-validator` package. Without it, `datamodel-codegen` exits 0,
`ruff check` passes, `ruff format --check` passes, and `mypy --strict` reports
`Success: no issues found` — and `import ids_model` raises `ImportError:
email-validator is not installed`. Three green gates and a broken artifact.

**And a fourth gate is not enough either.** A schema carrying **both**
`format: date-time` and a `pattern` — which is exactly what `z.iso.datetime()`
emits by default — generates
`Annotated[AwareDatetime, Field(pattern="^\\d{4}-…")]`. Measured: `ruff check`
**0**, `ruff format --check` **0**, `mypy --strict` **0** `Success: no issues
found`, and `import` **0**. Then every single validation raises:

```
TypeError: Unable to apply constraint 'pattern' to supplied value
2026-08-10 00:00:00+00:00 for schema of type 'datetime'
```

A `TypeError`, not a `ValidationError` — so it is not a rejected payload, it is
an uncaught crash on the first real one, in a worker, at runtime. Four green
gates and a model that has never validated anything. This is why obligation 5
requires the gate to **instantiate and validate**, not import; the earlier
version of that obligation would have shipped this.

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
this project wants anyway, and that choosing it is not free, because the ruff
configuration is an input to the committed generated model (obligation 6).
Separately, `pytest@9.1.1` **fails** an unmarked async test rather than skipping
it with a warning, which closes the vacuous-pass hazard that made `asyncio_mode`
a footgun in older pytest; obligation 9 still stands, because the fix for that
failure must be configuration rather than a developer quietly deleting the test.

### What is now true

**Accepted:** every version above is a floor in `pyproject.toml` and a pin only
in `uv.lock`, so the lockfile is load-bearing in a way `package.json`'s exact
pins are not — a `uv sync` without `--frozen` silently re-resolves the whole
table. `apps/workers` carries a generated model whose correctness depends on
four codegen flags, on the pinned `ruff`, and on the ruff configuration a
different task owns; **four** of this repository's gates were measured unable to
distinguish a working generated model from one that raises on every payload.
Branded IDs stop at the Python boundary and cannot be recovered there. Three
Zod built-in formats emit patterns this repository cannot edit and can only
test. Two Python installations exist on a developer machine and agree only by
coincidence of version. The geometry worker must treat `trimesh` as a library
that answers plausibly when it should refuse — `is_volume` before `.volume`,
every time. The spike still never ran a slicer and never connected to Temporal
Cloud — only a local `auto-setup` container — so TLS, namespaces and mTLS
credentials remain unverified.

**Gained:** every pin Tasks 2–6 install was measured against this project's
actual Python major on the day, with `requires_python` answered _before_
installation rather than inferred from a successful one, and with the
transitives included, which is what turned "3.11 is not the fallback" from an
assertion into a consequence of `numpy>=3.12`. All five integrations were
verified by evidence that a no-op could not produce — a rejected decimal string,
an honoured environment prefix, a constraint surviving codegen, a bait file
producing seven type errors, and a real workflow executing through a real server
— rather than by the absence of an error. The check found two live defects in
`packages/contracts` that no TypeScript test could ever have seen, because on
the TypeScript side both patterns were correct.

**And the re-measurement earned its keep.** Re-running this ADR's own claims
instead of re-reading them found the 3MF export that never worked, the volume
that lies by exactly half, the `TypeError` behind four green gates, the fifth
Temporal environment variable, and a miscounted wheel — five things, in a
document whose entire argument is that an exit code is weak evidence. A spike is
only as good as its willingness to be wrong twice.
