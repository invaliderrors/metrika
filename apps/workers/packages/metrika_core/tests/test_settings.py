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


def test_declares_exactly_these_six_fields_and_nothing_else() -> None:
    """ADR-0007: a worker must have no database credentials.

    This is a security control, not a style rule — an attacker achieving code
    execution in the mesh parser must land somewhere with nothing to steal.
    A field named for a database is the first way that erodes, and it would
    erode silently because nothing else in the system would break.

    A WHITELIST, and the earlier version of this test was a substring blacklist
    against `("database", "postgres", "db_", "dsn", "sql")`. It fired on the
    obvious `database_url`, which is what made it look sufficient. It was not:
    review built real `BaseSettings` subclasses and found twenty-two field names
    that walked straight through it — `conn_str`, `pg_uri`, `connection_string`,
    `libpq_conninfo`, `jdbc_url`, `primary_db` (the `db_` token needs a trailing
    underscore, so every `*_db` suffix was invisible), `mongo_uri`, `redis_url`,
    `credentials_json` among them.

    Two structural holes as well, and neither is reachable by any blacklist:
    `model_fields` is one level deep, so a field `store: Credentials` whose model
    declares `database_url` reports only `["store"]`; and a field `conn` carrying
    `validation_alias="METRIKA_DATABASE_URL"` names nothing suspicious at all.

    Asserting the exact set closes all three at once and costs one line. It fails
    on ANY addition rather than on the ones somebody thought of — which is the
    point, because the next credential-shaped field will not be called
    `database_url`.
    """
    assert set(WorkerSettings.model_fields) == {
        "temporal_address",
        "temporal_namespace",
        "temporal_task_queue",
        "s3_bucket",
        "s3_endpoint_url",
        "log_level",
    }


def test_rejects_an_unknown_metrika_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    """Typos must fail loudly rather than silently taking a default."""
    monkeypatch.setenv("METRIKA_S3_BUCKET", "b")
    monkeypatch.setenv("METRIKA_TEMPORAL_TASK_QUEUE", "q")
    monkeypatch.setenv("METRIKA_S3_BUKCET", "typo")
    with pytest.raises(ValidationError):
        WorkerSettings()


def test_never_puts_the_value_of_an_unknown_variable_in_the_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The rejection above must not become the leak it exists to prevent.

    `METRIKA_TEST_DATABASE_URL` is not hypothetical — `packages/testing`
    publishes it — and a worker that logs its own startup ValidationError would
    then have written a Postgres password to stdout, from the one module whose
    whole job is that there is nothing there to write. MEASURED: surfacing the
    real value put it in `str(error)` and in `error.json()` at any length.

    The variable's NAME must survive, or the error stops being actionable.
    """
    needle = "s3cr3t-pw"
    monkeypatch.setenv("METRIKA_S3_BUCKET", "b")
    monkeypatch.setenv("METRIKA_TEMPORAL_TASK_QUEUE", "q")
    monkeypatch.setenv("METRIKA_TEST_DATABASE_URL", f"postgresql://u:{needle}@h:5432/d")

    with pytest.raises(ValidationError) as caught:
        WorkerSettings()

    rendered = f"{caught.value}\n{caught.value.json()}"
    assert needle not in rendered
    assert "postgresql" not in rendered
    assert "test_database_url" in rendered, "the name must survive; it is the actionable half"


def test_rejects_a_log_level_the_logger_cannot_use(monkeypatch: pytest.MonkeyPatch) -> None:
    """A bad level is a settings error, not a `KeyError` inside `configure_logging`."""
    monkeypatch.setenv("METRIKA_S3_BUCKET", "b")
    monkeypatch.setenv("METRIKA_TEMPORAL_TASK_QUEUE", "q")
    monkeypatch.setenv("METRIKA_LOG_LEVEL", "verbose")
    with pytest.raises(ValidationError, match="log_level"):
        WorkerSettings()
