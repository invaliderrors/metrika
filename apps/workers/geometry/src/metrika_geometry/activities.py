"""What the geometry worker registers with Temporal.

**One stub, and it is deliberately not geometry.** Task 6 of Plan 0B-3 builds
the process — settings, logging, a client, a worker, a graceful shutdown — and
nothing else; mesh analysis arrives in a later task, with `trimesh[easy]`, its
own dependency review and its own contracts. Putting a placeholder here rather
than nothing means the boundary this task built is exercised end to end by
`packages/metrika_core/tests/test_temporal.py` and by
`tests/test_entrypoint.py`, instead of being asserted about.

Separate from `__main__.py` on purpose. `python -m metrika_geometry` executes
that file under the name `__main__`, so an activity defined there would be
registered under one name when the process runs it and a different one when a
test imports it — the kind of duplication that shows up as an activity Temporal
cannot find, in production, at the point where the worker is otherwise healthy.
"""

from __future__ import annotations

from dataclasses import dataclass

from temporalio import activity

from metrika_core.temporal import Activity

# The name this package answers to, and the value that will be in
# `WorkerDescription.worker`. It is the distribution's module name rather than a
# free-text label so that a log line, an activity result and an import path all
# say the same word.
WORKER = "metrika_geometry"


@dataclass(frozen=True)
class WorkerDescription:
    """What `describe_worker` returns.

    A frozen dataclass rather than a `dict`: Temporal's default payload
    converter serialises dataclasses, and an activity that returns `dict` gives
    the calling workflow nothing to check — which for a system whose whole
    contract is typed results is the wrong default to establish in the first
    activity anyone writes.

    A pydantic model would also work and is what the generated contracts in
    `metrika_core.contracts` use. It is not used here because this type is not a
    contract — nothing outside this repository consumes it, and it is deleted
    the day a real activity lands.
    """

    worker: str
    task_queue: str


@activity.defn(name="geometry.describe_worker")
async def describe_worker() -> WorkerDescription:
    """Reports which worker ran this, and on which queue.

    The registered NAME is what a workflow in `apps/api` refers to, and it is
    spelled out rather than inferred from the function so that renaming the
    function is not silently renaming a contract.

    `activity.info().task_queue` rather than a constant: the queue is
    deployment configuration (`METRIKA_WORKER_TEMPORAL_TASK_QUEUE`), so reading
    it back from the activity context is the only answer that can disagree with
    what the deployment intended — which is exactly what makes it worth
    returning.
    """
    return WorkerDescription(worker=WORKER, task_queue=activity.info().task_queue)


# What `__main__` registers, and the only thing it registers. A tuple rather
# than a list because it is not something a caller adds to at runtime: an
# activity a worker can run is a reviewed decision, not configuration.
ACTIVITIES: tuple[Activity, ...] = (describe_worker,)
