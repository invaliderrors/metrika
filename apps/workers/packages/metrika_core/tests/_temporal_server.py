"""One real Temporal server, shared by every suite in this package that needs one.

**Why this is a module and not `conftest.py` itself.** `test_temporal.py` owned
these fixtures until `test_telemetry.py` needed the same server, and a second
`temporal_address` fixture would have started a second `auto-setup` container —
three minutes of boot to prove the same thing twice. pytest only shares fixtures
through `conftest.py`, and `conftest.py` is already a file with a job (clearing
`METRIKA_WORKER_*`), so the fixtures live here and `conftest.py` imports them.
That is a supported arrangement: pytest collects fixtures from the conftest
module's namespace, imported ones included.

**Why this suite starts its own containers instead of calling `packages/testing`'s
harness.** That harness is TypeScript, invoked from Vitest; this is pytest, and
there is no in-process path from one to the other. Reaching it would mean making
`@metrika/workers` a Node package with a dependency and a runner script wrapping
`uv run pytest` — which puts a second process manager in front of every Python
test to save the twenty lines below. `test_storage.py` already made this call for
MinIO and states it in the same terms. What the two harnesses must not do is
DIVERGE, so:

- the images are constants here and `test_the_images_match_the_local_stack` in
  `test_temporal.py` fails if either stops matching
  `infra/docker/docker-compose.yml`, which
  `packages/database/test/postgres-image.test.ts` in turn keeps equal to
  `packages/testing/src/images.ts`. Three consumers, one tag, two gates.
- `BIND_ON_IP` and `DB_PORT` are set for the reasons
  [ADR-0028](../../../../../docs/adr/0028-temporal-bind-on-ip.md) and ADR-0027
  measured, and the comments below say which failure each prevents. They are
  not copied hopefully from the harness; this fixture was run WITHOUT
  `BIND_ON_IP` to check. It fails — the wait strategy times out and the
  container's own log shows the server serving normally on `172.19.0.3:7234`,
  one interface that is not loopback and therefore not the one the readiness
  probe can reach. (The address there is the custom network's rather than the
  default bridge's, which is where the Node harness's version of this landed;
  the interface it picks does not matter, only that it picks exactly one.)
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import Iterator
from contextlib import ExitStack
from pathlib import Path

import pytest
from temporalio.api.workflowservice.v1 import (
    DescribeNamespaceRequest,
    ListWorkflowExecutionsRequest,
)
from temporalio.client import Client
from testcontainers.core.container import DockerContainer
from testcontainers.core.network import Network
from testcontainers.core.wait_strategies import ExecWaitStrategy

from metrika_core.settings import WorkerSettings

# KEEP IN SYNC with the `temporal` and `postgres` services in
# infra/docker/docker-compose.yml — `test_the_images_match_the_local_stack` in
# `test_temporal.py` fails when they diverge.
#
# `auto-setup` needs a datastore: its own /etc/temporal/auto-setup.sh accepts
# exactly mysql8, postgres12, postgres12_pgx and cassandra, so a Postgres here
# is not an optional extra but the only way to get a server at all. Nothing in
# this suite stores anything in it.
TEMPORAL_IMAGE = "temporalio/auto-setup:1.29.7"
POSTGRES_IMAGE = "postgres:16-alpine"

_FRONTEND_PORT = 7233
_POSTGRES_PORT = 5432
NAMESPACE = "default"

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

# The HOST-side gate below. Short, because by the time it runs the container has
# already reported itself usable from the inside; this is only closing the gap
# between the two, which Task 5 of Plan 0B-3 measured at 0.10 to 0.25s.
_READINESS_TIMEOUT_S = 60
_READINESS_POLL_S = 0.05
_RPC_TIMEOUT_S = 10

COMPOSE_FILE = Path(__file__).resolve().parents[5] / "infra" / "docker" / "docker-compose.yml"

# The queue a worker built by `build_worker` polls, and the separate one a
# test's own workflow worker polls. Two queues on purpose: if they were the same
# string, a `build_worker` that ignored `settings.temporal_task_queue` entirely
# and hard-coded the workflow worker's queue would still pass.
#
# The activity one is a PREFIX: the `settings` fixture appends a uuid so that
# every test gets a queue no other test has ever named. That is not tidiness —
# see the measurement on that fixture.
ACTIVITY_QUEUE_PREFIX = "metrika-core-tests-activities"
WORKFLOW_QUEUE = "metrika-core-tests-workflows"


async def _usable(address: str) -> None:
    """Two RPCs from THIS process, both of which a caller depends on.

    The wait strategy below proves the server is usable from INSIDE the
    container. That is not the same claim, and Plan 0B-3 measured the
    difference: `DescribeNamespace` goes green as soon as the
    `RegisterNamespace` row commits, while everything a real caller does
    resolves through the frontend's namespace **registry**, which lags it by
    **0.10 to 0.25s**. A container-level check alone is structurally the pre-fix
    condition, and these suites make registry-resolved calls —
    `execute_workflow`, and a worker polling a task queue.

    Measured before this function existed: `ListWorkflowExecutions` was already
    usable at t≈0.00s in 3 of 3 boots, because python-testcontainers polls the
    exec strategy on a **1s** cadence and the lag is a quarter of that. That is
    ~0.75s of incidental margin, not a design, and it is not a thing to leave a
    suite standing on.

    So: `DescribeNamespace` (the frontend is up and the namespace row exists)
    and then `ListWorkflowExecutions` (the registry has resolved it), on the
    MAPPED port, which is the only address any caller here will use.
    """
    client = await Client.connect(address, namespace=NAMESPACE)
    await client.workflow_service.describe_namespace(DescribeNamespaceRequest(namespace=NAMESPACE))
    await client.workflow_service.list_workflow_executions(
        ListWorkflowExecutionsRequest(namespace=NAMESPACE, page_size=1)
    )


def _await_usable(address: str) -> None:
    """Poll `_usable` until it succeeds, or fail naming the last error.

    Bounded rather than retried forever: the failure this bound prevents — a
    fixture that HANGS against a dead address instead of failing — reads as
    infrastructure trouble rather than as a bug.
    """
    deadline = time.monotonic() + _READINESS_TIMEOUT_S
    last: BaseException | None = None
    while time.monotonic() < deadline:
        try:
            asyncio.run(asyncio.wait_for(_usable(address), timeout=_RPC_TIMEOUT_S))
        # Any RPC failure here means "not yet", including a connection
        # refusal: this loop is the thing that decides when it stops meaning
        # that, and the deadline above is what stops it meaning it forever.
        except Exception as error:
            last = error
            time.sleep(_READINESS_POLL_S)
        else:
            return
    raise AssertionError(f"{address} never became usable from this process: {last!r}")


@pytest.fixture(scope="session")
def temporal_address() -> Iterator[str]:
    """One Temporal server for the whole session, torn down with its volumes.

    `ExitStack` rather than nested `try/finally`, so that unwinding is LIFO by
    construction: the network cannot be removed while a container is still
    attached to it, and a `finally` that gets that order wrong leaves a network
    behind on every failing run.

    **Each `stop` is registered BEFORE its `start`, which is the opposite of the
    obvious order and is the version that cleans up.** MEASURED, by deleting
    `BIND_ON_IP` to check that this fixture really needs it: the wait strategy
    times out INSIDE `start()`, so a callback registered after it never exists —
    leaving a running container attached to a network that then cannot be
    removed (`403 … has active endpoints`), on the failure path, which is the
    one path that matters for cleanup. `DockerContainer.stop` is a no-op when
    `self._container` is `None`, so registering it early is safe when the
    container was never created at all.
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
        stack.callback(postgres.stop, force=True, delete_volume=True)
        postgres.start()

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
                        NAMESPACE,
                        "--address",
                        f"127.0.0.1:{_FRONTEND_PORT}",
                    ]
                ).with_startup_timeout(_STARTUP_TIMEOUT_S)
            )
        )
        stack.callback(temporal.stop, force=True, delete_volume=True)
        temporal.start()

        host = temporal.get_container_host_ip()
        port = temporal.get_exposed_port(_FRONTEND_PORT)
        address = f"{host}:{port}"

        # The wait strategy above spoke to the server from inside the container.
        # This is the only address any caller here will use, and the frontend's
        # namespace registry lags the row the container-side check sees — see
        # `_usable`.
        _await_usable(address)

        yield address


@pytest.fixture
def settings(temporal_address: str, monkeypatch: pytest.MonkeyPatch) -> WorkerSettings:
    """Settings built the way a worker builds them — from the environment.

    Deliberately not `WorkerSettings(temporal_address=…)`: the prefix, the
    defaults and the required fields are part of what can be wrong, and passing
    keyword arguments here would test three attributes while skipping the wiring
    that decides whether a deployed worker reads anything at all.

    **A UNIQUE TASK QUEUE PER TEST, and it took a flake to learn why.**
    MEASURED on temporalio 1.31.0, one boot against a real server, with a
    positive control:

        running worker (`async with`) → activity pollers .......... 1
        constructed, never run → activity pollers after 6s ........ 0
        del + gc.collect(), second Worker on that queue ........... RuntimeError
        the same from a new event loop and a new Client ........... no error

    So constructing a `Worker` is not building a local object — it takes a
    **process-local registration that dropping the object does not release**,
    and core says so by name: `Registration of multiple workers with overlapping
    worker task types on the same namespace, task queue, and deployment build ID
    not allowed: SlotKey { namespace: "default", task_queue: … }`. `shutdown()`
    is no escape: it waits on an event only `run()` sets, so on a never-run
    worker it hangs.

    It does NOT poll, and an earlier version of this docstring claimed it did —
    inferred from the symptom below rather than measured. The control is what
    refutes it: 0 pollers, and an activity whose only worker is an abandoned one
    times out on `ScheduleToStart`, which is what "no worker at all" looks like
    rather than what "a worker eating tasks" looks like.

    THE SYMPTOM, left unexplained deliberately: with an abandoned worker from an
    earlier event loop still in the process, a properly RUNNING worker on the
    same queue is starved. The round-trip test in `test_temporal.py` failed
    roughly one run in three with `activity StartToClose timeout` — the server
    saying the task WAS dispatched — while the process's own debug log showed no
    `Running activity` line at all. Isolated, on a shared queue, one
    `asyncio.run` per simulated test: **4 failures in 6 with an abandoned
    worker, 0 in 6 without**, and reproduced again in the run above. The
    mechanism is not established; do not write one down here without measuring
    it.

    So: one queue per test, and every test that builds a worker enters it as a
    context manager. Either alone would fix today's flake; both together are
    what makes it impossible for a test added later to steal another's work,
    and the unique queue is also what keeps the `SlotKey` collision above out of
    a suite that builds a worker in more than one test.
    """
    monkeypatch.setenv("METRIKA_WORKER_TEMPORAL_ADDRESS", temporal_address)
    monkeypatch.setenv(
        "METRIKA_WORKER_TEMPORAL_TASK_QUEUE", f"{ACTIVITY_QUEUE_PREFIX}-{uuid.uuid4()}"
    )
    monkeypatch.setenv("METRIKA_WORKER_S3_BUCKET", "metrika-models")
    return WorkerSettings()
