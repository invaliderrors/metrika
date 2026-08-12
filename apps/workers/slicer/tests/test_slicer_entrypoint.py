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

import pytest
from temporalio.testing import ActivityEnvironment

import metrika_slicer.__main__ as entry_point
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


def test_the_entry_point_installs_telemetry_under_this_worker_s_own_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Delete `configure_telemetry` from `__main__` and nothing else goes red.

    MEASURED before this test existed: remove the import and the call and every
    gate in the repository stays green. `test_the_module_is_runnable_and_refuses_
    to_start_unconfigured` fires at `WorkerSettings()`, well before telemetry,
    and `packages/metrika_core/tests/test_telemetry.py` installs its own
    provider in a fixture — so nothing anywhere asserted that a REAL worker
    process installs one.

    The production consequence is the failure mode this repository already knows
    by name. With no global provider the OpenTelemetry API hands out a no-op,
    `TracingInterceptor` starts non-recording spans, and every activity line
    loses `traceId` and `spanId` **while `requestId` still arrives** — because
    the request ID comes from baggage and the trace ID from the span, and those
    are two mechanisms. That is exactly the split Task 4's Step 5 mutations
    found, so "the request ID is there" would have made it look fine.

    BEHAVIOURAL, not a source grep. `main()` is called with its two side effects
    replaced, which proves the call is ON THE PATH rather than merely present in
    the file — a `configure_telemetry` sitting under an `if False:` would pass a
    grep.

    The service name is asserted as an exact singleton list, so a copy-paste
    between the two entry points fails here rather than filing every span under
    the other worker. That is the half the README's argument for a literal over
    an environment variable was missing: a wrong literal had nothing catching it
    either.
    """
    for name in list(os.environ):
        if name.upper().startswith("METRIKA_WORKER_"):
            monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("METRIKA_WORKER_TEMPORAL_TASK_QUEUE", "slicer-small")
    monkeypatch.setenv("METRIKA_WORKER_S3_BUCKET", "metrika-models")

    calls: list[str] = []

    def _record_telemetry(_settings: object, *, service_name: str) -> None:
        calls.append(f"telemetry:{service_name}")

    def _record_logging(level: str) -> None:
        calls.append(f"logging:{level}")

    async def _do_not_actually_run(_settings: object, _activities: object) -> None:
        calls.append("worker")

    monkeypatch.setattr(entry_point, "configure_telemetry", _record_telemetry)
    monkeypatch.setattr(entry_point, "configure_logging", _record_logging)
    monkeypatch.setattr(entry_point, "run_worker", _do_not_actually_run)

    entry_point.main()

    assert calls == ["logging:info", "telemetry:metrika-slicer", "worker"], (
        "the entry point must configure logging and telemetry, in that order, before running"
    )
