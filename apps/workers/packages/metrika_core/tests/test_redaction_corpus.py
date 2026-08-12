"""The redaction MATCHING RULE, graded against the same corpus the TypeScript side is.

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

from metrika_core.logging import is_redacted_key

CORPUS = Path(__file__).resolve().parents[5] / "packages" / "contracts" / "redaction-corpus.json"


def _corpus() -> list[dict[str, object]]:
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
