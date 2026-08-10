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
uv sync --frozen        # install exactly what uv.lock says, and nothing else
uv run pytest           # or: pnpm --filter @metrika/workers run test:unit
uv run ruff check .
uv run ruff format .
uv run mypy .
```

`uv` itself is pinned to an exact version in the repository's `mise.toml`, and
the interpreter comes from `.python-version` (3.12.13) — `uv` provisions its own
CPython from that file and ignores `mise`'s, which is recorded in ADR-0027 so
that the next person to debug a version discrepancy knows there are two places
to look.

## Two things that will bite

**`uv add` writes `>=` ranges, not pins.** Every requirement in
`pyproject.toml` is an exact `==`, written by hand, and
`packages/typescript-config/test/dependency-pins.test.ts` fails the build on
anything else — in `pyproject.toml` as well as in every `package.json`. After
`uv add <pkg>`, rewrite the range it left behind to the version it actually
resolved, and commit `uv.lock` in the same change. Installs use `--frozen`
precisely so that the lockfile is what decides, and a lockfile nobody refreshed
on purpose is the one thing that can quietly widen a pin.

**The ruff configuration is an input to generated code.** `contracts:emit` runs
`datamodel-codegen --formatters ruff-format ruff-check`, so the committed
pydantic models are a function of this package's `[tool.ruff]` settings — most
of all `line-length` — as well as of the JSON Schema. Changing one reflows files
that CI diffs against their committed copies. Regenerate in the same commit;
ADR-0027 obligation 6 and the comment in `pyproject.toml` say the rest.

## Reference

- [ADR-0007](../../docs/adr/0007-python-workers.md) — why there is a Python side at all
- [ADR-0027](../../docs/adr/0027-python-toolchain.md) — every version pinned here, and the spike behind it
