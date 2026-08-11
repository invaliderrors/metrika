"""The slicer worker process.

Deliberately smaller than its geometry counterpart, and this is what it does not
repeat rather than an oversight:

- the runtime-closure whitelist and the database-driver denylist cover
  `metrika-slicer` in `packages/metrika_core/tests/test_dependencies.py`, which
  is parametrized over every workspace member. That file is where a new member
  is forced to arrive with a reviewed list of what it may reach.
- the `uv export` cross-check lives in `geometry/tests/test_entrypoint.py`,
  against the package ADR-0007 actually names — the one that parses meshes.
  Running it twice would double the runtime and halve nobody's uncertainty.

What is left is what only this package can answer: that `python -m
metrika_slicer` is a process, and that it registers this package's activities
and no others.

NAMED `test_slicer_entrypoint.py`, NOT `test_entrypoint.py`, and the difference
is load-bearing. pytest's default import mode derives a module name from the
file's basename once no `__init__.py` is in the way, so two `test_entrypoint.py`
files in two members collide — the second is an import-mismatch error at
collection, and `mypy .` reports a duplicate module for the same reason. The
alternative is `--import-mode=importlib` for the whole workspace, which is a
bigger decision than one file name.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from temporalio.testing import ActivityEnvironment

from metrika_slicer.activities import ACTIVITIES, WorkerDescription, describe_worker

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]


async def test_the_stub_activity_returns_a_typed_result() -> None:
    """Runs the activity the way Temporal will, without a server.

    `ActivityEnvironment` supplies the activity context, so `activity.info()`
    resolves; calling `describe_worker()` directly would raise.
    """
    described = await ActivityEnvironment().run(describe_worker)

    assert isinstance(described, WorkerDescription)
    assert described.worker == "metrika_slicer"
    assert described.task_queue != ""


def test_the_entry_point_registers_this_package_s_activities_and_no_others() -> None:
    assert list(ACTIVITIES) == [describe_worker]


def test_the_module_is_runnable_and_refuses_to_start_unconfigured() -> None:
    """`python -m metrika_slicer` is the process, and this is what runs it.

    The second half is the one worth having: `WorkerSettings` has no default for
    `temporal_task_queue`, so a worker with a typo'd environment dies at startup
    with the field named rather than coming up healthy and polling a queue
    nobody publishes to — a failure `docker ps` cannot show.
    """
    environment = {
        name: value for name, value in os.environ.items() if not name.startswith("METRIKA_WORKER_")
    }

    result = subprocess.run(
        [sys.executable, "-m", "metrika_slicer"],
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
