"""`metrika_core.temporal` against a real Temporal server, not a mock.

The module under test is nothing but a boundary: it dials a server and hands a
worker a task queue and a list of activities. A mock proves those calls were
made with the arguments the test already knows about, which is the one thing
that cannot be wrong here. What can be wrong is everything on the other side of
the wire — a worker that connects but polls a queue nobody publishes to, a
namespace that does not exist, an activity that is registered under a name the
workflow does not use. Every one of those passes a mock and none of them
survives `test_the_worker_polls_the_task_queue_from_settings`.

The server itself, and the `settings` fixture pointed at it, live in
`_temporal_server.py` and are shared with `test_telemetry.py` through
`conftest.py` — one `auto-setup` container per session rather than one per
suite. Everything about WHY those containers are configured the way they are is
documented there.

MARKED `integration` per test rather than per module, unlike `test_storage.py`:
the image-parity assertion needs no daemon, and a drift check that only runs
where Docker is installed is a drift check that stops running first.
"""

from __future__ import annotations

import uuid

import pytest
from temporalio import activity
from temporalio.api.workflowservice.v1 import DescribeNamespaceRequest
from temporalio.worker import Worker

from metrika_core.settings import WorkerSettings
from metrika_core.temporal import build_client, build_worker

from _probe_workflow import PROBE_ACTIVITY, ProbeWorkflow  # isort: skip
from _temporal_server import (  # isort: skip
    ACTIVITY_QUEUE_PREFIX,
    COMPOSE_FILE,
    POSTGRES_IMAGE,
    TEMPORAL_IMAGE,
    WORKFLOW_QUEUE,
)


@activity.defn(name=PROBE_ACTIVITY)
async def probe() -> str:
    """Reports the task queue it was actually dispatched on.

    Not `return "ok"`. The whole question this suite asks is *which queue* the
    worker is polling, and an activity that returns a constant answers it only
    by having run at all — which a worker on the wrong queue also does, if some
    other worker in the process happens to pick the task up.
    """
    return activity.info().task_queue


async def not_an_activity() -> str:
    """Deliberately undecorated. See `test_build_worker_rejects_an_undecorated_function`."""
    return "no @activity.defn here"


@pytest.mark.integration
async def test_build_client_connects_to_the_address_and_namespace_in_settings(
    settings: WorkerSettings,
) -> None:
    client = await build_client(settings)

    assert client.namespace == settings.temporal_namespace
    # A real round trip through the gRPC frontend, not an attribute read: a
    # published Docker port accepts a TCP connection before anything is
    # listening inside the container, so only an RPC distinguishes a live server
    # from docker-proxy holding the socket open.
    described = await client.workflow_service.describe_namespace(
        DescribeNamespaceRequest(namespace=settings.temporal_namespace)
    )
    assert described.namespace_info.name == settings.temporal_namespace


@pytest.mark.integration
async def test_build_worker_registers_exactly_the_activities_it_is_given(
    settings: WorkerSettings,
) -> None:
    client = await build_client(settings)

    # `async with`, not a bare construction: a constructed worker is already
    # polling, and dropping one leaves a poller on this queue that swallows
    # activity tasks forever. See the `settings` fixture for the measurement.
    async with build_worker(client, settings, [probe]) as worker:
        assert worker.task_queue == settings.temporal_task_queue
        assert worker.task_queue.startswith(ACTIVITY_QUEUE_PREFIX)
        assert list(worker.config()["activities"]) == [probe]
        # A Python worker runs ACTIVITIES ONLY. Workflow code lives in
        # `apps/api/src/workflows/**` (CLAUDE.md), where determinism is enforced
        # by lint rules this side of the repository does not have — so
        # `build_worker` taking a `workflows` argument at all would be the
        # beginning of a second place for orchestration to live.
        assert list(worker.config()["workflows"]) == []


@pytest.mark.integration
async def test_build_worker_rejects_an_undecorated_function(settings: WorkerSettings) -> None:
    """Registration is validation, not a list copy.

    Without this, `test_build_worker_registers_exactly_the_activities_it_is_given`
    would pass for a `build_worker` that stored whatever it was handed and
    polled nothing.
    """
    client = await build_client(settings)

    with pytest.raises(TypeError, match="activity"):
        build_worker(client, settings, [not_an_activity])


@pytest.mark.integration
async def test_the_worker_polls_the_task_queue_from_settings(settings: WorkerSettings) -> None:
    """The round trip, and the only test here that could not pass against a mock.

    Two workers: the one under test, built by `build_worker` from settings and
    registering the probe activity, and a workflow worker on a DIFFERENT queue
    that exists because Temporal has no way to invoke an activity directly. The
    workflow asks for the activity by name on `settings.temporal_task_queue`;
    the activity answers with the queue it was actually dispatched on.

    So a `build_worker` that connected happily and polled the wrong queue fails
    here — after ~30 seconds, on the workflow's `schedule_to_start` timeout,
    rather than hanging until the suite is killed.
    """
    client = await build_client(settings)

    async with (
        Worker(client, task_queue=WORKFLOW_QUEUE, workflows=[ProbeWorkflow]),
        build_worker(client, settings, [probe]),
    ):
        dispatched_on = await client.execute_workflow(
            ProbeWorkflow.run,
            settings.temporal_task_queue,
            id=f"probe-{uuid.uuid4()}",
            task_queue=WORKFLOW_QUEUE,
        )

    assert dispatched_on == settings.temporal_task_queue
    assert dispatched_on.startswith(ACTIVITY_QUEUE_PREFIX)


def test_the_images_match_the_local_stack() -> None:
    """No daemon needed, and that is the point — this is the drift guard.

    `packages/database/test/postgres-image.test.ts` keeps
    `infra/docker/docker-compose.yml` equal to `packages/testing/src/images.ts`;
    this keeps it equal to the two constants in `_temporal_server.py`. A local
    stack, a Node integration run and a Python integration run on three
    different Temporal builds is a green CI with a broken laptop.

    `apps/workers/turbo.json` declares the compose file as a `$TURBO_ROOT$`
    input for exactly this test. Without that entry turbo hashes only this
    package's own files and replays a green log while the file this reads has
    drifted.
    """
    compose = COMPOSE_FILE.read_text(encoding="utf-8")

    for image in (TEMPORAL_IMAGE, POSTGRES_IMAGE):
        assert f"image: {image}" in compose, (
            f"{image} is not an image infra/docker/docker-compose.yml runs; this suite and the "
            "local stack must not drift onto different builds"
        )
