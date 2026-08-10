from __future__ import annotations

import os

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class WorkerSettings(BaseSettings):  # type: ignore[explicit-any]  # -- see the note below
    """Configuration for both workers.

    The suppression on the class line is not about anything written here.
    MEASURED on mypy 2.3.0: `disallow_any_explicit` reports `explicit-any` on the
    class line of every pydantic model, `class S(BaseModel): pass` included — the
    `Any` lives in the `__init__` mypy synthesises from pydantic's
    `dataclass_transform`, and there is nothing in this file to remove. It is
    written inline, with a code and a justification, rather than as a per-module
    override so that `warn_unused_ignores` deletes it for us when mypy stops
    attributing a synthesised member to our source.

    (Spelling the directive out in prose here would trip CI's own
    unjustified-suppression grep, which scans line content and cannot tell a
    docstring from a directive. Worth knowing before writing the next one.)

    There is deliberately no database field of any kind. Workers receive
    fully-formed inputs as Temporal activity arguments and read and write S3
    under a prefix-scoped role; the API is the only writer to Postgres. See
    ADR-0007, and `tests/test_settings.py` for the assertion that keeps it
    true.

    `extra="forbid"` so a typo'd variable fails at startup rather than
    silently taking a default — the same reason `apps/api` parses its
    environment with Zod instead of reading `process.env` directly. It needs the
    validator below to reach an environment variable at all; see there.

    AWS credentials and region are deliberately absent too, and for a different
    reason: they come from the standard provider chain (an IRSA/instance role in
    production, `AWS_*` in local development), so there is no field here that
    could hold one and no code path that could log one.
    """

    model_config = SettingsConfigDict(env_prefix="METRIKA_", extra="forbid")

    temporal_address: str = "localhost:7233"
    temporal_namespace: str = "default"
    temporal_task_queue: str
    s3_bucket: str
    s3_endpoint_url: str | None = None
    log_level: str = "info"

    @model_validator(mode="before")
    @classmethod
    def _surface_unknown_prefixed_variables(cls, data: object) -> object:
        """Put `METRIKA_*` variables no field claims in front of `extra`.

        MEASURED on pydantic-settings 2.15.0, and it is the opposite of what
        `extra="forbid"` reads like it does: with `METRIKA_S3_BUKCET=typo` set,
        `WorkerSettings()` succeeds and `s3_bucket` silently takes whatever else
        it can find. `EnvSettingsSource.__call__` iterates over
        `settings_cls.model_fields` and looks each one up by name, so an
        environment variable no field claims is never read, never becomes an
        extra, and `extra` never sees it. On its own, `forbid` here only guards
        keyword arguments and `.env` entries.

        This closes that gap and nothing more. It SURFACES the unclaimed names;
        `extra` is still what decides the policy, which is why flipping it to
        `"ignore"` makes `test_rejects_an_unknown_metrika_variable` fail. A
        validator that raised by itself would leave that setting decorative and
        the test passing for the wrong reason.

        Why it matters more here than in most services: every field on this class
        either has a safe default or is required, so a typo'd
        `METRIKA_TEMPORAL_TASK_QUEUE` does not crash — it starts a worker
        polling a queue nobody publishes to, which looks exactly like an idle
        system.
        """
        if not isinstance(data, dict):
            return data

        prefix = cls.model_config.get("env_prefix", "")
        if not prefix:
            return data

        claimed = set(cls.model_fields)
        surfaced = {
            name[len(prefix) :].lower(): value
            for name, value in os.environ.items()
            if name.upper().startswith(prefix.upper())
            and name[len(prefix) :].lower() not in claimed
        }
        # `data` last: an explicit keyword argument outranks the environment,
        # which is the precedence pydantic-settings already uses.
        return {**surfaced, **data}
