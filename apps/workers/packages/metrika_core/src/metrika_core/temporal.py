"""The workers' only door to Temporal.

Three functions, and they are the whole of what both worker processes share:
dial a server, build a worker for the queue the settings name, run it until the
platform asks it to stop. `metrika_geometry.__main__` and
`metrika_slicer.__main__` differ in the activities they register and in nothing
else, which is deliberate — two entry points that each grew their own client
setup would drift on exactly the details (namespace, shutdown, what happens on
SIGTERM) that are invisible until a production incident.

**There is no workflow here, and there will not be one.** Temporal workflows for
this system live in `apps/api/src/workflows/**` in TypeScript, where the
determinism rules are enforced by lint (CLAUDE.md). The Python side is
activities: stateless compute, no database credentials, whatever the S3 role can
reach and nothing else (ADR-0007). `build_worker` therefore takes no `workflows`
argument at all — not as an oversight, but so that adding orchestration here is
an edit to this file with a reviewer attached, rather than an extra keyword
argument at a call site.
"""

from __future__ import annotations

import asyncio
import signal
from collections.abc import Callable, Sequence

import structlog
from temporalio.client import Client
from temporalio.worker import Worker

from metrika_core.settings import WorkerSettings

# What a registered activity looks like from here: something `@activity.defn`
# has been applied to. The parameters are deliberately unconstrained — each
# activity's real signature is its own contract with the workflow that calls it,
# and narrowing this to a single shape would either be a lie or force every
# activity through one payload type.
#
# `object` rather than `Any` as the return: `disallow_any_explicit` is on
# (CLAUDE.md's "no `any`, no exceptions" applies to this side too), and nothing
# here inspects the value — Temporal's data converter serialises it. A caller
# that wants the concrete type keeps it at the call site, where it is checked.
#
# THE SUPPRESSION IS ABOUT THE PARAMETERS, NOT THE RETURN. MEASURED on mypy
# 2.3.0: `Callable[..., object]` reports `explicit-any`, because `...` is
# spelled internally as Any-typed parameters — there is no `object` equivalent
# for "any parameter list". The alternatives are all worse: `Callable[[], object]`
# is false for every activity that takes an argument, and a `Protocol` with
# `__call__(*args: object, **kwargs: object)` is not implemented by a normal
# `async def analyse(request: Request) -> Result`, so it would reject exactly the
# functions this alias exists to accept.
#
# ONE suppression, on the alias, rather than one at each of the two signatures
# below — which is the reason to have the alias at all.
Activity = Callable[..., object]  # type: ignore[explicit-any]  # -- `...` is the Any; see above


async def build_client(settings: WorkerSettings) -> Client:
    """Connect to the server and namespace `settings` name.

    Eager, not `lazy=True`: a lazy client defers the connection to the first
    call, which moves a misconfigured address from "the process failed to start"
    to "the process is up and every task fails" — and the second is the one that
    pages someone at 3am. A worker that cannot reach Temporal has nothing to do,
    so failing here is failing in the right place.

    No `tls=` and no `api_key=` argument. Temporal Cloud (ADR-0006) needs both,
    and they are credentials, so they will arrive as a deployment concern
    through `WorkerSettings` — which is where every other piece of configuration
    already comes from, and which has the redaction rules pointed at it.
    """
    return await Client.connect(
        settings.temporal_address,
        namespace=settings.temporal_namespace,
    )


def build_worker(
    client: Client,
    settings: WorkerSettings,
    activities: Sequence[Activity],
) -> Worker:
    """A worker polling `settings.temporal_task_queue` for `activities`.

    The task queue comes from settings rather than from an argument on purpose.
    It is the one piece of configuration that decides whether a running,
    healthy-looking worker does any work at all — a wrong queue is not an error
    anywhere, it is silence — so it is read from the same place as everything
    else a deployment sets, and never chosen by the calling module.

    `Worker` rejects a callable that `@activity.defn` was never applied to, so
    this is a real registration and not a list copy;
    `test_build_worker_rejects_an_undecorated_function` pins that.

    `graceful_shutdown_timeout` is left at Temporal's default of zero, which
    cancels in-flight activities immediately on shutdown. That is the right
    default while every activity is stateless and idempotent: Temporal retries a
    cancelled activity on another worker, and there is nothing in this process
    worth waiting for. It stops being right the day an activity holds something
    a retry cannot reproduce — which is a reason to revisit it with a measured
    number, not to guess one now.
    """
    return Worker(
        client,
        task_queue=settings.temporal_task_queue,
        activities=list(activities),
    )


async def run_worker(settings: WorkerSettings, activities: Sequence[Activity]) -> None:
    """Run a worker until SIGINT or SIGTERM, then shut it down.

    **Handling SIGTERM is the point.** A container runtime sends it and then
    waits a grace period before SIGKILL; a process that ignores it is killed
    mid-poll on every single deploy, and every activity it was running fails and
    is retried. `Worker.run()` on its own does not install a handler, and the
    `KeyboardInterrupt` path only covers SIGINT — that is, only an interactive
    terminal, which is the one place it does not matter.

    `async with worker` rather than `await worker.run()`: leaving the block
    performs the SDK's own shutdown — stop polling, finish or cancel what is in
    flight, drain — instead of cancelling a task that is midway through a poll.
    """
    log = structlog.get_logger()

    client = await build_client(settings)
    worker = build_worker(client, settings, activities)

    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    for received in (signal.SIGINT, signal.SIGTERM):
        # `loop.add_signal_handler`, not `signal.signal`: the latter runs its
        # handler between bytecodes on the main thread and cannot safely touch
        # the event loop, so setting an asyncio primitive from it is a race. The
        # loop variant schedules the callback on the loop itself.
        loop.add_signal_handler(received, stopping.set)

    log.info(
        "worker.starting",
        task_queue=settings.temporal_task_queue,
        namespace=settings.temporal_namespace,
        address=settings.temporal_address,
        activities=len(activities),
    )
    async with worker:
        await stopping.wait()
    log.info("worker.stopped", task_queue=settings.temporal_task_queue)
