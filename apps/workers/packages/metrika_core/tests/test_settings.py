from __future__ import annotations

import pytest
from pydantic import ValidationError

from metrika_core.settings import WorkerSettings


def test_reads_the_worker_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("METRIKA_WORKER_S3_BUCKET", "metrika-models")
    monkeypatch.setenv("METRIKA_WORKER_TEMPORAL_TASK_QUEUE", "geometry-small")
    settings = WorkerSettings()
    assert settings.s3_bucket == "metrika-models"
    assert settings.temporal_task_queue == "geometry-small"


def test_defaults_the_temporal_address(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("METRIKA_WORKER_S3_BUCKET", "b")
    monkeypatch.setenv("METRIKA_WORKER_TEMPORAL_TASK_QUEUE", "q")
    assert WorkerSettings().temporal_address == "localhost:7233"


def test_rejects_a_missing_bucket_and_names_it(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("METRIKA_WORKER_S3_BUCKET", raising=False)
    monkeypatch.setenv("METRIKA_WORKER_TEMPORAL_TASK_QUEUE", "q")
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
    `validation_alias="METRIKA_WORKER_DATABASE_URL"` names nothing suspicious at all.

    Asserting the exact set costs one line and fails on ANY addition rather than
    on the ones somebody thought of, which is the point: the next
    credential-shaped field will not be called `database_url`. It does NOT close
    all three by itself, and the earlier version of this docstring claimed it
    did. What it actually covers, measured on this tree:

      the twenty-two names   CLOSED here. Any new field, whatever it is called,
                             changes this set.
      a NEW nested model     CLOSED here, for the same reason -- `store:
                             Credentials` adds `"store"` to the set.
      an EXISTING field name
      whose TYPE changes     NOT SEEN HERE. `s3_endpoint_url: _Credentials |
                             None`, where `_Credentials` declares `database_url`,
                             leaves `set(model_fields)` byte-identical and every
                             test in this file green -- measured, 8 passed.
                             `mypy --strict` is what stops it, at the CONSUMER:
                             `storage.py:92`, `Argument 1 to "build_s3_client"
                             has incompatible type "_Credentials | None"`. Which
                             also marks the limit of the pair -- a field nothing
                             reads would change type unobserved by both.
      the alias              CLOSED, but by `_surface_unknown_prefixed_variables`
                             and `extra="forbid"`, not by this assertion. Put
                             `validation_alias="METRIKA_WORKER_DATABASE_URL"` on
                             an existing field and this set does not move;
                             MEASURED, `WorkerSettings()` then raises
                             `extra_forbidden` naming `database_url`, with
                             `input_value='<value withheld>'`.

    So three controls hold this, not one. Deleting any of them reopens a
    different third of it.
    """
    assert set(WorkerSettings.model_fields) == {
        "temporal_address",
        "temporal_namespace",
        "temporal_task_queue",
        "s3_bucket",
        "s3_endpoint_url",
        "log_level",
    }


def test_rejects_an_unknown_worker_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    """Typos must fail loudly rather than silently taking a default."""
    monkeypatch.setenv("METRIKA_WORKER_S3_BUCKET", "b")
    monkeypatch.setenv("METRIKA_WORKER_TEMPORAL_TASK_QUEUE", "q")
    monkeypatch.setenv("METRIKA_WORKER_S3_BUKCET", "typo")
    with pytest.raises(ValidationError, match="s3_bukcet"):
        WorkerSettings()


def test_ignores_a_metrika_variable_that_belongs_to_something_else(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The strict policy is right; claiming the whole `METRIKA_` namespace was not.

    `METRIKA_TEST_DATABASE_URL` is not hypothetical — `packages/testing/src/database.ts`
    publishes it, and any developer or CI step that has run the Node integration
    harness in the same shell has it exported. MEASURED under the old
    `METRIKA_` prefix: `WorkerSettings()` did not construct AT ALL, because a
    strict claim over a shared namespace turns another team's variable into this
    worker's startup failure.

    Narrowing the claim to `METRIKA_WORKER_` is what makes the strictness safe.
    The worker now owns its namespace completely, so "an unrecognised variable
    in it is an error" is a statement about our own configuration rather than
    about the machine's.
    """
    monkeypatch.setenv("METRIKA_WORKER_S3_BUCKET", "metrika-models")
    monkeypatch.setenv("METRIKA_WORKER_TEMPORAL_TASK_QUEUE", "geometry-small")
    monkeypatch.setenv("METRIKA_TEST_DATABASE_URL", "postgresql://u:s3cr3t-pw@h:5432/d")
    monkeypatch.setenv("METRIKA_TEST_DATABASE_ADMIN_URL", "postgresql://a:s3cr3t-pw@h:5432/d")
    monkeypatch.setenv("METRIKA_SLICER", "real")

    settings = WorkerSettings()

    assert settings.s3_bucket == "metrika-models"


def test_never_puts_the_value_of_an_unknown_variable_in_the_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The rejection above must not become the leak it exists to prevent.

    A worker that logged its own startup ValidationError would have written the
    value to stdout, from the one module whose whole job is that there is
    nothing there to write. MEASURED: surfacing the real value put it in
    `str(error)` and in `error.json()` at any length.

    Narrowing the prefix did not make this redundant. It removed the variables
    somebody ELSE sets from the walk; a credential is just as easy to put in a
    variable of ours — `METRIKA_WORKER_DATABASE_URL` is precisely what someone
    reaches for on the day they decide the worker needs a database, which is the
    day ADR-0007 is being broken and the error must not help.

    The variable's NAME must survive, or the error stops being actionable.
    """
    needle = "s3cr3t-pw"
    monkeypatch.setenv("METRIKA_WORKER_S3_BUCKET", "b")
    monkeypatch.setenv("METRIKA_WORKER_TEMPORAL_TASK_QUEUE", "q")
    monkeypatch.setenv("METRIKA_WORKER_DATABASE_URL", f"postgresql://u:{needle}@h:5432/d")

    with pytest.raises(ValidationError) as caught:
        WorkerSettings()

    rendered = f"{caught.value}\n{caught.value.json()}"
    assert needle not in rendered
    assert "postgresql" not in rendered
    assert "database_url" in rendered, "the name must survive; it is the actionable half"


def test_rejects_a_log_level_the_logger_cannot_use(monkeypatch: pytest.MonkeyPatch) -> None:
    """A bad level is a settings error, not a `KeyError` inside `configure_logging`."""
    monkeypatch.setenv("METRIKA_WORKER_S3_BUCKET", "b")
    monkeypatch.setenv("METRIKA_WORKER_TEMPORAL_TASK_QUEUE", "q")
    monkeypatch.setenv("METRIKA_WORKER_LOG_LEVEL", "verbose")
    with pytest.raises(ValidationError, match="log_level"):
        WorkerSettings()
