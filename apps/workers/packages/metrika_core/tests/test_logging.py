"""`metrika_core.logging`, and the redaction control it is mostly there to run.

The agreement half of this file is Plan 0C Task 4 Step 4: three sinks — Pino in
`apps/api`, structlog here, Sentry's `beforeSend` in `apps/web` — must not drift
apart. **They are DERIVED, not compared.** `RedactedFieldName` lives in
`packages/contracts` and reaches this side as generated code through `pnpm
contracts:emit`, which CI byte-diffs, so `REDACTED_FIELD_NAMES` below is that
list rather than a copy of it and there is no equality to assert: a name removed
on the TypeScript side either fails `packages/contracts/test/redaction.test.ts`
immediately, or fails CI's `contracts` job as a stale generated file, or — if
someone regenerates — fails `test_the_required_names_are_all_present` here.

Equality was the alternative and it is worse, for a reason worth stating: the
three sinks CANNOT behave identically. Pino matches paths and needs one rule per
name per depth; this side matches a flat event dict's keys and so can afford the
word-suffix rule. An equality assertion between three matchers would be
asserting something false. What is shared is the names.
"""

from __future__ import annotations

import json

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


@pytest.mark.parametrize("name", sorted(REDACTED_FIELD_NAMES))
def test_redacts_every_shared_name_in_both_spellings(
    name: str, capsys: pytest.CaptureFixture[str]
) -> None:
    """Seventeen entries with one exercised is sixteen entries nobody has checked.

    BOTH SPELLINGS, because the shared list is camelCase (it is the wire
    spelling, and what Pino's paths are matched against) and a Python caller
    writes snake_case. The whole reason this side matches on WORDS rather than
    on the string is to make those the same name; asserting only the camelCase
    form would leave the mechanism that does the translating untested.
    """
    payload = _logged(capsys, **{name: "leaked-value", _snake(name): "leaked-value"})

    assert payload[name] == "[redacted]"
    assert payload[_snake(name)] == "[redacted]"


@pytest.mark.parametrize("name", sorted(REDACTED_FIELD_NAMES))
def test_redacts_every_shared_name_as_a_word_suffix(
    name: str, capsys: pytest.CaptureFixture[str]
) -> None:
    """A qualified name is the same secret under a longer label.

    `upstream_signed_url` and `upstreamSignedUrl` are what a caller reaches for
    when there are two of something, and exact equality over the list let every
    one of them through — measured, when this module was first written, on
    `download_url`, `s3_url` and `upload_url`.
    """
    payload = _logged(
        capsys, **{f"upstream{name[0].upper()}{name[1:]}": "x", f"upstream_{_snake(name)}": "x"}
    )

    assert payload[f"upstream{name[0].upper()}{name[1:]}"] == "[redacted]"
    assert payload[f"upstream_{_snake(name)}"] == "[redacted]"


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
    """
    payload = _logged(
        capsys,
        cache_key="abc123",
        url_count="4",
        key="objects/abc123",
        curl="curl -sSf https://example",
        token_count="12000",  # noqa: S106  # -- a COUNT of tokens, which is the joke this test is making
        modelId="mv_123",
    )

    assert payload["cache_key"] == "abc123"
    assert payload["url_count"] == "4"
    assert payload["key"] == "objects/abc123"
    assert payload["curl"].startswith("curl ")
    assert payload["token_count"] == "12000"  # noqa: S105  # -- see above; a count, not a token
    assert payload["modelId"] == "mv_123"


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
