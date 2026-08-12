"""What a worker process is allowed to be able to reach.

ADR-0007's promise has two halves and only one of them was being kept.
`test_settings.py` asserts there is no field that could hold a database
credential; nothing asserted there is no *driver* that could use one.
MEASURED before this file existed: `psycopg==3.2.0` added to
`metrika_core/pyproject.toml` passes every gate in this repository — the pin gate
grades only that a requirement is pinned, `ruff` and `mypy` have no opinion, and
the plan's lock-closure assertion is Task 6's and scoped to
`apps/workers/geometry`, which did not exist yet. `metrika_core` and `slicer`
were named nowhere in it.

**EVERY MEMBER, not one.** The walk below takes a package name, so covering the
whole workspace costs a parametrize rather than a rewrite — and the alternative
is what this file was written to fix, one package's closure asserted and the
others' unexamined. `test_every_workspace_member_is_covered` is what keeps that
true: a member added later without an entry in `ALLOWED_RUNTIME_CLOSURE` turns
this suite red instead of being silently ungraded, which is the failure this
repository keeps meeting.

THREE TESTS PER MEMBER, and none is redundant. The whitelist is the real
control: nothing enters a worker's runtime without a human adding a line to it.
The denylist exists because the obvious way to make a red whitelist green is to
append the new name to it, and for a database driver that must not be an option
a tired reviewer can take at 6pm. The non-vacuity test exists because a walk
that resolved nothing would satisfy both.

`apps/workers/geometry/tests/test_entrypoint.py` asks the driver question a
second time, of `uv export` rather than of this walk. Two mechanisms, so a
misreading of the lock format shows up as a disagreement instead of as two
confident passes.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

import pytest

LOCK = Path(__file__).resolve().parents[3] / "uv.lock"

# Everything `metrika-core` can import at runtime, resolved. Names only:
# versions are `uv.lock`'s job and a patch bump must not turn this red.
#
# Adding a line here is the review. It is deliberately not generated from
# anything — a list derived from the lockfile would agree with the lockfile by
# construction and assert nothing at all.
#
# SO: a legitimate new runtime dependency is SUPPOSED to require an edit here, in
# the same commit that adds it. That is not an obstacle in front of the real
# work, it IS the control — the whole claim of ADR-0007 is that a compromised
# mesh parser lands somewhere with nothing to reach, and "nothing" is a property
# of this list. If you are here because a test went red, the fix is to add the
# package deliberately, having decided a worker should be able to import it.
_METRIKA_CORE = frozenset(
    {
        "metrika-core",
        # S3, and its transitives.
        "boto3",
        "botocore",
        "jmespath",
        "python-dateutil",
        "s3transfer",
        "six",
        "urllib3",
        # Settings and validation.
        "annotated-types",
        "pydantic",
        "pydantic-core",
        "pydantic-settings",
        "python-dotenv",
        "typing-extensions",
        "typing-inspection",
        # Logging.
        "structlog",
        # Telemetry (ADR-0029). Three declared pins and eight transitives, and
        # the transitives are the reason this entry is worth reading rather
        # than skimming: `requests`, `certifi`, `charset-normalizer` and `idna`
        # are an HTTP CLIENT reaching a worker whose whole security story is
        # "it can talk to S3 and Temporal and nothing else" (ADR-0007).
        #
        # They arrive from `opentelemetry-exporter-otlp-proto-http`, and that
        # is the cost ADR-0029 chose knowingly: the `-grpc` exporter's cost is
        # `grpcio`, a compiled extension with a per-platform wheel matrix, and
        # something has to carry spans out of the process. The mitigation is
        # not in this list — it is that `configure_telemetry` builds no
        # exporter at all unless `METRIKA_WORKER_OTLP_ENDPOINT` is set, so the
        # one URL `requests` is ever pointed at is a deployment's own
        # collector.
        #
        # `opentelemetry-semantic-conventions` resolving to `0.65b0` — a BETA
        # version string — is normal for that package and is pinned `==` by
        # `opentelemetry-sdk==1.44.0` itself. It is recorded so nobody "fixes"
        # it.
        "certifi",
        "charset-normalizer",
        "googleapis-common-protos",
        "idna",
        "opentelemetry-api",
        "opentelemetry-exporter-otlp-proto-common",
        "opentelemetry-exporter-otlp-proto-http",
        "opentelemetry-proto",
        "opentelemetry-sdk",
        "opentelemetry-semantic-conventions",
        "requests",
        # Temporal, and its transitives. `types-protobuf` is a RUNTIME
        # requirement of `temporalio` rather than a stub package it declares for
        # its consumers — surprising, and the reason it is called out here
        # rather than assumed to be a mistake in this list.
        "temporalio",
        "nexus-rpc",
        "protobuf",
        "types-protobuf",
    }
)

# Keyed by the distribution name `uv.lock` uses. Both workers are
# `metrika-core` plus themselves today, and the derivation is honest rather than
# lazy: they depend on `metrika-core` and on nothing else, so their closures are
# its closure by construction, and adding `trimesh` to one still requires a line
# in that member's entry.
ALLOWED_RUNTIME_CLOSURE: dict[str, frozenset[str]] = {
    "metrika-core": _METRIKA_CORE,
    "metrika-geometry": _METRIKA_CORE | {"metrika-geometry"},
    "metrika-slicer": _METRIKA_CORE | {"metrika-slicer"},
    # The uv workspace ROOT is a member too, and `uv.lock` lists it as one. It
    # carries the toolchain in `[dependency-groups] dev` and must never carry a
    # runtime dependency: a `[project] dependencies` entry here would be
    # installed into the shared venv, would look like it worked, and would be
    # absent from every worker image built from a member.
    "metrika-workers": frozenset({"metrika-workers"}),
}

# Not exhaustive and not meant to be — the whitelists above are what make the
# closures exhaustive. This is the subset that may never be waived, whatever the
# reason looks like on the day.
DATABASE_DRIVERS = frozenset(
    {
        "aiomysql",
        "aiopg",
        "alembic",
        "asyncpg",
        "databases",
        "django",
        "motor",
        "mysqlclient",
        "peewee",
        "pg8000",
        "prisma",
        "psycopg",
        "psycopg-binary",
        "psycopg-pool",
        "psycopg2",
        "psycopg2-binary",
        "pymongo",
        "pymysql",
        "redis",
        "sqlalchemy",
        "sqlmodel",
        "supabase",
        "tortoise-orm",
    }
)

MEMBERS = sorted(ALLOWED_RUNTIME_CLOSURE)


def _lock() -> dict[str, object]:
    with LOCK.open("rb") as handle:
        return tomllib.load(handle)


# `tomllib.load` hands back `dict[str, Any]`, and an `Any` walking through this
# file would mean the walk below type-checks whatever `uv.lock` turns out to
# contain — including nothing. `disallow_any_explicit` forbids writing that
# `Any` down, so the lock is narrowed instead, one shape at a time. The
# assertions are the point rather than a tax: a lock format that moved
# `dependencies` under a different key would fail here, loudly, instead of
# resolving an empty closure that satisfies every absence this file asserts.


def _table(value: object) -> dict[str, object]:
    assert isinstance(value, dict), value
    return value


def _rows(value: object) -> list[dict[str, object]]:
    assert isinstance(value, list), value
    return [_table(row) for row in value]


def _text(value: object) -> str:
    assert isinstance(value, str), value
    return value


def _texts(value: object) -> list[str]:
    assert isinstance(value, list), value
    return [_text(item) for item in value]


def _resolved_closure(root: str) -> set[str]:
    """Every package `root` pulls in, following the extras it actually requests.

    Extras are tracked rather than ignored, because a dependency written
    `{ name = "x", extra = ["y"] }` resolves `y`'s requirements out of `x`'s
    `[package.optional-dependencies]` — a walk that read only `dependencies`
    would miss them and quietly under-report the closure, which for a gate that
    asserts an absence is the failure that looks like success.

    `[package.dev-dependencies]` is deliberately NOT followed: `ruff`, `pytest`
    and `testcontainers` are developer tools, they are not installed in a worker
    image, and the test below asserts they are absent so that this walk cannot
    silently degrade into "every package in the lockfile".
    """
    entries = {_text(package["name"]): package for package in _rows(_lock()["package"])}

    found: set[str] = set()
    seen: set[tuple[str, tuple[str, ...]]] = set()
    queue: list[tuple[str, tuple[str, ...]]] = [(root, ())]

    while queue:
        name, extras = queue.pop()
        if (name, extras) in seen:
            continue
        seen.add((name, extras))
        found.add(name)

        entry = entries[name]
        requirements = _rows(entry.get("dependencies", []))
        optional = _table(entry.get("optional-dependencies", {}))
        for extra in extras:
            requirements.extend(_rows(optional.get(extra, [])))

        for requirement in requirements:
            queue.append((_text(requirement["name"]), tuple(_texts(requirement.get("extra", [])))))

    return found


def test_every_workspace_member_is_covered() -> None:
    """A member with no entry above is a worker nothing here grades.

    This is the assertion that makes the parametrized tests below mean something
    for packages that do not exist yet. `slicer` spent a whole plan named in no
    assertion anywhere precisely because the gate that should have covered it
    was written against one package's name.

    Read from `uv.lock`'s own `[manifest] members` rather than from the
    `[tool.uv.workspace]` globs: the lock is what `uv sync` installs, so a
    directory the globs match but the lock has never seen is not yet a member,
    and one the lock knows about is, whatever the globs say today.
    """
    manifest = _lock()["manifest"]
    assert isinstance(manifest, dict)
    members = set(manifest["members"])

    assert members == set(ALLOWED_RUNTIME_CLOSURE), (
        "every uv workspace member needs a reviewed runtime closure here; a new worker package "
        "must arrive with the list of what it may reach, not after it"
    )


@pytest.mark.parametrize("member", MEMBERS)
def test_the_walk_resolves_a_real_closure(member: str) -> None:
    """Non-vacuity, in both directions.

    A walk that found nothing would pass every assertion below it, and a walk
    that returned the whole lockfile would pass the whitelist only by being
    wrong about what a worker installs.

    The root is exempt from the first half by construction: it has no runtime
    dependencies, which is the property its own entry asserts.
    """
    closure = _resolved_closure(member)

    assert member in closure
    if member != "metrika-workers":
        assert {"boto3", "botocore", "pydantic", "structlog", "temporalio"} <= closure
    assert "ruff" not in closure, "dev dependencies are not a worker's closure"
    assert "pytest" not in closure
    assert "testcontainers" not in closure


@pytest.mark.parametrize("member", MEMBERS)
def test_the_runtime_closure_is_exactly_what_review_approved(member: str) -> None:
    assert _resolved_closure(member) == set(ALLOWED_RUNTIME_CLOSURE[member]), (
        f"a package entered or left {member}'s runtime closure. A worker has no database "
        "credentials and no reason to reach anything but S3 and Temporal (ADR-0007) — if the "
        "new dependency is legitimate, add it above deliberately; do not widen the set to make "
        "this pass"
    )


@pytest.mark.parametrize("member", MEMBERS)
def test_no_database_driver_can_be_waived_into_the_closure(member: str) -> None:
    """The whitelist is editable. This is what it may never be edited to say."""
    assert DATABASE_DRIVERS.isdisjoint(_resolved_closure(member)), (
        f"{member} resolves a database driver; a worker has no database credentials, so it has "
        "no use for one — see ADR-0007"
    )
    assert DATABASE_DRIVERS.isdisjoint(ALLOWED_RUNTIME_CLOSURE[member]), (
        f"ALLOWED_RUNTIME_CLOSURE[{member!r}] has been widened to admit a database driver"
    )
