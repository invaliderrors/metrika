"""Fixtures shared by `metrika_core`'s suite.

One is defined here, and it exists because `WorkerSettings` reads a whole
namespace rather than the names it declares: a developer with
`METRIKA_WORKER_LOG_LEVEL` exported would otherwise see tests fail for a reason
that has nothing to do with the code under test.

The other two are IMPORTED, from `_temporal_server.py`. pytest shares fixtures
only through a `conftest.py`, and it collects them from this module's namespace
whether they were defined here or imported into it — so re-exporting is how
`test_temporal.py` and `test_telemetry.py` come to share ONE `auto-setup`
container for the session instead of booting one each. They are not defined
inline because the container configuration is sixty lines of measured detail
with a docstring per decision, and this file would then be that file.
"""

from __future__ import annotations

import os
import time

import _temporal_server
import pytest
from testcontainers.core.docker_client import DockerClient

# ─── Docker publishes a port asynchronously; testcontainers reads it at once ───
#
# `DockerContainer.start()` returns as soon as the daemon accepts the start, and
# EVERY port lookup in the library funnels through `DockerClient.port`, which
# raises `ConnectionError: Port mapping for container … is not available` the
# instant a binding is not yet visible instead of waiting for it. Nothing on
# that path retries: the wait STRATEGIES do, but `HttpWaitStrategy` builds its
# URL from this call as the first thing it does, and the Reaper reads its own
# port with no strategy at all.
#
# MEASURED on Docker Desktop for Windows with testcontainers 4.15.0, running
# `pnpm test:integration`: the reaper's port 8080 was unavailable at the moment
# of the read, run after run, while `docker inspect` on that same container a
# second later reported `0.0.0.0:56624->8080/tcp` and its log said `Started!`.
# The container is healthy; the read is early. It is not a load effect — the
# same suite failed with turbo's tasks serialised (`--concurrency=1`).
#
# THE FIRST FAILURE THEN CASCADES, which is why the error never names the real
# cause. The reaper's container name carries a MODULE-LEVEL session id, so every
# later fixture retries the same name and gets `409 … container name
# "/testcontainers-ryuk-…" is already in use`. Ten tests report a docker naming
# conflict for one early read.
#
# Patched on the class rather than worked around per fixture because the reaper
# is constructed inside the library, where no fixture can reach it — and because
# a per-fixture version would have to be repeated for every container this
# package ever starts. DELETE THIS once testcontainers retries the lookup
# itself; nothing else here depends on it.
_PORT_LOOKUP_TIMEOUT_S = 30.0
_PORT_LOOKUP_POLL_S = 0.1
_unpatched_port = DockerClient.port


def _port_awaiting_publication(self: DockerClient, container_id: str, port: int) -> str:
    """`DockerClient.port`, but waiting for the binding instead of failing on it.

    Bounded rather than retried forever, for the reason
    `_temporal_server._await_usable` gives: a harness that HANGS reads as
    infrastructure trouble, one that fails reads as a bug. The original error is
    re-raised on timeout, so a port that genuinely never appears still says so
    in the library's own words.
    """
    deadline = time.monotonic() + _PORT_LOOKUP_TIMEOUT_S
    while True:
        try:
            return _unpatched_port(self, container_id, port)
        except ConnectionError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(_PORT_LOOKUP_POLL_S)


DockerClient.port = _port_awaiting_publication  # type: ignore[method-assign]  # -- see above

# THE RE-EXPORT, spelled as assignments rather than as a `from … import` line
# carrying a suppression. pytest collects fixtures from this module's namespace,
# so binding the names here is what shares them.
#
# Written this way there is no unused-import warning to suppress, which is worth
# two lines: a suppression on this line would need an inline justification (and
# CI greps for that, not for the linters' opinion of it), and it would have to
# carry an isort directive as well, because `_temporal_server` is a sibling
# module that ruff files as third-party. Assignments need neither.
settings = _temporal_server.settings
temporal_address = _temporal_server.temporal_address

# `METRIKA_WORKER_`, deliberately narrower than the `METRIKA_` this file used to
# clear. Two reasons, and the second is the interesting one.
#
# It is the namespace `WorkerSettings` actually claims, so clearing more would be
# a fixture reaching outside its subject. And leaving the rest of `METRIKA_`
# alone means that on any machine where the Node integration harness has run —
# where `METRIKA_TEST_DATABASE_URL` really is exported — every `WorkerSettings()`
# in this suite constructs with it present. The prefix narrowing is then load-
# bearing for the whole file rather than for the one test that names it.
_PREFIX = "METRIKA_WORKER_"


@pytest.fixture(autouse=True)
def isolated_worker_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove every inherited `METRIKA_WORKER_*` variable before each test.

    Function-scoped and autouse. The session-scoped MinIO fixtures in
    `test_storage.py` are unaffected: pytest instantiates higher-scoped fixtures
    first, so the settings they need are already read by the time this runs, and
    the AWS credentials they keep using are not in this namespace.
    """
    for name in list(os.environ):
        if name.upper().startswith(_PREFIX):
            monkeypatch.delenv(name, raising=False)
