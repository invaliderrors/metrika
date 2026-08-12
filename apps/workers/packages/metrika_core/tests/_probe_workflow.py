"""The one workflow `test_temporal.py` needs, in a module of its own.

**Not in the test file, and this is ADR-0027 obligation 8 rather than tidiness.**
Temporal's sandbox re-executes the module that defines a `@workflow.defn` in a
fresh registry, to build the deterministic import graph a workflow runs inside.
The spike measured what that does to a module with a module-scope side effect:
`asyncio.run(main())` beside a workflow definition raised
`RuntimeError: Failed validating workflow …  asyncio.run() cannot be called from
a running event loop`, because the sandbox re-entered it. A pytest module is the
worst possible host for a workflow definition — it imports `testcontainers`,
`boto3` and pytest's own machinery, and pytest inserts it into `sys.modules`
under a name of its own choosing.

So this module imports two things and defines one class. Nothing here runs at
import time.

The workflow is **test scaffolding, not a template**: this repository's
workflows live in `apps/api/src/workflows/**` in TypeScript, and the Python
workers register activities only. It exists because there is no other way to
drive an activity on a real server — Temporal has no "execute this activity"
API, by design — and driving one is the only way to prove a worker built by
`build_worker` is polling the queue its settings name.
"""

from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

# The activity's REGISTERED NAME, not an import of the function. Importing it
# would pull the test module into the sandbox, which is the thing this file
# exists to avoid; a name is also what a TypeScript workflow in `apps/api` will
# have, so this is the shape that matters.
PROBE_ACTIVITY = "metrika_core.tests.probe"


@workflow.defn(name="metrika_core.tests.ProbeWorkflow")
class ProbeWorkflow:
    """Calls one activity on the task queue it is handed, and returns its result."""

    @workflow.run
    async def run(self, activity_task_queue: str) -> str:
        # `schedule_to_start_timeout` with a single attempt is what turns "no
        # worker is polling that queue" into a failure instead of a hang. A
        # `start_to_close` alone does not start counting until an activity task
        # is dispatched, so a `build_worker` that ignored
        # `settings.temporal_task_queue` would leave this workflow running
        # forever and the test would time out at the suite level with no useful
        # message.
        result: str = await workflow.execute_activity(
            PROBE_ACTIVITY,
            task_queue=activity_task_queue,
            schedule_to_start_timeout=timedelta(seconds=30),
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )
        return result
