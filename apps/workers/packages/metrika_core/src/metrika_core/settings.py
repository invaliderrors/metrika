from __future__ import annotations

import os
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# What `_surface_unknown_prefixed_variables` puts in an unclaimed variable's
# place. Never the real value.
#
# MEASURED, and this module is the worst possible place for it: surfacing the
# value meant `str(ValidationError)` and `ValidationError.json()` both rendered
# it as `input_value=...`, so a credential-bearing variable in this namespace put
# a password into an exception a worker would log at startup. The NAME is the
# actionable half of that error and it is still there, in the error's location.
_VALUE_WITHHELD = "<value withheld>"


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

    **`METRIKA_WORKER_`, not `METRIKA_`, and the two halves of that decision are
    separate.** The strict policy — an unrecognised variable in our namespace is
    an error — is right and stays. What was wrong was the SCOPE of the claim.
    `METRIKA_` is a company-wide prefix that Node-side test infrastructure
    already uses: `packages/testing/src/database.ts` publishes
    `METRIKA_TEST_DATABASE_URL`, and MEASURED with it exported,
    `WorkerSettings()` refused to construct at all. A strict claim over a shared
    namespace means this worker breaks on somebody else's variable, which is not
    its business. Narrowing the claim is what makes the strictness safe, because
    the worker then owns its namespace completely. `packages/testing` was there
    first and is Node-side; renaming it would have been the larger change.

    AWS credentials and region are deliberately absent too, and for a different
    reason: they come from the standard provider chain (an IRSA/instance role in
    production, `AWS_*` in local development), so there is no field here that
    could hold one and no code path that could log one. The second half of that
    sentence was briefly untrue — see `_VALUE_WITHHELD`.
    """

    model_config = SettingsConfigDict(env_prefix="METRIKA_WORKER_", extra="forbid")

    temporal_address: str = "localhost:7233"
    temporal_namespace: str = "default"
    temporal_task_queue: str
    s3_bucket: str
    s3_endpoint_url: str | None = None
    # A `Literal`, not `str`: `configure_logging` looks the level up in
    # `logging.getLevelNamesMapping()`, so `METRIKA_WORKER_LOG_LEVEL=verbose` used to
    # raise `KeyError` from inside the logging setup — an unhandled crash in the
    # first thing a worker does, reported as a bug in the wrong module. It is a
    # `ValidationError` naming `log_level` now, alongside every other
    # misconfiguration. Lowercase spellings only, so there is one form on the
    # wire; `configure_logging` upper-cases.
    log_level: Literal["debug", "info", "warning", "error", "critical"] = "info"

    @model_validator(mode="before")
    @classmethod
    def _surface_unknown_prefixed_variables(cls, data: object) -> object:
        """Put `METRIKA_WORKER_*` variables no field claims in front of `extra`.

        MEASURED on pydantic-settings 2.15.0, and it is the opposite of what
        `extra="forbid"` reads like it does: with `METRIKA_WORKER_S3_BUKCET=typo`
        set, `WorkerSettings()` succeeds and `s3_bucket` silently takes whatever
        else it can find. `EnvSettingsSource.__call__` iterates over
        `settings_cls.model_fields` and looks each one up by name, so an
        environment variable no field claims is never read, never becomes an
        extra, and `extra` never sees it. On its own, `forbid` here only guards
        keyword arguments and `.env` entries.

        This closes that gap and nothing more. It SURFACES the unclaimed names;
        `extra` is still what decides the policy, which is why flipping it to
        `"ignore"` makes `test_rejects_an_unknown_worker_variable` fail. A
        validator that raised by itself would leave that setting decorative and
        the test passing for the wrong reason.

        Reading the prefix from `model_config` rather than restating it is what
        keeps this scoped to the worker's own namespace. It walks every variable
        it is shown, so a claim over a namespace somebody else writes to would
        make another team's variable this worker's startup failure — which is
        exactly what `METRIKA_` did, and why the prefix is now
        `METRIKA_WORKER_`.

        Why it matters more here than in most services: every field on this class
        either has a safe default or is required, so a typo'd
        `METRIKA_WORKER_TEMPORAL_TASK_QUEUE` does not crash — it starts a worker
        polling a queue nobody publishes to, which looks exactly like an idle
        system.
        """
        if not isinstance(data, dict):
            return data

        prefix = cls.model_config.get("env_prefix", "")
        if not prefix:
            return data

        claimed = set(cls.model_fields)
        # The NAME, never `os.environ[name]` — see `_VALUE_WITHHELD`. `extra`
        # rejects on the key, so the sentinel loses nothing: the resulting
        # `extra_forbidden` error still names the offending variable, which is
        # the only part a reader can act on.
        surfaced = {
            name[len(prefix) :].lower(): _VALUE_WITHHELD
            for name in os.environ
            if name.upper().startswith(prefix.upper())
            and name[len(prefix) :].lower() not in claimed
        }
        # `data` last: an explicit keyword argument outranks the environment,
        # which is the precedence pydantic-settings already uses.
        return {**surfaced, **data}
