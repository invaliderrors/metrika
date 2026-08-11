"""`ObjectStore` against a real MinIO container, not a mock.

A mocked S3 client proves this module calls a method. It cannot prove the call
is correct, and correctness at this boundary is the only thing `storage.py`
exists for — an addressing style MinIO rejects, a presigned URL that is not
actually signed, and a missing key that returns `b""` instead of raising all
pass a mock and all break a worker. So the suite starts the same MinIO image
`infra/docker/docker-compose.yml` runs, and `test_the_minio_image_matches_the_local_stack`
keeps the two from drifting.

ONE CONTAINER PER RUN, and the teardown is real rather than a documented no-op:
unlike `packages/testing`'s Postgres harness there is no `globalSetup` here to
hand a container to forked workers, because pytest runs this suite in a single
process. The session-scoped fixture below is therefore the only owner, and it
stops the container and deletes its volume in a `finally`.

MARKED `integration`, and deselected by `addopts` in `apps/workers/pyproject.toml`:
`pnpm verify` must keep working on a machine with no Docker daemon, which is
what `packages/testing/src/docker.ts` promises in the error a developer actually
reads ("Unit tests do not need Docker and are unaffected"). Run these with
`pnpm --filter @metrika/workers run test:integration`.
"""

from __future__ import annotations

import http.client
import uuid
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from testcontainers.core.container import DockerContainer
from testcontainers.core.wait_strategies import HttpWaitStrategy

from metrika_core.settings import WorkerSettings
from metrika_core.storage import ObjectNotFoundError, ObjectStore, build_s3_client

pytestmark = pytest.mark.integration

# KEEP IN SYNC with the `minio` service in infra/docker/docker-compose.yml.
# `test_the_minio_image_matches_the_local_stack` below fails when they diverge,
# for the same reason `packages/database/test/postgres-image.test.ts` exists on
# the Node side: a local stack on one MinIO and a test run on another is a green
# CI with a broken laptop.
MINIO_IMAGE = "minio/minio:RELEASE.2025-09-07T16-13-09Z"

_MINIO_PORT = 9000
_BUCKET = "metrika-models"

# The same credentials docker-compose.yml already gives the local MinIO, in
# public, in a committed file. Named for what MinIO calls them and suppressed
# explicitly: an earlier version called the second one `_ROOT_KEY` purely so that
# S105 would not fire, which is renaming around a detector. That is strictly
# worse than a suppression — it leaves the rule silent AND the name misleading,
# and the next person cannot tell the dodge from a real access key.
_ROOT_USER = "metrika"
_ROOT_PASSWORD = "metrika-local"  # noqa: S105  # -- the public local-dev pair, already in compose

_COMPOSE_FILE = Path(__file__).resolve().parents[5] / "infra" / "docker" / "docker-compose.yml"


@pytest.fixture(scope="session")
def minio_endpoint() -> Iterator[str]:
    """One MinIO container for the whole session, torn down with its volume."""
    container = (
        DockerContainer(MINIO_IMAGE)
        .with_command("server /data")
        .with_env("MINIO_ROOT_USER", _ROOT_USER)
        .with_env("MINIO_ROOT_PASSWORD", _ROOT_PASSWORD)
        .with_exposed_ports(_MINIO_PORT)
        # Not a fixed sleep and not "the container is running": MinIO answers
        # /minio/health/live only once it will serve S3 requests, so this is the
        # readiness signal rather than a guess at one.
        .waiting_for(HttpWaitStrategy(_MINIO_PORT, "/minio/health/live"))
    )
    container.start()
    try:
        host = container.get_container_host_ip()
        port = container.get_exposed_port(_MINIO_PORT)
        yield f"http://{host}:{port}"
    finally:
        container.stop(force=True, delete_volume=True)


@pytest.fixture(scope="session")
def store(minio_endpoint: str) -> Iterator[ObjectStore]:
    """An `ObjectStore` built the way a worker builds one — through settings.

    Deliberately NOT `ObjectStore(bucket=..., client=...)`: the environment
    prefix, the optional endpoint override and the addressing style are all part
    of what can be wrong, and constructing the client by hand here would test
    three methods while skipping the wiring that decides whether they reach
    anything.

    `pytest.MonkeyPatch()` rather than the `monkeypatch` fixture because that
    one is function-scoped and this container is not.
    """
    patch = pytest.MonkeyPatch()
    patch.setenv("METRIKA_WORKER_S3_BUCKET", _BUCKET)
    patch.setenv("METRIKA_WORKER_TEMPORAL_TASK_QUEUE", "geometry-small")
    patch.setenv("METRIKA_WORKER_S3_ENDPOINT_URL", minio_endpoint)
    patch.setenv("AWS_ACCESS_KEY_ID", _ROOT_USER)
    patch.setenv("AWS_SECRET_ACCESS_KEY", _ROOT_PASSWORD)
    patch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    try:
        settings = WorkerSettings()
        # Creating a bucket is an administrative action a worker must never be
        # able to perform — its role is scoped to a prefix of an existing one —
        # so it is done here with a client of the test's own rather than by
        # widening `ObjectStore`.
        build_s3_client(settings.s3_endpoint_url).create_bucket(Bucket=settings.s3_bucket)
        yield ObjectStore.from_settings(settings)
    finally:
        patch.undo()


def _key(prefix: str) -> str:
    return f"{prefix}/{uuid.uuid4()}"


def test_puts_and_gets_the_same_bytes(store: ObjectStore) -> None:
    key = _key("round-trip")
    body = b"solid metrika\nfacet normal 0 0 0\n\x00\xff"

    store.put_object(key, body)

    assert store.get_object(key) == body


def test_get_object_raises_for_a_missing_key(store: ObjectStore) -> None:
    """The one failure mode that must never be silent.

    An empty `bytes` here reaches the mesh parser as a zero-triangle model, and
    a zero-triangle model prices as free. Raising is the whole contract.
    """
    with pytest.raises(ObjectNotFoundError):
        store.get_object(_key("absent"))


def test_presigned_get_returns_a_url_that_resolves(store: ObjectStore) -> None:
    key = _key("presigned")
    body = b"presigned round trip"
    store.put_object(key, body)

    url = store.presigned_get(key, expires_s=60)

    assert "X-Amz-Signature" in url, f"not actually signed: {url}"
    status, downloaded = _get(url)
    assert status == 200
    assert downloaded == body


def test_the_object_is_not_readable_without_the_signature(store: ObjectStore) -> None:
    """Makes the test above mean something.

    A public bucket would serve the object to an unsigned request too, and then
    `test_presigned_get_returns_a_url_that_resolves` would pass with a
    `presigned_get` that returned a plain URL.
    """
    key = _key("presigned")
    store.put_object(key, b"presigned round trip")

    unsigned = store.presigned_get(key, expires_s=60).split("?")[0]

    status, _ = _get(unsigned)
    assert status == 403, f"expected AccessDenied for an unsigned GET, got {status}"


def test_the_minio_image_matches_the_local_stack() -> None:
    compose = _COMPOSE_FILE.read_text(encoding="utf-8")

    assert f"image: {MINIO_IMAGE}" in compose, (
        f"{MINIO_IMAGE} is not the image infra/docker/docker-compose.yml runs; "
        "a local stack and a test run on two different MinIO releases is a green "
        "CI with a broken laptop"
    )


def _get(url: str) -> tuple[int, bytes]:
    """A bare HTTP GET of `url`.

    `http.client` rather than `urllib.request.urlopen` on purpose: the latter
    accepts `file://` and every other scheme its openers register, which is what
    ruff's S310 is about, and suppressing a security rule to fetch a URL is a bad
    trade when the standard library has a plain HTTP client one import away.
    """
    parts = urlsplit(url)
    assert parts.hostname is not None, url
    connection = http.client.HTTPConnection(parts.hostname, parts.port, timeout=10)
    try:
        connection.request("GET", f"{parts.path}?{parts.query}" if parts.query else parts.path)
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()
