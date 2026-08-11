"""What a worker process is allowed to be able to reach.

ADR-0007's promise has two halves and only one of them was being kept.
`test_settings.py` asserts there is no field that could hold a database
credential; nothing asserted there is no *driver* that could use one.
MEASURED before this file existed: `psycopg==3.2.0` added to
`metrika_core/pyproject.toml` passes every gate in this repository — the pin gate
grades only that a requirement is pinned, `ruff` and `mypy` have no opinion, and
the plan's lock-closure assertion is Task 6's and scoped to
`apps/workers/geometry`, which does not exist yet. `metrika_core` and `slicer`
are named nowhere in it.

So the assertion lives here, over this package's own resolved closure, where it
holds before `geometry` is written rather than after.

TWO TESTS, and the second is not redundant. The whitelist is the real control:
nothing enters a worker's runtime without a human adding a line to it. The
denylist exists because the obvious way to make a red whitelist green is to
append the new name to it, and for a database driver that must not be an option
a tired reviewer can take at 6pm.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

LOCK = Path(__file__).resolve().parents[3] / "uv.lock"

ROOT_PACKAGE = "metrika-core"

# Every distribution `metrika-core` can import at runtime, resolved. Names only:
# versions are `uv.lock`'s job and a patch bump must not turn this red.
#
# Adding a line here is the review. It is deliberately not generated from
# anything — a list derived from the lockfile would agree with the lockfile by
# construction and assert nothing at all.
ALLOWED_RUNTIME_CLOSURE = frozenset(
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
    }
)

# Not exhaustive and not meant to be — the whitelist above is what makes it
# exhaustive. This is the subset that may never be waived, whatever the reason
# looks like on the day.
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
    with LOCK.open("rb") as handle:
        entries = {package["name"]: package for package in tomllib.load(handle)["package"]}

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
        requirements = list(entry.get("dependencies", []))
        optional = entry.get("optional-dependencies", {})
        for extra in extras:
            requirements.extend(optional.get(extra, []))

        for requirement in requirements:
            queue.append((requirement["name"], tuple(requirement.get("extra", ()))))

    return found


def test_the_walk_resolves_a_real_closure() -> None:
    """Non-vacuity, in both directions.

    A walk that found nothing would pass every assertion below it, and a walk
    that returned the whole lockfile would pass the whitelist only by being
    wrong about what a worker installs.
    """
    closure = _resolved_closure(ROOT_PACKAGE)

    assert {"boto3", "botocore", "pydantic", "structlog"} <= closure
    assert "ruff" not in closure, "dev dependencies are not a worker's closure"
    assert "pytest" not in closure
    assert "testcontainers" not in closure


def test_the_runtime_closure_is_exactly_what_review_approved() -> None:
    assert _resolved_closure(ROOT_PACKAGE) == set(ALLOWED_RUNTIME_CLOSURE), (
        "a package entered or left metrika_core's runtime closure. A worker has no database "
        "credentials and no reason to reach anything but S3 and Temporal (ADR-0007) — if the "
        "new dependency is legitimate, add it above deliberately; do not widen the set to make "
        "this pass"
    )


def test_no_database_driver_can_be_waived_into_the_closure() -> None:
    """The whitelist is editable. This is what it may never be edited to say."""
    assert DATABASE_DRIVERS.isdisjoint(_resolved_closure(ROOT_PACKAGE)), (
        "a worker has no database credentials, so it has no use for a driver; see ADR-0007"
    )
    assert DATABASE_DRIVERS.isdisjoint(ALLOWED_RUNTIME_CLOSURE), (
        "ALLOWED_RUNTIME_CLOSURE has been widened to admit a database driver"
    )
