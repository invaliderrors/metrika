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
# **THE LIST IS NOT HERE.** It is `RedactedFieldName` in
# `packages/contracts/src/redaction.ts`, and it arrives on this side as
# GENERATED code that `pnpm contracts:emit` writes and CI byte-diffs. There are
# three sinks for this list — Pino in `apps/api`, structlog here, and Sentry's
# `beforeSend` in `apps/web` — and three hand-maintained copies of a security
# control is how one of them silently stops matching: nothing fails, nothing
# warns, and the sink that drifted keeps emitting a line that looks exactly like
# the two that did not. Deriving instead of copying makes that a red build.
#
# What crosses is the NAMES. The MATCHING is each sink's own, because each
# runtime can do a different amount: Pino matches paths and needs one rule per
# name per depth; this side matches the event dict's keys, which are flat, so it
# can afford the word-suffix rule below. An equality assertion between the three
# matchers would be asserting something false.
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
_WORDS = re.compile(r"[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+")


def _words(name: str) -> tuple[str, ...]:
    return tuple(part.lower() for part in _WORDS.findall(name))


# Every redacted name as a word tuple, so matching is a suffix comparison rather
# than a string search. `("url",)` is the entry that reaches `s3_url` and
# `downloadUrl`; `("file", "name")` is the one that reaches `original_file_name`.
#
# `key` is deliberately not among them, and neither is anything ending in it:
# `cache_key` is the identifier every pipeline log line carries, and redacting
# it would cost real debuggability for a word whose values here are safe.
_REDACTED_WORDS: frozenset[tuple[str, ...]] = frozenset(
    _words(name) for name in REDACTED_FIELD_NAMES
)

_REDACTED = "[redacted]"


def is_redacted_key(key: str) -> bool:
    """Whether a log key names something that must never be written down.

    Public because it is the matcher, and a second sink on this side — a Sentry
    `before_send`, when one arrives — must use this rather than write its own.
    """
    words = _words(key)
    return any(
        len(candidate) <= len(words) and words[-len(candidate) :] == candidate
        for candidate in _REDACTED_WORDS
    )


def _redact(_logger: WrappedLogger, _method_name: str, event_dict: EventDict) -> EventDict:
    for key in list(event_dict):
        if is_redacted_key(key):
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
