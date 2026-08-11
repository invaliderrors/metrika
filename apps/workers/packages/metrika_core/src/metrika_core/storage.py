"""The workers' only door to persistent state.

ADR-0007: a worker has no database credentials. Everything it may read or write
lives in S3 under a prefix-scoped role, and this is the one module in the Python
side that names `boto3` — so the blast radius of a compromised mesh parser is
whatever that role can reach, and the surface a reviewer has to read to know
what that is fits on one screen.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from metrika_core.settings import WorkerSettings

if TYPE_CHECKING:
    # From `boto3-stubs[s3]`, a dev dependency of the workspace root. `boto3` and
    # `botocore` ship no `py.typed`, so without it every call below is unchecked
    # `Any` and `mypy --strict` is decorative across this whole module — ADR-0027
    # obligation 3. Type-checking-only, so it is not a runtime dependency of a
    # deployed worker.
    from mypy_boto3_s3.client import S3Client

# S3 answers a GET for an absent key with `NoSuchKey`; a bare `404` is what an
# S3-compatible implementation answering without a modelled code produces, and it
# means the same thing.
#
# `NoSuchBucket` is deliberately NOT here, and it was, briefly. A misconfigured
# `METRIKA_WORKER_S3_BUCKET` is a configuration fault, not a missing object — folding it
# in made a typo'd bucket present as "every object in the pipeline is missing",
# which is a diagnosis several layers away from the cause. It propagates as a
# `ClientError` instead, which is what an unexpected S3 failure should do.
_NOT_FOUND_CODES = frozenset({"NoSuchKey", "404"})


class ObjectNotFoundError(Exception):
    """Raised by `ObjectStore.get_object` when the key does not exist.

    A distinct type, not `ClientError`, so that callers handle a missing object
    without importing `botocore` — which would put a second module on the list
    of things that name the S3 SDK.
    """

    def __init__(self, bucket: str, key: str) -> None:
        super().__init__(f"s3://{bucket}/{key} does not exist")
        self.bucket = bucket
        self.key = key


def build_s3_client(endpoint_url: str | None) -> S3Client:
    """An S3 client for `endpoint_url`, or for real AWS when it is `None`.

    Credentials and region come from the standard provider chain — an
    IRSA/instance role in production, `AWS_*` locally — so nothing here takes,
    stores or logs one.

    **Path-style addressing whenever an endpoint is configured**, and this is not
    cosmetic. botocore's default (`auto`) prefers virtual-hosted style for a
    DNS-compatible bucket, which turns a MinIO endpoint into
    `http://metrika-models.localhost:9000/…` — a host that does not resolve.
    Real AWS keeps `auto`, because virtual-hosted is the style AWS itself is
    moving to.
    """
    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path" if endpoint_url is not None else "auto"},
        ),
    )


class ObjectStore:
    """Reads and writes one bucket.

    The bucket is fixed at construction rather than passed per call: a worker
    has exactly one, it comes from `WorkerSettings`, and a per-call bucket would
    be an argument an activity payload could set.
    """

    def __init__(self, *, bucket: str, client: S3Client) -> None:
        self._bucket = bucket
        self._client = client

    @classmethod
    def from_settings(cls, settings: WorkerSettings) -> ObjectStore:
        return cls(bucket=settings.s3_bucket, client=build_s3_client(settings.s3_endpoint_url))

    def get_object(self, key: str) -> bytes:
        """The object's bytes, or `ObjectNotFoundError`.

        Never `b""` for a missing key. An empty result reaches the mesh parser
        as a zero-triangle model, and a zero-triangle model prices as free —
        the same class of silent wrong answer as `trimesh` returning a plausible
        volume for a non-watertight mesh (ADR-0027).
        """
        try:
            response = self._client.get_object(Bucket=self._bucket, Key=key)
        except ClientError as error:
            if error.response["Error"].get("Code") in _NOT_FOUND_CODES:
                raise ObjectNotFoundError(self._bucket, key) from error
            raise
        return response["Body"].read()

    def put_object(self, key: str, body: bytes) -> None:
        self._client.put_object(Bucket=self._bucket, Key=key, Body=body)

    def presigned_get(self, key: str, expires_s: int) -> str:
        """A time-limited download URL for `key`.

        The returned string carries `X-Amz-Signature` and is therefore a bearer
        credential for that object until it expires. It must never be logged:
        `metrika_core.logging` redacts the keys it would arrive under, and the
        unit name here (`expires_s`) is deliberately explicit so that a caller
        cannot pass minutes by accident.
        """
        return self._client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self._bucket, "Key": key},
            ExpiresIn=expires_s,
        )
