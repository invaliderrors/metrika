"""`metrika_core.logging`, and the redaction control it is mostly there to run.

The redaction half of this file is Plan 0C Task 4 Step 4: three sinks — Pino in
`apps/api`, structlog here, Sentry's `beforeSend` in `apps/web` — must not drift
apart. **The LIST is derived**: `RedactedFieldName` lives in
`packages/contracts` and reaches this side as generated code through `pnpm
contracts:emit`, which CI byte-diffs, so `REDACTED_FIELD_NAMES` below is that
list rather than a copy of it. A name removed on the TypeScript side either
fails `packages/contracts/test/redaction.test.ts` immediately, or fails CI's
`contracts` job as a stale generated file, or — if someone regenerates — fails
`test_the_required_names_are_all_present` here.

**The RULE is compared**, and that is a different mechanism in a different file.
`tests/test_redaction_corpus.py` grades this module's matcher against
`packages/contracts/redaction-corpus.json`, because the rule is one algorithm
with three call sites and copies of it drift exactly as copies of the list
would — measured, at 27 of 140 probe names. What this file adds is the
BEHAVIOURAL half the corpus cannot reach: that a real emitted line says
`[redacted]`, through the whole structlog pipeline.
"""

from __future__ import annotations

import json
from collections.abc import Callable

import pytest
import structlog

from metrika_core.logging import REDACTED_FIELD_NAMES, configure_logging, is_redacted_key


def _logged(capsys: pytest.CaptureFixture[str], **event: str) -> dict[str, str]:
    configure_logging("info")
    structlog.get_logger().info("probe", **event)
    parsed: dict[str, str] = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    return parsed


def _snake(name: str) -> str:
    """`signedUrl` → `signed_url`, the spelling a Python caller writes."""
    return "".join(f"_{c.lower()}" if c.isupper() else c for c in name)


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


# ------------------------- the shared list, and its reach ---------------------


def test_the_redaction_list_is_not_empty() -> None:
    assert REDACTED_FIELD_NAMES, "an empty list would make every redaction test vacuous"


def test_the_required_names_are_all_present() -> None:
    """The roster, restated independently of the list it grades.

    Every name here traces to a document — `docs/OBSERVABILITY.md` §3's redaction
    block, or the widening this processor was given after `download_url`,
    `s3_url` and `upload_url` were measured going through untouched. Restating
    them is the point: a test that read `REDACTED_FIELD_NAMES` to decide what
    `REDACTED_FIELD_NAMES` should contain would agree with it by construction
    and stay green while somebody deleted `signedUrl` from
    `packages/contracts/src/redaction.ts` and regenerated.

    Its TypeScript twin is `packages/contracts/test/redaction.test.ts`. Two
    copies of the roster, on the two sides of the boundary, is deliberate — a
    single one could only live on one side, and the side it did not live on is
    the side where the removal happens.
    """
    missing = {
        "authorization",
        "cookie",
        "password",
        "token",
        "secret",
        "webhookSecret",
        "signedUrl",
        "presignedUrl",
        "uploadUrl",
        "downloadUrl",
        "url",
        "providerPayload",
        "paymentPayload",
        "fileName",
        "filename",
        "originalFilename",
        "projectName",
    } - REDACTED_FIELD_NAMES

    assert missing == set(), (
        f"{sorted(missing)} left the shared redaction list. It is defined once, in "
        "packages/contracts/src/redaction.ts, and three log sinks derive from it — removing a "
        "name here removes it from all three at once"
    )


def _upper(name: str) -> str:
    return f"{name[0].upper()}{name[1:]}"


def _acronym(name: str) -> str:
    """`signedUrl` -> `signedURL`: the last word as an acronym."""
    head, _, last = _snake(name).rpartition("_")
    return head.replace("_", "") + last.upper()


# EVERY SPELLING OF ONE FIELD, as a table, and the table is the point.
#
# THE EXHAUSTIVE GATE IS NOT THIS TABLE — it is
# `packages/contracts/redaction-corpus.json`, which `test_redaction_corpus.py`
# grades this module's matcher against and `packages/contracts` grades its own
# against. That is what makes a one-sided change to the RULE go red. This table
# is the BEHAVIOURAL half: it drives the whole structlog pipeline and asserts a
# real emitted line says `[redacted]`, which the corpus (a matcher-level check)
# cannot.
#
# The first version of this file parametrised over the redacted names and
# exercised two shapes: the name itself and an `upstream`-prefixed one. That is
# the positive-assertion trap in the fixture written to close it — a shape
# nobody thought to write down is a shape the suite structurally cannot see, and
# review found six: `presigned_urls`, `signed_urls`, `file_names`, `signedURL2`,
# `presigned_url_v2` and `signedurl` all returned False with the whole gate
# green. A batch presign step logging `presigned_urls=[…]` leaked.
#
# So the shapes are a list rather than two literals, and adding one is a line.
# Each entry says which real caller writes it.
SPELLINGS: tuple[tuple[str, Callable[[str], str]], ...] = (
    # The wire spelling, as `packages/contracts` states it.
    ("camelCase", lambda name: name),
    # What a Python caller actually types.
    ("snake_case", _snake),
    # An environment-variable or constant spelling.
    ("SCREAMING_SNAKE", lambda name: _snake(name).upper()),
    # Two of something, qualified.
    ("prefixed camelCase", lambda name: f"upstream{_upper(name)}"),
    ("prefixed snake_case", lambda name: f"upstream_{_snake(name)}"),
    # A batch helper returning a list. The class review found.
    ("plural camelCase", lambda name: f"{name}s"),
    ("plural snake_case", lambda name: f"{_snake(name)}s"),
    ("prefixed plural", lambda name: f"upstream_{_snake(name)}s"),
    # An ordinal or a version bolted on.
    ("ordinal", lambda name: f"{name}2"),
    ("versioned", lambda name: f"{_snake(name)}_v2"),
    # The boundary removed entirely.
    ("concatenated", lambda name: name.lower()),
    ("concatenated plural", lambda name: f"{name.lower()}s"),
    # The acronym, which is how a developer writes `URL` and `ID`. THE ROW THAT
    # WAS MISSING: this table had no acronym transform at all, so its `ordinal`
    # row produced `signedUrl2` and never the `signedURL2` the finding named —
    # and `signedURLs` tokenised to `("ur", "ls")` and matched nothing, with the
    # whole gate green. The table proves what it contains, not what it omits.
    ("acronym", _acronym),
    ("acronym plural", lambda name: f"{_acronym(name)}s"),
    ("acronym ordinal", lambda name: f"{_acronym(name)}2"),
)


@pytest.mark.parametrize(("label", "spell"), SPELLINGS, ids=[label for label, _ in SPELLINGS])
@pytest.mark.parametrize("name", sorted(REDACTED_FIELD_NAMES))
def test_redacts_every_shared_name_in_every_spelling(
    name: str, label: str, spell: Callable[[str], str], capsys: pytest.CaptureFixture[str]
) -> None:
    """Seventeen names by twelve spellings, because one of each is not coverage.

    The shared list is camelCase — it is the wire spelling, and what Pino's
    paths are matched against — and a Python caller writes snake_case. The whole
    reason this side matches on WORDS rather than on the string is to make those
    the same field, so asserting only the camelCase form would leave the
    mechanism that does the translating untested, and asserting only two forms
    is what let the plural through.
    """
    key = spell(name)

    assert _logged(capsys, **{key: "leaked-value"})[key] == "[redacted]", (
        f"{key} is {name} spelled as {label}, and it reached the log line"
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
        objectURL="https://s3/w?X-Amz-Signature=deadbeef",
    )

    assert payload["download_url"] == "[redacted]"
    assert payload["s3_url"] == "[redacted]"
    assert payload["upload_url"] == "[redacted]"
    assert payload["objectURL"] == "[redacted]"


# ------------------------------ the cost, asserted ----------------------------


def test_leaves_the_keys_a_worker_is_debugged_with_alone(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The cost of over-redacting, asserted rather than assumed.

    `cache_key` is the content-addressed identifier every pipeline log line
    carries, and `url_count` is why the rule is a WORD-suffix rule and not a
    substring one. A redaction that swallowed either would be indistinguishable
    from a working one until someone had to debug a stuck job.

    `curl` is the case that separates a word suffix from a character suffix, and
    `token_count` is the case that shows the suffix has to be at the END: both
    would be redacted by an `in`-style match and neither is a secret.

    **The plural forms are here as well as in the redaction table above, and
    that is the pairing that matters.** Teaching the matcher to strip a trailing
    `s` is exactly the kind of widening that quietly takes `cache_keys` and
    `url_counts` with it, so both directions moved in the same commit.
    `requestId`, `traceId` and `attempt` are here because the correlation
    processors put them on every activity line — a redaction that swallowed one
    would make the chain this module ships alongside worthless.
    """
    payload = _logged(
        capsys,
        cache_key="abc123",
        cache_keys="abc123,def456",
        url_count="4",
        url_counts="4",
        key="objects/abc123",
        keys="objects/abc123",
        curl="curl -sSf https://example",
        token_count="12000",  # noqa: S106  # -- a COUNT of tokens, which is the joke this test is making
        modelId="mv_123",
        requestId="req_123",
        traceId="4bf92f00",
        attempt="2",
        task_queue="geometry-small",
        md5="d41d8cd9",
        mysignedurl="https://example",
    )

    assert payload["cache_key"] == "abc123"
    assert payload["cache_keys"] == "abc123,def456"
    assert payload["url_count"] == "4"
    assert payload["url_counts"] == "4"
    assert payload["key"] == "objects/abc123"
    assert payload["keys"] == "objects/abc123"
    assert payload["curl"].startswith("curl ")
    assert payload["token_count"] == "12000"  # noqa: S105  # -- see above; a count, not a token
    assert payload["modelId"] == "mv_123"
    assert payload["requestId"] == "req_123"
    assert payload["traceId"] == "4bf92f00"
    assert payload["attempt"] == "2"
    assert payload["task_queue"] == "geometry-small"
    assert payload["md5"] == "d41d8cd9"
    # THE NAMED LIMIT, asserted so it is a decision rather than a surprise. An
    # invented concatenation that is not itself a listed name is not reached,
    # because the only rule that would reach it — "ends with these letters" —
    # also takes `curl` two lines up. `my_signed_url` and `mySignedUrl` ARE
    # reached; `is_redacted_key`'s docstring says so.
    assert payload["mysignedurl"] == "https://example"


def test_a_value_a_processor_injects_is_still_subject_to_redaction(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The ordering property, asserted through the chain rather than about it.

    `_redact` sits after every processor that can ADD a key, so that nothing
    injected can bypass it. Bound context variables are the reachable case
    today: `merge_contextvars` occupies the same position as the correlation
    processors, and a value it merges in must be censored exactly as a value the
    caller passed.

    Not asserted with a correlation field, because none is on the redaction list
    — `test_the_correlation_fields_are_not_redacted_by_their_own_names` is what
    keeps that true. The day one is, this is the test that already covers it.
    """
    configure_logging("info")
    structlog.contextvars.bind_contextvars(presigned_url="https://s3/x?X-Amz-Signature=deadbeef")
    try:
        structlog.get_logger().info("bound")
    finally:
        structlog.contextvars.clear_contextvars()

    out = capsys.readouterr().out
    assert "deadbeef" not in out
    assert '"presigned_url": "[redacted]"' in out


def test_redaction_runs_after_every_processor_that_can_add_a_key() -> None:
    """`configure_logging`'s docstring calls this order load-bearing. This is the

    assertion that makes that true.

    MEASURED before this test existed: moving `_redact` above `bind_correlation`
    broke nothing in the suite, so the docstring was a claim with no gate under
    it. Structural rather than behavioural for a stated reason — no field the
    correlation processors emit is on the redaction list, so today the reorder
    has no observable output difference. The one above covers the behaviour for
    the processor position; this covers the two that share it.
    """
    configure_logging("info")
    names = [
        getattr(processor, "__name__", type(processor).__name__)
        for processor in structlog.get_config()["processors"]
    ]

    assert {"bind_correlation", "bind_activity_context", "_redact", "JSONRenderer"} <= set(names), (
        f"the processor chain is not the one this test grades: {names}"
    )
    for injector in ("merge_contextvars", "bind_correlation", "bind_activity_context"):
        assert names.index(injector) < names.index("_redact"), (
            f"{injector} adds keys AFTER redaction has run, so anything it adds bypasses the "
            "redaction list entirely"
        )
    assert names.index("_redact") < names.index("JSONRenderer"), (
        "after the renderer the event is a string and there are no keys left to match"
    )


def test_the_correlation_fields_are_not_redacted_by_their_own_names() -> None:
    """The two lists have to coexist on one line, and nothing checks that but this.

    `requestId` and `traceId` are put on every activity's log line by
    `metrika_core.telemetry`, and they run BEFORE the redaction processor
    deliberately, so a name that appeared on both lists would produce a
    correlated log line whose correlation is `[redacted]`. Asserted on the
    matcher rather than through a log line, because this is a property of the
    two lists rather than of any one event.
    """
    for field in ("requestId", "traceId", "spanId", "organizationId", "workflowId", "modelId"):
        assert not is_redacted_key(field), f"{field} is on the redaction list and must not be"
