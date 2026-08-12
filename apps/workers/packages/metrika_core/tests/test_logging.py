from __future__ import annotations

import json

import pytest
import structlog

from metrika_core.logging import REDACTED_KEYS, REDACTED_SUFFIXES, configure_logging


def _logged(capsys: pytest.CaptureFixture[str], **event: str) -> dict[str, str]:
    configure_logging("info")
    structlog.get_logger().info("probe", **event)
    parsed: dict[str, str] = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    return parsed


def test_emits_json(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("info")
    structlog.get_logger().info("sliced", cache_key="abc123")
    payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert payload["event"] == "sliced"
    assert payload["cache_key"] == "abc123"


def test_redacts_a_presigned_url(capsys: pytest.CaptureFixture[str]) -> None:
    """A signed URL in a log is a credential in a log.

    SECURITY.md requires signed URLs and file names to be redacted from every
    log line. structlog will happily serialise whatever it is handed, so the
    redaction has to be a processor rather than a convention.
    """
    configure_logging("info")
    structlog.get_logger().info("downloaded", presigned_url="https://s3/x?X-Amz-Signature=deadbeef")
    out = capsys.readouterr().out
    assert "X-Amz-Signature" not in out
    assert "deadbeef" not in out
    assert "[redacted]" in out


def test_the_redaction_list_is_not_empty() -> None:
    assert REDACTED_KEYS, "an empty list would make every redaction test vacuous"


@pytest.mark.parametrize("key", sorted(REDACTED_KEYS))
def test_redacts_every_declared_key(key: str, capsys: pytest.CaptureFixture[str]) -> None:
    """Ten entries with one exercised is nine entries nobody has checked."""
    assert _logged(capsys, **{key: "leaked-value"})[key] == "[redacted]"


@pytest.mark.parametrize("suffix", sorted(REDACTED_SUFFIXES))
def test_redacts_every_declared_suffix(suffix: str, capsys: pytest.CaptureFixture[str]) -> None:
    assert _logged(capsys, **{f"upstream{suffix}": "leaked-value"})[f"upstream{suffix}"] == (
        "[redacted]"
    )


def test_redacts_the_url_names_a_caller_actually_reaches_for(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """`presigned_url` is the one name that was covered and the least likely one.

    Exact equality over the declared keys let every one of these through, and a
    signed URL under any of them is the same credential in the same log.
    """
    payload = _logged(
        capsys,
        download_url="https://s3/x?X-Amz-Signature=deadbeef",
        s3_url="https://s3/y?X-Amz-Signature=deadbeef",
        upload_url="https://s3/z?X-Amz-Signature=deadbeef",
    )
    assert payload["download_url"] == "[redacted]"
    assert payload["s3_url"] == "[redacted]"
    assert payload["upload_url"] == "[redacted]"


def test_leaves_the_keys_a_worker_is_debugged_with_alone(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The cost of over-redacting, asserted rather than assumed.

    `cache_key` is the content-addressed identifier every pipeline log line
    carries, and `url_count` is why the suffix rule is a suffix rule and not a
    substring one. A redaction that swallowed either would be indistinguishable
    from a working one until someone had to debug a stuck job.
    """
    payload = _logged(capsys, cache_key="abc123", url_count="4", key="objects/abc123")
    assert payload["cache_key"] == "abc123"
    assert payload["url_count"] == "4"
    assert payload["key"] == "objects/abc123"
