"""`metrika_core.temporal` against a real Temporal server, not a mock.

The module under test is nothing but a boundary: it dials a server and hands a
worker a task queue and a list of activities. A mock proves those calls were
made with the arguments the test already knows about, which is the one thing
that cannot be wrong here. What can be wrong is everything on the other side of
the wire — a worker that connects but polls a queue nobody publishes to, a
namespace that does not exist, an activity that is registered under a name the
workflow does not use. Every one of those passes a mock and none of them
survives `test_the_worker_polls_the_task_queue_from_settings`.

**Why this suite starts its own containers instead of calling
`packages/testing`'s harness.** That harness is TypeScript, invoked from Vitest;
this is pytest, and there is no in-process path from one to the other. Reaching
it would mean making `@metrika/workers` a Node package with a dependency and a
runner script wrapping `uv run pytest` — which puts a second process manager in
front of every Python test to save the twenty lines below. `test_storage.py`
already made this call for MinIO and states it in the same terms. What the two
harnesses must not do is DIVERGE, so:

- the images are constants here and `test_the_images_match_the_local_stack`
  fails if either stops matching `infra/docker/docker-compose.yml`, which
  `packages/database/test/postgres-image.test.ts` in turn keeps equal to
  `packages/testing/src/images.ts`. Three consumers, one tag, two gates.
- `BIND_ON_IP` and `DB_PORT` are set for the reasons
  [ADR-0028](../../../../../docs/adr/0028-temporal-bind-on-ip.md) and ADR-0027
  measured, and the comments below say which failure each prevents. They are
  not copied hopefully from the harness; without `BIND_ON_IP` this suite fails
  in exactly the way ADR-0028 describes, because testcontainers-python attaches
  an aliased container to the default bridge as well as to ours.

MARKED `integration` per test rather than per module, unlike `test_storage.py`:
the image-parity assertion needs no daemon, and a drift check that only runs
where Docker is installed is a drift check that stops running first.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from contextlib import ExitStack
from pathlib import Path

import pytest
from temporalio import activity
from temporalio.api.workflowservice.v1 import DescribeNamespaceRequest
from temporalio.worker import Worker
from testcontainers.core.container import DockerContainer
from testcontainers.core.network import Network
from testcontainers.core.wait_strategies import ExecWaitStrategy

from metrika_core.settings import WorkerSettings
from metrika_core.temporal import build_client, build_worker

from _probe_workflow import PROBE_ACTIVITY, ProbeWorkflow  # isort: skip

# KEEP IN SYNC with the `temporal` and `postgres` services in
# infra/docker/docker-compose.yml — `test_the_images_match_the_local_stack`
# below fails when they diverge.
#
# `auto-setup` needs a datastore: its own /etc/temporal/auto-setup.sh accepts
# exactly mysql8, postgres12, postgres12_pgx and cassandra, so a Postgres here
# is not an optional extra but the only way to get a server at all. Nothing in
# this suite stores anything in it.
TEMPORAL_IMAGE = "temporalio/auto-setup:1.29.7"
POSTGRES_IMAGE = "postgres:16-alpine"

_FRONTEND_PORT = 7233
_POSTGRES_PORT = 5432
_NAMESPACE = "default"

# The alias is load-bearing: it is the literal value of `POSTGRES_SEEDS`, which
# is how auto-setup finds its datastore, and only a user-defined network gives
# containers embedded DNS for each other's aliases.
_POSTGRES_ALIAS = "postgres"

# The OWNER role, as in compose and in the Node harness, not `metrika_app`:
# auto-setup CREATEs its own `temporal` and `temporal_visibility` databases and
# owns their schema, which a NOSUPERUSER NOBYPASSRLS role deliberately cannot
# do. The password is the one already committed to docker-compose.yml.
_OWNER = "metrika"
_OWNER_PASSWORD = "metrika"  # noqa: S105  # -- the public local-dev pair, already in compose
_BOOTSTRAP_DATABASE = "metrika_test"

# Generous, because this container is not just a process start: it waits for
# Postgres, creates two databases, applies both schemas, boots four services and
# then registers the namespace and the search attributes.
_STARTUP_TIMEOUT_S = 180

_COMPOSE_FILE = Path(__file__).resolve().parents[5] / "infra" / "docker" / "docker-compose.yml"

# The queue a worker built by `build_worker` polls, and the separate one the
# test's own workflow worker polls. Two queues on purpose: if they were the same
# string, a `build_worker` that ignored `settings.temporal_task_queue` entirely
# and hard-coded the workflow worker's queue would still pass.
#
# The activity one is a PREFIX: the `settings` fixture appends a uuid so that
# every test gets a queue no other test has ever named. That is not tidiness —
# see the measurement on that fixture.
_ACTIVITY_QUEUE_PREFIX = "metrika-core-tests-activities"
_WORKFLOW_QUEUE = "metrika-core-tests-workflows"


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


@pytest.fixture(scope="session")
def temporal_address() -> Iterator[str]:
    """One Temporal server for the whole session, torn down with its volumes.

    `ExitStack` rather than nested `try/finally`, so that unwinding is LIFO by
    construction: the network cannot be removed while a container is still
    attached to it, and a `finally` that gets that order wrong leaves a network
    behind on every failing run.
    """
    with ExitStack() as stack:
        network = Network()
        network.create()
        stack.callback(network.remove)

        postgres = (
            DockerContainer(POSTGRES_IMAGE)
            .with_network(network)
            .with_network_aliases(_POSTGRES_ALIAS)
            .with_env("POSTGRES_USER", _OWNER)
            .with_env("POSTGRES_PASSWORD", _OWNER_PASSWORD)
            .with_env("POSTGRES_DB", _BOOTSTRAP_DATABASE)
            .with_exposed_ports(_POSTGRES_PORT)
        )
        postgres.start()
        stack.callback(postgres.stop, force=True, delete_volume=True)

        temporal = (
            DockerContainer(TEMPORAL_IMAGE)
            .with_network(network)
            .with_network_aliases("temporal")
            .with_env("DB", "postgres12")
            # `DB_PORT` defaults to 3306 — MySQL's port — and omitting it does
            # not fail loudly: auto-setup.sh loops
            # `until nc -z "${POSTGRES_SEEDS}" 3306`, so the container sits `Up`
            # logging "Waiting for PostgreSQL" until the startup timeout below
            # expires three minutes later, reporting a wait-strategy failure
            # rather than a port. ADR-0027.
            .with_env("DB_PORT", str(_POSTGRES_PORT))
            .with_env("POSTGRES_SEEDS", _POSTGRES_ALIAS)
            .with_env("POSTGRES_USER", _OWNER)
            .with_env("POSTGRES_PWD", _OWNER_PASSWORD)
            # ADR-0028, and without it this fixture does not work at all.
            # `entrypoint.sh` derives BIND_ON_IP from `getent hosts $(hostname)`
            # — the container's FIRST address — and testcontainers puts an
            # ALIASED container on the default bridge as well as on our network,
            # so the server binds the bridge interface while every name it has
            # resolves elsewhere. Measured on the Node harness as 45 seconds of
            # `connection refused` against a server that was up the whole time.
            # `0.0.0.0` binds every interface, which is what makes the loopback
            # probe below correct however many networks it lands on.
            # S104 is right in general and wrong here: it reads a literal
            # `0.0.0.0` as a service exposing itself to the network. This one is
            # INSIDE a throwaway container on a private docker network, and the
            # only thing that crosses the host boundary is the ephemeral port
            # testcontainers maps below. The alternative the rule wants — bind
            # one address — is precisely the default that does not work.
            .with_env("BIND_ON_IP", "0.0.0.0")  # noqa: S104  # -- inside the container, not on the host
            .with_exposed_ports(_FRONTEND_PORT)
            # Byte-for-byte the check the compose healthcheck and the Node
            # harness run. A port-based strategy is satisfied by a bound socket,
            # and this image binds its ports before the `default` namespace
            # exists — measured on the Node side as two consecutive execs on a
            # cold container, the first returning `Namespace default is not
            # found` and the second succeeding. Returning inside that window
            # hands out an address whose first real use fails.
            .waiting_for(
                ExecWaitStrategy(
                    [
                        "temporal",
                        "operator",
                        "namespace",
                        "describe",
                        "--namespace",
                        _NAMESPACE,
                        "--address",
                        f"127.0.0.1:{_FRONTEND_PORT}",
                    ]
                ).with_startup_timeout(_STARTUP_TIMEOUT_S)
            )
        )
        temporal.start()
        stack.callback(temporal.stop, force=True, delete_volume=True)

        host = temporal.get_container_host_ip()
        port = temporal.get_exposed_port(_FRONTEND_PORT)
        yield f"{host}:{port}"


@pytest.fixture
def settings(temporal_address: str, monkeypatch: pytest.MonkeyPatch) -> WorkerSettings:
    """Settings built the way a worker builds them — from the environment.

    Deliberately not `WorkerSettings(temporal_address=…)`: the prefix, the
    defaults and the required fields are part of what can be wrong, and passing
    keyword arguments here would test three attributes while skipping the wiring
    that decides whether a deployed worker reads anything at all.

    **A UNIQUE TASK QUEUE PER TEST, and it took a flake to learn why.**
    MEASURED on temporalio 1.31.0: constructing a `Worker` is not building a
    local object. `Worker.__init__` calls
    `temporalio.bridge.worker.Worker.create` (`_worker.py:637`), and the Rust
    core worker it makes **starts polling its task queue immediately** — before
    `run()`, and whether or not `run()` is ever called. A worker that is
    constructed, inspected and dropped therefore keeps taking activity tasks off
    that queue and never executes any of them, and `shutdown()` is no escape:
    it waits on an event only `run()` sets, so on a never-run worker it hangs.

    The symptom is the interesting part, because nothing points at the cause.
    The round-trip test below failed roughly one run in three with
    `activity StartToClose timeout` — the server saying the task WAS dispatched
    and started — while the process's own debug log showed no `Running activity`
    line at all. Isolated, on a shared queue, with one `asyncio.run` per
    simulated test: **4 failures in 6 with an abandoned worker, 0 in 6
    without.**

    So: one queue per test, and the two tests that build a worker without
    running it enter it as a context manager instead. Either alone would fix
    today's flake; both together are what makes it impossible for a test added
    later to steal another's work.
    """
    monkeypatch.setenv("METRIKA_WORKER_TEMPORAL_ADDRESS", temporal_address)
    monkeypatch.setenv(
        "METRIKA_WORKER_TEMPORAL_TASK_QUEUE", f"{_ACTIVITY_QUEUE_PREFIX}-{uuid.uuid4()}"
    )
    monkeypatch.setenv("METRIKA_WORKER_S3_BUCKET", "metrika-models")
    return WorkerSettings()


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
        assert worker.task_queue.startswith(_ACTIVITY_QUEUE_PREFIX)
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
        Worker(client, task_queue=_WORKFLOW_QUEUE, workflows=[ProbeWorkflow]),
        build_worker(client, settings, [probe]),
    ):
        dispatched_on = await client.execute_workflow(
            ProbeWorkflow.run,
            settings.temporal_task_queue,
            id=f"probe-{uuid.uuid4()}",
            task_queue=_WORKFLOW_QUEUE,
        )

    assert dispatched_on == settings.temporal_task_queue
    assert dispatched_on.startswith(_ACTIVITY_QUEUE_PREFIX)


def test_the_images_match_the_local_stack() -> None:
    """No daemon needed, and that is the point — this is the drift guard.

    `packages/database/test/postgres-image.test.ts` keeps
    `infra/docker/docker-compose.yml` equal to `packages/testing/src/images.ts`;
    this keeps it equal to the two constants above. A local stack, a Node
    integration run and a Python integration run on three different Temporal
    builds is a green CI with a broken laptop.
    """
    compose = _COMPOSE_FILE.read_text(encoding="utf-8")

    for image in (TEMPORAL_IMAGE, POSTGRES_IMAGE):
        assert f"image: {image}" in compose, (
            f"{image} is not an image infra/docker/docker-compose.yml runs; this suite and the "
            "local stack must not drift onto different builds"
        )
