"""The redaction rule AND this runtime's sink, graded against the shared corpus.

**Two things are graded here, and the second was missing.** The rule — is this
key name sensitive? — is graded against `is_redacted_key` directly, which is what
keeps this port in agreement with `packages/contracts`. That is a MATCHER-level
check, and a matcher is not a sink: `_redact` could stop being reached, stop
recursing, or stop being called for some class of key, and every assertion below
the first heading would stay green because none of them emits a log line.

The other two sinks were already graded through their own traversal — `apps/api`
runs all 956 rows through the real `createLogger` in six binding shapes, and
`apps/web` runs them through `redactSentryEvent` nested inside an event — and
this side ran the corpus through the matcher only. `tests/test_logging.py` covers
the behavioural half as seventeen names by fifteen spellings, which is a product
rather than a sum but a SMALLER product than the corpus: it has no negative
roster to speak of, so `curl`, `cache_keys`, `HTTPStatus`, `rev2` and
`mysignedurl` were never asserted to survive a real emitted line. The second
heading below closes that, on the same 956 rows the other two sinks answer for.

`RedactedFieldName` made the redaction KEY LIST one source: it is declared in
`packages/contracts` and reaches this side as generated code. The matching RULE
was not. It was two hand-written implementations of one algorithm — this one and
`apps/web`'s — and review measured **27 of 140 probe names disagreeing between
them**, including `signedURLs`: an acronym plural that one side redacted and the
other let through, in exactly the class a round of review had just been raised to
close. Nothing compared the two, so nothing could have found it.

**Each side agreeing with its own fixtures is not the property that was
missing.** Both suites were green throughout. What was missing is an assertion
that the two rules agree with EACH OTHER, and that is what this file is:
`packages/contracts/redaction-corpus.json` is emitted from
`redactionCorpus()` by `pnpm contracts:emit`, CI diffs it,
`packages/contracts/test/redaction.test.ts` asserts the TypeScript matcher
reproduces every row, and this asserts the Python matcher does. Change one rule
without the other and one of the two goes red.

**The verdicts in the corpus are DECLARED, not computed.** A corpus produced by
running a matcher would record whatever that matcher does, so a wrong rule would
generate a corpus the other side could agree with perfectly — two
implementations in exact agreement and both wrong. It is built instead from two
tables in `redaction.ts`: every spelling of every name that must be caught, and a
roster of names that must stay readable. So it grades correctness and agreement
at the same time.

TURBO: this file reads a path outside `apps/workers`, so `apps/workers/turbo.json`
declares `$TURBO_ROOT$/packages/contracts/redaction-corpus.json` as an input.
Without that entry turbo hashes only this package's files and replays a green log
while the corpus has moved underneath — which is the only thing the corpus can do
wrong. The invalidation was measured, not assumed; the comment there has the
hashes.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import structlog

from metrika_core.logging import configure_logging, is_redacted_key

CORPUS = Path(__file__).resolve().parents[5] / "packages" / "contracts" / "redaction-corpus.json"


def _corpus() -> list[dict[str, object]]:
    """The rows, or none at all if the file is missing.

    `CASES` is built at IMPORT time, so a `FileNotFoundError` here would be a
    COLLECTION error — pytest would report a traceback from this module and
    `test_the_corpus_exists_and_is_not_vacuous`, which exists to say what to run,
    would never execute. Returning an empty list keeps that guidance reachable.
    """
    if not CORPUS.exists():
        return []
    rows: object = json.loads(CORPUS.read_text(encoding="utf-8"))
    assert isinstance(rows, list)
    return [row for row in rows if isinstance(row, dict)]


def _key(row: dict[str, object]) -> str:
    key = row["key"]
    assert isinstance(key, str)
    return key


def _redacted(row: dict[str, object]) -> bool:
    redacted = row["redacted"]
    assert isinstance(redacted, bool)
    return redacted


CASES = [(_key(row), _redacted(row)) for row in _corpus()]

# ─────────────────────────── the rule ────────────────────────────


def test_the_corpus_exists_and_is_not_vacuous() -> None:
    """Non-vacuity in BOTH directions, before anything is built on it.

    A corpus of only positives would be satisfied by a matcher that redacts
    every key; a corpus of only negatives by one that redacts nothing. Either
    would be a green agreement test over a broken control.
    """
    assert CORPUS.exists(), (
        f"{CORPUS} is missing — run `pnpm contracts:emit`, which writes it from "
        "packages/contracts/src/redaction.ts"
    )

    redacted = [key for key, verdict in CASES if verdict]
    survivors = [key for key, verdict in CASES if not verdict]

    assert len(redacted) > 100, redacted
    assert len(survivors) > 20, survivors


def test_the_corpus_covers_the_class_review_found() -> None:
    """The corpus is generated, so this asserts the GENERATOR still generates it.

    Six spellings went through untouched before the rule was widened
    (`presigned_urls`, `signedURL2`, `signedurl` and their neighbours), and
    `signedURLs` went through after it. A table-driven corpus makes those
    mechanical — but only while the table still contains the rows, and a
    generated file is exactly the kind that quietly loses one.
    """
    keys = {key for key, _ in CASES}

    for required in (
        "signedURLs",
        "presigned_urls",
        "signedURL2",
        "signedurl",
        "presigned_url_v2",
        "file_names",
        "PRESIGNED_URL",
        "upstream_signed_url",
    ):
        assert required in keys, f"{required} is not in the corpus any more"


@pytest.mark.parametrize(("key", "redacted"), CASES, ids=[key or "<empty>" for key, _ in CASES])
def test_this_matcher_agrees_with_the_shared_corpus(key: str, redacted: bool) -> None:
    """One case per row, so a failure names the spelling rather than a count."""
    assert is_redacted_key(key) is redacted, (
        f"{key!r}: this matcher says {is_redacted_key(key)}, the shared corpus says {redacted}. "
        "The rule lives in packages/contracts/src/redaction.ts and this is its Python port — "
        "if the rule changed, port the change; if it did not, this port has drifted"
    )


# ─────────────────────────── the SINK ────────────────────────────
#
# Everything above grades `is_redacted_key`. Nothing above emits a log line, so
# every assertion above stays green if `_redact` is removed from the processor
# chain, stops being reached, or stops being called for some class of key. The
# rule being right is not the property this control ships.

_SENTINEL = "leaked-value-9c4e2a"

# The token every sink writes. `packages/contracts/test/censor-agreement.test.ts`
# is what keeps this side and `REDACTION_CENSOR` the same string; this constant is
# spelled out rather than imported from `metrika_core.logging` because a fixture
# that read the value it grades would agree with it by construction.
_CENSOR = "[REDACTED]"

# The two keys structlog's own processors write, so a caller's value cannot
# round-trip through them. Both are still graded on the VERDICT — a censored one
# reads `[REDACTED]` — and only the value comparison is dropped:
#
#   * `level` is set by `add_log_level`, which runs BEFORE `_redact`. The verdict
#     assertion is real: were `level` on the list, the emitted value would be the
#     censor.
#   * `timestamp` is set by `TimeStamper`, which runs AFTER `_redact` and
#     overwrites whatever it did. THE VERDICT ASSERTION IS VACUOUS FOR THIS ONE
#     ROW, and it is named here rather than silently counted as coverage.
_PIPELINE_OWNED = frozenset({"level", "timestamp"})

# `BoundLogger.info(event, **kw)` — a kwarg spelled `event` is a TypeError raised
# before any processor runs, so this row cannot be driven through the sink the
# way the other 955 are. It is graded instead by
# `test_the_message_field_is_not_censored`, which is the only shape it has.
_UNREACHABLE_AS_A_KWARG = frozenset({"event"})

SINK_CASES = [(key, redacted) for key, redacted in CASES if key not in _UNREACHABLE_AS_A_KWARG]


def test_the_dropped_cells_are_still_in_the_corpus() -> None:
    """A declared exclusion has to keep naming something, or it stops being one.

    Both sets above are exclusions from a GENERATED list. If `event` left the
    corpus, `_UNREACHABLE_AS_A_KWARG` would silently exclude nothing and the
    comment explaining it would describe a row that no longer exists — which is
    how a declared gap turns back into an undeclared one.
    """
    keys = {key for key, _ in CASES}

    for dropped in _UNREACHABLE_AS_A_KWARG | _PIPELINE_OWNED:
        assert dropped in keys, (
            f"{dropped!r} is declared as a dropped or partial cell of the sink grading below, "
            "and it is not in the corpus any more — remove the declaration or restore the row"
        )

    assert len(SINK_CASES) == len(CASES) - len(_UNREACHABLE_AS_A_KWARG)


@pytest.mark.parametrize(
    ("key", "redacted"), SINK_CASES, ids=[key or "<empty>" for key, _ in SINK_CASES]
)
def test_the_sink_reproduces_every_corpus_verdict(
    key: str, redacted: bool, capsys: pytest.CaptureFixture[str]
) -> None:
    """The corpus through the REAL pipeline, which is what the other two sinks do.

    `apps/api` runs all 956 rows through the real `createLogger` in six binding
    shapes; `apps/web` runs them through `redactSentryEvent` nested inside an
    event. This runs them through `configure_logging` and reads the emitted JSON
    — so a `_redact` that is removed, reordered after the renderer, or narrowed
    to exact equality is red here, whatever the matcher still answers.

    BOTH VERDICTS, and the negative half is the half `tests/test_logging.py`
    could not reach: its behavioural table has fifteen survivors chosen by hand,
    and the corpus has forty-odd including `curl`, `cache_keys`, `HTTPStatus`,
    `rev2` and `mysignedurl`. A control that censors those costs real
    debuggability, and nothing emitted a line to find out.

    The absence assertion is on the RAW line rather than on the parsed value: a
    traversal that censored the key while leaving the value somewhere else in the
    record would satisfy `payload[key] == "[REDACTED]"` and still have written
    the secret down.
    """
    configure_logging("info")
    structlog.get_logger().info("probe", **{key: _SENTINEL})
    line = capsys.readouterr().out.strip().splitlines()[-1]
    payload = json.loads(line)

    assert key in payload, f"{key!r} did not reach the emitted line at all"

    if redacted:
        assert payload[key] == _CENSOR, (
            f"{key!r} is declared redacted by the shared corpus and this sink emitted "
            f"{payload[key]!r}"
        )
        assert _SENTINEL not in line, (
            f"{key!r} was censored in place and the value survived elsewhere: {line}"
        )
        return

    assert payload[key] != _CENSOR, (
        f"{key!r} is declared readable by the shared corpus and this sink censored it — "
        "over-redaction costs the debuggability the negative roster exists to protect"
    )
    if key not in _PIPELINE_OWNED:
        assert payload[key] == _SENTINEL, f"{key!r} reached the line as {payload[key]!r}"


def test_the_traversal_is_one_level_deep_which_is_the_declared_limit(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The one thing this sink does NOT reach, asserted so it is a decision.

    `_redact` iterates the event dict's own keys and stops. A redacted name
    nested inside a value — a dict, or a dict inside a list — is not visited, and
    goes out verbatim. MEASURED, both shapes below, through the real pipeline.

    The other two sinks do not share this limit: `apps/api`'s walk rebuilds the
    whole object graph and `apps/web`'s cleans an arbitrary event, both to a
    declared depth. So `docs/OBSERVABILITY.md` §3's "one list, every sink" is
    true of the LIST and of the RULE, and this is where it stops being true of
    the reach.

    Closing it is a traversal, not a line — the sibling walks carry cycle
    handling, self-serialising values, per-entry fail-closed boundaries and a
    depth cap because each of those was a measured defect. This test is here so
    that whoever writes it starts from a red assertion rather than from a
    surprise, and so that a caller reading `docs/OBSERVABILITY.md` knows to put
    the sensitive field at the top level where the control can see it.
    """
    configure_logging("info")
    structlog.get_logger().info(
        "probe",
        payload={"password": _SENTINEL},
        items=[{"signed_url": _SENTINEL}],
    )
    line = capsys.readouterr().out.strip().splitlines()[-1]
    payload = json.loads(line)

    assert payload["payload"] == {"password": _SENTINEL}
    assert payload["items"] == [{"signed_url": _SENTINEL}]


def test_every_exc_info_shape_keeps_the_exception_message_off_the_wire(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """`exc_info` is not a field NAME, so the shared list cannot reach it.

    FOUR shapes, and this file's earlier characterisation of them — "diagnostic
    loss rather than exposure, the traceback is not written down anywhere" — was
    true of two and false of the other two. `JSONRenderer` renders an unknown
    value with `default=repr`, so a tuple from `sys.exc_info()` or a bare
    exception instance puts the whole message on the wire, DSN included. Both are
    ordinary Python that any caller would write, and neither is exotic enough to
    be called a corner.

    All four are asserted here rather than the two that were broken, because the
    boolean shapes are what make the censor's exemption meaningful: `"exc_info":
    true` has to keep saying an exception was attached, or closing the leak would
    have quietly removed the only signal this side emits about exceptions at all.

    What is still owed is the RENDERING — `apps/api` keeps an exception's frames
    and censors only the message, and this side emits no frames at all. That is
    loss, it is declared, and it is not what this test is about.
    """
    dsn = "connect failed DB_DSN=postgres://user:HUNTER2@host/db"

    def emit(build: object) -> str:
        configure_logging("info")
        try:
            raise ValueError(dsn)
        except ValueError as error:
            payload = build(error) if callable(build) else build
            structlog.get_logger().error("boom", exc_info=payload)
        return capsys.readouterr().out.strip().splitlines()[-1]

    # The two that were already safe, and must stay both safe AND informative.
    for boolean in (True, False):
        line = emit(boolean)
        assert json.loads(line)["exc_info"] is boolean, line

    # The two that were leaking, measured.
    for label, build in (
        ("sys.exc_info() tuple", lambda error: (type(error), error, error.__traceback__)),
        ("the exception instance", lambda error: error),
    ):
        line = emit(build)
        assert "HUNTER2" not in line, f"{label} put the exception message on the wire: {line}"
        assert json.loads(line)["exc_info"] == _CENSOR, (
            f"{label} must read as censored, so an operator can tell the control fired: {line}"
        )


def test_the_message_field_is_not_censored(capsys: pytest.CaptureFixture[str]) -> None:
    """`event` is a corpus row that cannot be a kwarg, so it is graded here.

    It is structlog's message field, and it is on the negative roster for a
    reason worth stating: a rule that matched it would replace the text of every
    log line this runtime emits with `[REDACTED]`, which is indistinguishable
    from having no logs.
    """
    configure_logging("info")
    structlog.get_logger().info("probe")
    payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])

    assert payload["event"] == "probe"
