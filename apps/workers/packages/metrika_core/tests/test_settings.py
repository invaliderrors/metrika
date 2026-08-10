from __future__ import annotations

import pytest
from pydantic import ValidationError

from metrika_core.settings import WorkerSettings


def test_reads_the_metrika_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("METRIKA_S3_BUCKET", "metrika-models")
    monkeypatch.setenv("METRIKA_TEMPORAL_TASK_QUEUE", "geometry-small")
    settings = WorkerSettings()
    assert settings.s3_bucket == "metrika-models"
    assert settings.temporal_task_queue == "geometry-small"


def test_defaults_the_temporal_address(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("METRIKA_S3_BUCKET", "b")
    monkeypatch.setenv("METRIKA_TEMPORAL_TASK_QUEUE", "q")
    assert WorkerSettings().temporal_address == "localhost:7233"


def test_rejects_a_missing_bucket_and_names_it(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("METRIKA_S3_BUCKET", raising=False)
    monkeypatch.setenv("METRIKA_TEMPORAL_TASK_QUEUE", "q")
    with pytest.raises(ValidationError, match="s3_bucket"):
        WorkerSettings()


def test_has_no_database_field_at_all() -> None:
    """ADR-0007: a worker must have no database credentials.

    This is a security control, not a style rule — an attacker achieving code
    execution in the mesh parser must land somewhere with nothing to steal.
    A field named for a database is the first way that erodes, and it would
    erode silently because nothing else in the system would break.
    """
    forbidden = ("database", "postgres", "db_", "dsn", "sql")
    for name in WorkerSettings.model_fields:
        assert not any(token in name.lower() for token in forbidden), (
            f"WorkerSettings.{name} looks like database configuration; see ADR-0007"
        )


def test_rejects_an_unknown_metrika_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    """Typos must fail loudly rather than silently taking a default."""
    monkeypatch.setenv("METRIKA_S3_BUCKET", "b")
    monkeypatch.setenv("METRIKA_TEMPORAL_TASK_QUEUE", "q")
    monkeypatch.setenv("METRIKA_S3_BUKCET", "typo")
    with pytest.raises(ValidationError):
        WorkerSettings()
