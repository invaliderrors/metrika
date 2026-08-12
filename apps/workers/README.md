# @metrika/workers

The Python side of Metrika: geometry analysis and slicing, run as **stateless
compute**. These processes have **no database credentials** and never talk to
Postgres — they receive activity arguments from Temporal, read and write S3
under scoped IAM, and return structured results. See
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

Today this package contains its toolchain, one shared library
(`packages/metrika_core` — settings, structured logging, S3 and Temporal) and
the two worker processes, `geometry/` and `slicer/`. Both are **entry points and
one stub activity each**: the geometry and slicing work arrives in later tasks,
with its own dependencies and its own review.

```bash
python -m metrika_geometry   # polls METRIKA_WORKER_TEMPORAL_TASK_QUEUE for geometry.*
python -m metrika_slicer     # the same process, registering slicer.* instead
```

The two entry points are the same fifteen lines and differ in **exactly one
import** — the activities they register. The queue is not in either file; it is
`METRIKA_WORKER_TEMPORAL_TASK_QUEUE`, so the same image can be deployed against
`geometry-small` and `geometry-large` without a code change. Everything else a
worker process does — connecting, polling, shutting down on SIGTERM — lives in
`metrika_core.temporal`, because two entry points that each grew their own
client setup would drift on precisely the details nobody looks at until an
incident.

### `packages/metrika_core`

- `settings.py` — `WorkerSettings`, read from **`METRIKA_WORKER_*`**. **There is
  no database field of any kind**, and `tests/test_settings.py` asserts the exact
  field set rather than screening names for suspicious substrings (ADR-0007) — a
  blacklist missed twenty-two spellings, nested models and aliases; a whitelist
  fails on any addition. A typo'd `METRIKA_WORKER_*` variable is a startup error,
  not a silent default, and the error names it **without** its value.

  **The prefix is `METRIKA_WORKER_` and not `METRIKA_` for a measured reason.**
  `extra="forbid"` here means "an unrecognised variable in our namespace is an
  error", which is right — and was applied to a namespace this repository shares:
  `packages/testing/src/database.ts` publishes `METRIKA_TEST_DATABASE_URL`, and
  with it exported `WorkerSettings()` refused to construct at all, so any shell
  that had run the Node integration harness could not start a worker. Narrowing
  the claim is what makes the strictness safe. Do not widen it back; add a
  variable under `METRIKA_WORKER_` instead, and to `.env.example` in the same
  commit.

- `logging.py` — JSON to stdout through `structlog`, with redaction as a
  processor. `REDACTED_KEYS` and `REDACTED_SUFFIXES` cover presigned URLs and
  file names, because a signed URL in a log is a credential in a log
  (`SECURITY.md`). `cache_key` is deliberately not redacted: it is
  content-addressed, and it is how a stuck job gets debugged.
- `storage.py` — `ObjectStore`, the only module on the Python side that names
  `boto3`. `get_object` raises for a missing key and never returns `b""`; a
  missing _bucket_ is a configuration fault and propagates as a `ClientError`.
- `temporal.py` — `build_client`, `build_worker` and `run_worker`, and no
  workflow. Temporal workflows live in `apps/api/src/workflows/**` in
  TypeScript, where determinism is enforced by lint rules this side does not
  have, so `build_worker` takes no `workflows` argument at all: adding
  orchestration here is an edit to that file with a reviewer attached, not an
  extra keyword argument at a call site. `run_worker` handles **SIGTERM**, which
  is the reason it exists — a container runtime sends it and then waits before
  SIGKILL, and `Worker.run()` installs no handler of its own, so a process
  without this is killed mid-poll on every deploy.
- `contracts/__init__.py` — **generated, committed, and never edited by hand.**
  `pnpm contracts:emit` writes it from the Zod schemas in `packages/contracts`
  (`z.toJSONSchema()` → one JSON Schema document → `datamodel-codegen`), and CI's
  `contracts` job re-runs the emission and fails on `git diff --exit-code`. The
  file's own header carries what did **not** cross the boundary: branding
  (`QuoteId` and `OrderId` are the same `str` here), regex flags, and the fact
  that `\d` means something wider in Python than in JavaScript.
- `tests/test_generated_contracts.py` — the boundary, asserted from this side,
  which is the only side it is observable from. Every model is **instantiated and
  a payload validated through it**, because ADR-0027 measured a generated model
  passing `ruff`, `ruff format --check`, `mypy --strict` and `import` at exit 0
  and then raising an uncaught `TypeError` on every payload. It also guards the
  two config-level exemptions the generated file needs — the
  `[[tool.mypy.overrides]]` for `explicit-any` and the `N815` per-file-ignore —
  by asserting each names that module and nothing else. A generated file cannot
  carry an inline suppression, so both had to become configuration, and an
  exemption list is exactly the thing that widens under pressure.
- `tests/test_dependencies.py` — the other half of ADR-0007. Nothing asserted
  that this package cannot install a database **driver**; measured,
  `psycopg==3.2.0` here passed every gate in the repository. The resolved
  runtime closure of **every workspace member** is now whitelisted — `geometry`
  and `slicer` included, and a member added without an entry turns the suite red
  rather than going ungraded — so a package enters a worker only when a human
  adds a line, and a separate assertion keeps that list from being widened to
  admit a driver. `geometry/tests/test_entrypoint.py` asks the driver question a
  second time, of `uv export --no-dev` rather than of this walk, so a misreading
  of the lock format shows up as a disagreement instead of two confident passes.

### `geometry` and `slicer`

Two processes, three files each: `activities.py` (what it registers),
`__main__.py` (what runs it) and a test. Neither declares a dependency beyond
`metrika-core` — no `trimesh`, no slicer bindings — because neither does its
real work yet, and a short closure is worth keeping short from the start rather
than trimming later.

The activity lives in `activities.py` and not in `__main__.py` for a reason that
only shows up in production: `python -m metrika_geometry` executes that file
under the name `__main__`, so an activity defined there registers under one name
when the process runs it and another when anything imports it — surfacing as an
activity Temporal cannot find, on a worker that is otherwise healthy.

`geometry/tests/test_entrypoint.py` carries **ADR-0007's central mechanical
check**: the package's `uv export --no-dev` closure contains no database driver.
It reads the resolved export rather than the declared dependencies, because the
driver that matters arrives four levels down, pulled by something that looked
like a mesh library.

## Layout

This directory is the **uv workspace root**. It is also a pnpm workspace package
— `package.json` here is a shim with no Node dependencies whose only job is to
give Turbo six scripts to call, so that `pnpm lint`, `pnpm typecheck`,
`pnpm test:unit`, `pnpm test:integration`, `pnpm format` and `pnpm format:check`
at the repository root cover Python as well as TypeScript. There is one gate,
not two.

## Running things

```bash
uv sync --all-packages --frozen        # install exactly what uv.lock says
uv run --locked --all-packages pytest  # or: pnpm --filter @metrika/workers run test:unit
uv run --locked --all-packages pytest -m integration   # needs Docker
uv run --locked --all-packages ruff check .
uv run --locked --all-packages ruff format .
uv run --locked --all-packages mypy .
```

**A bare `pytest` deliberately does not run everything.** `pyproject.toml` sets
`addopts = "-m 'not integration'"`, and `metrika_core`'s storage suite is marked
`integration` because it starts a real MinIO container — the same image
`infra/docker/docker-compose.yml` runs, through Testcontainers. `pnpm verify`
must keep working on a machine with no Docker daemon, which is what
`packages/testing/src/docker.ts` promises in the error a developer actually
reads. `-m` is a `store` option, so the `-m integration` above overrides the
default selection rather than combining with it.

**Both flags are load-bearing, and both are measured.** `--all-packages` is
what installs the workspace _members_: at a virtual root, a plain
`uv sync --frozen` installs only the root's dev group, and `mypy` then reports
`import-not-found` on member sources — a type checker failing on its own
workspace, for a reason that looks like a broken import. `--locked` is what
makes the pin table real: after an edit to `pyproject.toml`, a bare `uv run`
**re-locks and exits 0**, silently re-resolving every version ADR-0027 pinned,
while `--locked` exits 2 and `uv lock --check` exits 1. Note `--frozen` is the
weaker of the two — it declines to update the lockfile, but says nothing when
the lockfile no longer matches `pyproject.toml`.

`uv` itself is pinned to an exact version in the repository's `mise.toml`, and
the interpreter comes from `.python-version` (3.12.13) — `uv` provisions its own
CPython from that file and ignores `mise`'s, which is recorded in ADR-0027 so
that the next person to debug a version discrepancy knows there are two places
to look.

## Five things that will bite

**`uv add` writes `>=` ranges, not pins.** Every requirement in
`pyproject.toml` is an exact `==`, written by hand, and
`packages/typescript-config/test/dependency-pins.test.ts` fails the build on
anything else — in `pyproject.toml` as well as in every `package.json`. After
`uv add <pkg>`, rewrite the range it left behind to the version it actually
resolved, then run `uv lock` and commit the lockfile in the same change. The
`--locked` on every script above is what turns that from a convention into an
error.

The one exception, and it is the shape `uv add` produces inside a workspace: a
dependency on a sibling member is written bare (`dependencies = ["metrika-core"]`)
with `[tool.uv.sources] metrika-core = { workspace = true }` beside it, because
the version comes from the member rather than from an index. The gate exempts a
name with a `workspace = true` source **in the same file**, exactly as the
TypeScript half exempts `workspace:*`. Do not widen the pin rule to make one of
these pass; add the source entry.

**Suppressions must name a code and carry a justification.** `# type: ignore`
and `# noqa` bare are rejected by ruff's `PGH` rules, and a per-line
`# type: ignore` without a code by mypy's `ignore-without-code`. The required
shape is a **second comment**, because the Node side's inline form breaks mypy:

```python
value = untyped()  # type: ignore[no-any-return]  # -- boto3 stubs lag the runtime
```

Written as `# type: ignore[no-any-return] -- reason`, mypy reports
`Invalid "type: ignore" comment` and suppresses nothing. `# mypy: ignore-errors`
is banned outright, beside `@ts-ignore` — it silences a whole file and neither
tool can be made to report it.

**`disallow_any_explicit` fires on every pydantic model, and it is not about
your annotations.** MEASURED on mypy 2.3.0: `class S(BaseModel): pass` — no
annotation of its own anywhere — reports `Explicit "Any" is not allowed
[explicit-any]` on the class line. The `Any` is in the `__init__` mypy
synthesises from pydantic's `dataclass_transform`, and `plugins =
["pydantic.mypy"]` (which this package enables, and which is what makes
`WorkerSettings()` typecheck at all) does not remove it.
`metrika_core.settings` carries one justified inline suppression for it.
**That does not scale to generated models**, which cannot carry a hand-written
one, so `metrika_core.contracts` gets a `[[tool.mypy.overrides]]` scoped to that
module alone — never a global relaxation. MEASURED: 17 `explicit-any` errors on
that one file, every one on a class line, and none of the `Any` is in the
generated source (`grep -c Any` on it is 0). `test_generated_contracts.py`
asserts the override names exactly `["metrika_core.contracts"]`; adding
`metrika_core.*` to it turns that test red. The comment above
`disallow_any_explicit` in `pyproject.toml` says the rest.

**Constructing a Temporal `Worker` takes a registration that dropping the object
does not release.** MEASURED on temporalio 1.31.0, in one boot against a real
server, with a positive control (script:
`registration_probe.py`, run 2026-08-11):

| measurement                                                  | result                                     |
| ------------------------------------------------------------ | ------------------------------------------ |
| running worker (`async with`) → activity pollers             | **1** — the control passes                 |
| constructed, never run → activity pollers after 6s           | **0**                                      |
| `del` + `gc.collect()`, then a second `Worker` on that queue | **`RuntimeError: Failed creating worker`** |
| the same, from a new event loop and a new `Client`           | constructs with no error                   |

The error is core's, and it names what it is keyed on: `Registration of multiple
workers with overlapping worker task types on the same namespace, task queue,
and deployment build ID not allowed: SlotKey { namespace: "default", task_queue:
… }`. `shutdown()` is no escape — it waits on an event only `run()` sets, so on a
never-run worker it hangs.

**Construction does NOT poll**, and an earlier version of this section said it
did. It was inferred from a symptom rather than measured, and the control above
is what refutes it: 0 pollers, and an activity whose only worker is an abandoned
one times out on `ScheduleToStart` — identical to no worker at all, not to a
worker eating tasks.

What the symptom actually was, and it is left here unexplained on purpose:
with an abandoned worker from an earlier event loop still in the process, a
properly running worker on the same queue is **starved** — the round trip failed
about one run in three with `activity StartToClose timeout` (the server saying
the task WAS dispatched) while the process logged no `Running activity` line.
Isolated on a shared queue: **4 failures in 6 with an abandoned worker, 0 in 6
without**, and reproduced again in the table above. The mechanism is not
established. Do not write one down without measuring it.

The mitigation is the same either way, and it is already applied:
`packages/metrika_core/tests/test_temporal.py` gives every test its own task
queue and enters every worker it builds as a context manager. **Do not construct
one to look at it.**

**The ruff configuration is an input to generated code.** `contracts:emit` runs
`datamodel-codegen --formatters ruff-format ruff-check`, so the committed
pydantic models are a function of this package's `[tool.ruff]` settings — most
of all `line-length` — as well as of the JSON Schema. Changing one reflows files
that CI diffs against their committed copies. Regenerate in the same commit;
ADR-0027 obligation 6 and the comment in `pyproject.toml` say the rest.

`[tool.ruff.lint.isort] known-first-party` is part of that surface, and this was
measured rather than assumed: output is byte-identical when a generated model
imports nothing first-party, and **moves** as soon as one carries an absolute
`from metrika_core… import …` — the import relocates to its own block and a blank
line appears. So if the generated package ever emits absolute intra-package
imports, that key is load-bearing for the committed bytes, not just for
readability.

## Reference

- [ADR-0007](../../docs/adr/0007-python-workers.md) — why there is a Python side at all
- [ADR-0027](../../docs/adr/0027-python-toolchain.md) — every version pinned here, and the spike behind it
