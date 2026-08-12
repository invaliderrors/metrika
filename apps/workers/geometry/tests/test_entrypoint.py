"""The geometry worker process, and the promise it exists to keep.

ADR-0007, in one sentence: an attacker with code execution in the mesh parser
lands in a task with no network, no database credentials, a read-only filesystem
and nothing but the file they already uploaded. Three of those four are
properties of the container and the IAM role, and are asserted where those are
defined. **The fourth is a property of this package's dependency closure**, and
this is the only place it can be checked mechanically — before a worker is
deployed, on the resolution that will actually be installed.

READ FROM `uv export`, NOT FROM `pyproject.toml`. A declared-dependency check
sees `metrika-core` and stops; the driver that matters would arrive four levels
down, pulled by something that looked like a mesh library. And read through
`uv` rather than by walking `uv.lock` here, deliberately:
`packages/metrika_core/tests/test_dependencies.py` walks the lock itself, over
every member, with a whitelist. Two mechanisms answering the same question is
worth more than one answering it twice — if the hand-written walk ever
mis-resolves an extra, or a lock format change moves the ground under it, these
two disagree instead of both being confidently wrong.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from temporalio.testing import ActivityEnvironment

from metrika_geometry.activities import ACTIVITIES, WorkerDescription, describe_worker

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]

PACKAGE = "metrika-geometry"

# Not exhaustive, and not meant to be — the whitelist in
# `packages/metrika_core/tests/test_dependencies.py` is what makes the closure
# exhaustive. This is the subset that may never be waived, whatever the reason
# looks like on the day, and it is duplicated there for the same reason a
# denylist is duplicated in any defence: the two gates must not share the way
# they can be edited into agreement.
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


def _exported_closure(package: str) -> set[str]:
    """Every distribution `uv` would install for `package`, dev group excluded.

    `--no-dev` is the whole point: `ruff`, `pytest` and `testcontainers` are
    developer tools that no worker image installs, and counting them would make
    this assertion about the wrong thing. `--locked` fails rather than
    re-resolving, so a `pyproject.toml` edited without re-locking is an error
    here instead of a quietly different answer.
    """
    # S603: the only non-literal in this argv is `package`, which is a module
    # constant in this file. It is not S607-exempt by accident either — `uv` is
    # resolved through PATH deliberately, because the question being asked is
    # what the developer's own `uv` resolves.
    result = subprocess.run(  # noqa: S603  # -- argv is literal apart from a constant in this file
        [
            "uv",
            "export",
            "--package",
            package,
            "--no-dev",
            "--no-emit-project",
            "--no-hashes",
            "--locked",
            "--quiet",
        ],
        cwd=WORKSPACE_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr

    found: set[str] = set()
    for line in result.stdout.splitlines():
        if line.startswith(("#", " ", "-e ")):
            # A comment, a `# via` continuation, or a workspace member emitted
            # as an editable path. The members are named by the walk in
            # test_dependencies.py; nothing from an index arrives this way.
            continue
        name = line.split("==")[0].split(" ;")[0].strip()
        if name:
            found.add(name.lower().replace("_", "-"))
    return found


def test_the_export_resolves_a_real_closure() -> None:
    """Non-vacuity, in both directions.

    A parser that returned an empty set would pass every assertion below it, and
    one that returned the whole lockfile would pass the denylist by accident
    while being wrong about what a worker installs.
    """
    closure = _exported_closure(PACKAGE)

    assert {"boto3", "pydantic", "structlog", "temporalio"} <= closure
    assert "ruff" not in closure, "dev dependencies are not a worker's closure"
    assert "pytest" not in closure
    assert "testcontainers" not in closure


def test_the_geometry_worker_can_install_no_database_driver() -> None:
    offenders = sorted(DATABASE_DRIVERS & _exported_closure(PACKAGE))

    assert offenders == [], (
        f"{PACKAGE} resolves {offenders}. A worker has no database credentials, so it has no "
        "use for a driver, and shipping one turns a mesh-parser compromise into a database "
        "compromise the moment a credential appears anywhere in its environment — see ADR-0007"
    )


async def test_the_stub_activity_returns_a_typed_result() -> None:
    """Runs the activity the way Temporal will, without a server.

    `ActivityEnvironment` supplies the activity context, so `activity.info()`
    resolves; calling `describe_worker()` directly would raise, and asserting
    that it raises would test nothing about the worker.
    """
    described = await ActivityEnvironment().run(describe_worker)

    assert isinstance(described, WorkerDescription)
    assert described.worker == "metrika_geometry"
    # `ActivityEnvironment`'s own default, not a queue this package names — the
    # point is that the value is read from the activity context at runtime
    # rather than baked in.
    assert described.task_queue != ""


def test_the_entry_point_registers_this_package_s_activities_and_no_others() -> None:
    assert list(ACTIVITIES) == [describe_worker]


def test_the_module_is_runnable_and_refuses_to_start_unconfigured() -> None:
    """`python -m metrika_geometry` is the process, and this is what runs it.

    Two assertions in one subprocess, and the second is the one worth having.
    That the module is *runnable* is real — a missing `__main__.py`, a syntax
    error or an import that only resolves in the test environment all fail here
    and nowhere else in this suite. That it *refuses to start* without its
    settings is the behaviour a deployment depends on: `WorkerSettings` has no
    default for `temporal_task_queue`, so a worker with a typo'd environment
    dies at startup with the field named, rather than coming up healthy and
    polling a queue nobody publishes to. The second failure is invisible —
    `docker ps` shows a running container and the queue shows no workers.
    """
    environment = {
        name: value for name, value in os.environ.items() if not name.startswith("METRIKA_WORKER_")
    }

    # `-m`, not the file path, because running it as a module is exactly the
    # claim being made. This call carries no S603 suppression while
    # `_exported_closure` above does, which is worth knowing rather than
    # guessing at: ruff exempts `sys.executable` specifically, so a suppression
    # here is reported as unused by RUF100 — measured, when this had one.
    #
    # (And spelling that directive out in prose is itself a trap, twice over.
    # ruff parses a comment of that shape in ANY position and reports an
    # "invalid directive" warning for the sentence explaining it -- measured.
    # CI's unjustified-suppression grep is the second half: it scans line
    # content and cannot tell prose from a directive, so a paragraph naming the
    # directive fails the build with no way to justify itself. That gate is
    # CI-only, so `pnpm verify` is structurally blind to it and this survived
    # eight reviews. `metrika_core/settings.py` carries the same note for the
    # same reason. Do not write the word.)
    result = subprocess.run(
        [sys.executable, "-m", "metrika_geometry"],
        cwd=WORKSPACE_ROOT,
        capture_output=True,
        text=True,
        env=environment,
        timeout=60,
        check=False,
    )

    assert result.returncode != 0, (
        f"started with no configuration at all:\n{result.stdout}\n{result.stderr}"
    )
    assert "temporal_task_queue" in result.stderr, (
        f"the error must name the missing setting:\n{result.stderr}"
    )
    assert "s3_bucket" in result.stderr, (
        f"the error must name the missing setting:\n{result.stderr}"
    )


@pytest.mark.parametrize("setting", ["temporal_address", "temporal_namespace"])
def test_the_settings_a_worker_needs_are_not_this_package_s_business(setting: str) -> None:
    """The entry point reads settings; it does not carry any.

    A default written here — a task queue, an address, a namespace — would be a
    second source of configuration that a deployment cannot see, and the first
    one to drift wins silently. `WorkerSettings` owns all of it, which is where
    `tests/test_settings.py` asserts what the set may contain.
    """
    source = (WORKSPACE_ROOT / "geometry" / "src" / "metrika_geometry" / "__main__.py").read_text(
        encoding="utf-8"
    )

    assert setting not in source, (
        f"{setting} is configuration, and configuration lives in WorkerSettings"
    )
