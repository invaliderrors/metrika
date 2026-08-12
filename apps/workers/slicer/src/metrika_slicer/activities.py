"""What the slicer worker registers with Temporal.

**One stub, and it is deliberately not slicing.** Task 6 of Plan 0B-3 builds the
process and nothing else; driving a slicer binary over a repaired 3MF arrives in
a later task with its own review. The placeholder exists so that the boundary
this task built is exercised rather than asserted about.

Separate from `__main__.py` for the reason its geometry counterpart states:
`python -m metrika_slicer` executes that file as `__main__`, so an activity
defined there would register under one name at runtime and another under import.
"""

from __future__ import annotations

from dataclasses import dataclass

from temporalio import activity

from metrika_core.temporal import Activity

# The name this package answers to. The distribution's module name rather than a
# free-text label, so a log line, an activity result and an import path all say
# the same word.
WORKER = "metrika_slicer"


@dataclass(frozen=True)
class WorkerDescription:
    """What `describe_worker` returns.

    Its own type rather than one imported from `metrika_geometry`: these two
    packages share `metrika_core` and nothing else by design, and a shared stub
    result would be the first thread of a dependency between two processes that
    are deployed, scaled and compromised separately. It is deleted the day a
    real activity lands.
    """

    worker: str
    task_queue: str


@activity.defn(name="slicer.describe_worker")
async def describe_worker() -> WorkerDescription:
    """Reports which worker ran this, and on which queue.

    The registered NAME is what a workflow in `apps/api` refers to, and it is
    spelled out rather than inferred from the function so that renaming the
    function is not silently renaming a contract.
    """
    return WorkerDescription(worker=WORKER, task_queue=activity.info().task_queue)


# What `__main__` registers, and the only thing it registers.
ACTIVITIES: tuple[Activity, ...] = (describe_worker,)
