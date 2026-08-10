# @metrika/workers

The Python side of Metrika: geometry analysis and slicing, run as **stateless
compute**. These processes have **no database credentials** and never talk to
Postgres — they receive activity arguments from Temporal, read and write S3
under scoped IAM, and return structured results. See
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

Today this package contains its toolchain and nothing else. The workers
themselves (`geometry/`, `slicer/`, and the shared libraries under `packages/`)
arrive in the later tasks of Plan 0B-3; `[tool.uv.workspace] members` already
names them.

## Layout

This directory is the **uv workspace root**. It is also a pnpm workspace package
— `package.json` here is a shim with no Node dependencies whose only job is to
give Turbo five scripts to call, so that `pnpm lint`, `pnpm typecheck`,
`pnpm test:unit`, `pnpm format` and `pnpm format:check` at the repository root
cover Python as well as TypeScript. There is one gate, not two.

## Running things

```bash
uv sync --all-packages --frozen        # install exactly what uv.lock says
uv run --locked --all-packages pytest  # or: pnpm --filter @metrika/workers run test:unit
uv run --locked --all-packages ruff check .
uv run --locked --all-packages ruff format .
uv run --locked --all-packages mypy .
```

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

## Three things that will bite

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

**The ruff configuration is an input to generated code.** `contracts:emit` runs
`datamodel-codegen --formatters ruff-format ruff-check`, so the committed
pydantic models are a function of this package's `[tool.ruff]` settings — most
of all `line-length` — as well as of the JSON Schema. Changing one reflows files
that CI diffs against their committed copies. Regenerate in the same commit;
ADR-0027 obligation 6 and the comment in `pyproject.toml` say the rest.

## Reference

- [ADR-0007](../../docs/adr/0007-python-workers.md) — why there is a Python side at all
- [ADR-0027](../../docs/adr/0027-python-toolchain.md) — every version pinned here, and the spike behind it
