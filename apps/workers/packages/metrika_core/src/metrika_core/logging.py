"""Structured JSON logging, with redaction as a processor rather than a habit.

The module is called `logging` and shadows the standard library's, which is
intentional: `metrika_core.logging` is the only logging setup a worker imports,
and a second name for it would be a second place to look. Absolute imports mean
the `import logging` below still resolves to the standard library.
"""

from __future__ import annotations

import logging
import re

import structlog
from structlog.typing import EventDict, WrappedLogger

from metrika_core.contracts import RedactedFieldName
from metrika_core.telemetry import bind_activity_context, bind_correlation

# SECURITY.md: signed URLs and uploaded file names never reach a log line. A
# presigned URL carries `X-Amz-Signature`, which is a bearer credential for the
# object until it expires; an original file name is customer data and is exactly
# the field a support ticket screenshot leaks.
#
# **NEITHER THE LIST NOR THE RULE IS HERE.** Both live in
# `packages/contracts/src/redaction.ts`. The list arrives on this side as
# GENERATED code that `pnpm contracts:emit` writes and CI byte-diffs; the rule
# is ported below and graded against `redaction-corpus.json` by
# `tests/test_redaction_corpus.py`.
#
# Three sinks read that list — Pino in `apps/api`, structlog here, and Sentry's
# `beforeSend` in `apps/web`. Three hand-maintained copies of a security control
# is how one of them silently stops matching: nothing fails, nothing warns, and
# the sink that drifted keeps emitting a line that looks exactly like the two
# that did not. That is not hypothetical for the RULE either — it was two copies
# and 27 of 140 probe names were measured disagreeing between them.
#
# What differs per sink is TRAVERSAL, and only traversal: Pino walks paths and
# needs one rule per name per depth, this side walks a flat event dict, Sentry
# walks an arbitrary object graph. The decision each of them makes about a key it
# has reached is one algorithm, and `isRedactedKey` in that module is it.
REDACTED_FIELD_NAMES: frozenset[str] = frozenset(name.value for name in RedactedFieldName)

# Splits an identifier into lowercase words, in either spelling. `signedUrl` and
# `signed_url` both become `("signed", "url")`, which is what lets one camelCase
# list serve a snake_case runtime without either side restating the other's
# convention.
#
# Three alternatives, each rejected on a case it gets wrong:
#
#   * EXACT EQUALITY over the names. Too narrow, and narrow in the direction
#     that matters: `download_url`, `s3_url`, `object_url` and `upload_url` are
#     the names a caller actually reaches for, and every one of them went
#     through untouched when this module was first written.
#   * A SUBSTRING rule. Takes `url_count` — a harmless integer — and, worse,
#     takes `cache_key`, the content-addressed identifier this system uses to
#     talk about an upload without naming it.
#   * A STRING SUFFIX rule (`endswith("_url")`). Its predecessor, and it worked;
#     it just cannot express `signedUrl` without a second list in the other
#     spelling, which is the copy this module exists to stop keeping.
#
# The word rule keeps every case the string-suffix rule caught and adds the
# camelCase spellings. `curl` is the case that shows it is a WORD suffix and not
# a character one: one word, `curl`, which is not `url`.
#
# DIGITS ARE THEIR OWN WORD (`[0-9]+` rather than folding them into `[a-z0-9]+`),
# so `url2` is `("url", "2")` and not one opaque token. Measured before the
# change: `signedURL2` and `presigned_url_v2` both returned False.
#
# `[A-Z]+s(?![a-z])` IS FIRST, AND THE ORDER IS THE WHOLE OF IT. An acronym
# plural has to stay one word: `URLs` is `("urls",)`, which the plural rule below
# reduces to `url`. Second in the order it never fires, because
# `[A-Z]+(?![a-z])` backtracks off the lowercase `s` and matches `UR` —
# MEASURED, and the result is `("ur", "ls")`, which matches nothing at all.
# `signedURLs`, `downloadURLs`, `presignedURLs` and `URLs` were all going
# through untouched, which is a leaked presigned URL from any batch step that
# spells the acronym.
#
# `HTTPStatus` still splits `("http", "status")` and `AWSSecret` still splits
# `("aws", "secret")`; neither is captured by the plural branch, which requires
# a literal lowercase `s`.
#
# THIS REGEX IS A PORT, not an original. The rule lives in
# `packages/contracts/src/redaction.ts` and `tests/test_redaction_corpus.py`
# grades this side against the corpus emitted from it — because two hand-written
# implementations of one algorithm drift exactly as two copies of the key list
# would, and review measured 27 of 140 names disagreeing before that corpus
# existed.
_WORDS = re.compile(r"[A-Z]+s(?![a-z])|[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z]+|[0-9]+")

# A trailing ordinal. `url2`, `signed_url_v2` and `attempt_3` all end in one, and
# a number bolted onto a name does not change what the field holds.
_ORDINAL = re.compile(r"^[0-9]+$")


def _words(name: str) -> tuple[str, ...]:
    return tuple(part.lower() for part in _WORDS.findall(name))


def _spellings(words: tuple[str, ...]) -> tuple[tuple[str, ...], ...]:
    """The forms of one key that all mean the same field.

    THREE MISSES THIS EXISTS FOR, every one measured returning False from the
    first version of `is_redacted_key`, and every one a real spelling:

        presigned_urls, signed_urls, file_names      a batch helper's plural
        signedURL2, presigned_url_v2                 an ordinal or a version
        signedurl, presignedurl                      no word boundary at all

    A batch presign step logging `presigned_urls=[…]` leaked with every gate in
    this repository green, which is the positive-assertion trap again: the
    fixtures exercised the exact name and an `upstream`-prefixed one, so they
    could not see a class of spelling nobody had thought to write down.

    Each form below is EXACT rather than fuzzy, which is what keeps the cost
    bounded:

      * the ordinal trim pops trailing NUMERIC words, then a lone `v` if a
        number was popped from behind it. `url_count` keeps its `count` and
        stays readable; `s3_url` keeps its `url` because the digit is not
        trailing.
      * the plural form strips ONE trailing `s` from the last word, and is
        offered ALONGSIDE the raw form rather than replacing it — no redacted
        name ends in `s`, so nothing can be lost, and `url` still matches `url`.
      * the concatenation is the redacted name with its own word boundary
        removed, which is a fixed string per name and not a prefix heuristic.
        This is why `signedurl` matches and `curl` does not: `curl` is not the
        concatenation of anything on the list, whereas a rule like "ends with
        the letters u-r-l" takes both.
    """
    trimmed = list(words)
    popped_a_number = False
    while trimmed and _ORDINAL.match(trimmed[-1]):
        trimmed.pop()
        popped_a_number = True
    if popped_a_number and trimmed and trimmed[-1] == "v":
        trimmed.pop()
    # THE SAME `v`, WHEN IT DID NOT GET ITS OWN TOKEN. `signed_url_v2` tokenises
    # as `[…, "url", "v", "2"]` and the branch above is enough; `signedURLV2` and
    # `signedurlv2` do not, because the `v` merges into the uppercase run and the
    # lowercase run respectively.
    if popped_a_number and trimmed and len(trimmed[-1]) > 1 and trimmed[-1].endswith("v"):
        trimmed[-1] = trimmed[-1][:-1]

    forms = [tuple(trimmed)]
    if trimmed and len(trimmed[-1]) > 1 and trimmed[-1].endswith("s"):
        forms.append((*trimmed[:-1], trimmed[-1][:-1]))
    return tuple(forms)


# Every redacted name as a word tuple, so matching is a suffix comparison rather
# than a string search — plus, for the multi-word names, the same words with the
# boundary removed. `("url",)` is the entry that reaches `s3_url` and
# `downloadUrl`; `("file", "name")` reaches `original_file_name`; `("signedurl",)`
# reaches `signedurl` without letting `curl` in.
#
# `key` is deliberately not among them, and neither is anything ending in it:
# `cache_key` is the identifier every pipeline log line carries, and redacting
# it would cost real debuggability for a word whose values here are safe.
_REDACTED_WORDS: frozenset[tuple[str, ...]] = frozenset(
    candidate
    for name in REDACTED_FIELD_NAMES
    for candidate in (_words(name), ("".join(_words(name)),))
)

# THE SAME TOKEN THE OTHER TWO SINKS WRITE, and it used to be `[redacted]`.
#
# The divergence was an accident rather than a decision, and it cost exactly what
# a divergent vocabulary costs: an operator grepping a mixed log stream for
# `[REDACTED]` — which is what `packages/contracts`' `REDACTION_CENSOR` writes,
# what both TypeScript sinks emit, and what `docs/OBSERVABILITY.md` §3's own
# example line shows — silently matched no Python line at all. Nothing graded it,
# and the corpus structurally cannot: it declares which KEYS are redacted, never
# what the censor looks like.
#
# `packages/contracts/test/censor-agreement.test.ts` now reads this literal out of
# this file and asserts it equals `REDACTION_CENSOR`, with the cross-package input
# declared in `packages/contracts/turbo.json`. Changing one side alone is red.
_REDACTED = "[REDACTED]"

# `exc_info` IS NOT A FIELD NAME THE SHARED LIST CAN REACH, and two of its four
# shapes put an exception's message on the wire. MEASURED, through this exact
# pipeline, with `ValueError("connect failed DB_DSN=postgres://user:HUNTER2@host/db")`:
#
#     log.exception("boom")                    → "exc_info": true
#     log.error("m", exc_info=True)            → "exc_info": true
#     log.error("m", exc_info=sys.exc_info())  → the full repr, DSN included
#     log.error("m", exc_info=<the exception>) → the full repr, DSN included
#
# The last two reach `JSONRenderer`, whose `default=repr` renders whatever it was
# handed. So the honest description of this side is not "the traceback is lost" —
# it is lost in two shapes and EXPOSED in the other two, and the exposed ones are
# ordinary Python that any caller would write.
#
# A non-boolean value is therefore censored. A boolean is kept: it carries no
# text, and `"exc_info": true` is what says an exception was attached — the same
# reason `apps/api`'s `serialiseError` emits a censored `message` rather than
# omitting the field. The control firing must be visible.
#
# WHAT THIS DOES NOT DO, so nobody reads it as more than it is: it does not
# RENDER the traceback. `apps/api` keeps an exception's frames and censors only
# its message (ADR-0030's frame-preserving serialiser), and the equivalent here is
# a real exception renderer that emits frames without the message line. That is
# owed; this closes the exposure in the meantime rather than leaving it open
# behind a comment. Measured safe to change today: nothing in the repository
# passes `exc_info` at all.
_EXC_INFO_KEY = "exc_info"


def is_redacted_key(key: str) -> bool:
    """Whether a log key names something that must never be written down.

    Public because it is the matcher, and a second sink on this side — a Sentry
    `before_send`, when one arrives — must use this rather than write its own.

    THE ONE SHAPE IT DOES NOT REACH, named so nobody assumes otherwise: an
    invented concatenation with no word boundary that is not itself on the list —
    `mysignedurl`, `thetoken`. Catching those needs a prefix heuristic, and the
    same heuristic takes `curl`. `signedurl` is reached because it IS a listed
    name with its boundary removed; `mysignedurl` is not, and `my_signed_url`,
    `mySignedUrl` and `signedurls` all are.
    """
    return any(
        len(candidate) <= len(words) and words[-len(candidate) :] == candidate
        for words in _spellings(_words(key))
        for candidate in _REDACTED_WORDS
    )


def _redact(_logger: WrappedLogger, _method_name: str, event_dict: EventDict) -> EventDict:
    for key in list(event_dict):
        if is_redacted_key(key):
            event_dict[key] = _REDACTED
        elif key == _EXC_INFO_KEY and not isinstance(event_dict[key], bool):
            # See `_EXC_INFO_KEY`: a tuple or an exception instance renders
            # through `repr` and carries the message. A bool carries nothing and
            # is what makes the attachment visible.
            event_dict[key] = _REDACTED
    return event_dict


def configure_logging(level: str) -> None:
    """Configure structlog to emit one JSON object per line, correlated and redacted.

    ORDER IS THE WHOLE OF THIS FUNCTION, and two of the four steps below are
    load-bearing rather than aesthetic:

      * the correlation processors run BEFORE `_redact`, so that anything they
        add is subject to it. None of `requestId`, `traceId`, `spanId`,
        `organizationId`, `workflowId` or `activityType` matches the redaction
        list today — `packages/contracts/test/redaction.test.ts` asserts that
        from the other side — but a processor whose output bypassed redaction
        would be a hole waiting for the first field somebody adds.
      * `_redact` runs BEFORE the renderer, for the only reason that matters:
        after it, the event is a string and there are no keys left to match.

    `merge_contextvars` stays first so an explicit `bind_contextvars` still
    wins, and the correlation processors use `setdefault` for the same reason:
    a caller talking about some other request's ID is not something this module
    should silently overwrite.
    """
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            bind_correlation,
            bind_activity_context,
            _redact,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.getLevelNamesMapping()[level.upper()]
        ),
        cache_logger_on_first_use=True,
    )
