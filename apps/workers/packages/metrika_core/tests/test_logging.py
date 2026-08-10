from __future__ import annotations

import json

import pytest
import structlog

from metrika_core.logging import REDACTED_KEYS, configure_logging


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
