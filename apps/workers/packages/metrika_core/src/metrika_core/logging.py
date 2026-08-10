"""Structured JSON logging, with redaction as a processor rather than a habit.

The module is called `logging` and shadows the standard library's, which is
intentional: `metrika_core.logging` is the only logging setup a worker imports,
and a second name for it would be a second place to look. Absolute imports mean
the `import logging` below still resolves to the standard library.
"""

from __future__ import annotations

import logging

import structlog
from structlog.typing import EventDict, WrappedLogger

# SECURITY.md: signed URLs and uploaded file names never reach a log line. A
# presigned URL carries `X-Amz-Signature`, which is a bearer credential for the
# object until it expires; an original file name is customer data and is exactly
# the field a support ticket screenshot leaks.
#
# Matched on the KEY, case-insensitively, and only on exact equality: a
# substring rule would redact `url_count` and, worse, would read as if it
# redacted `presigned` inside a message string, which no key-based processor can
# do. Redaction here is a floor, not a guarantee — a signed URL interpolated
# into the event message itself is not something structlog can see, which is why
# callers pass values as key/value pairs and never as f-strings.
REDACTED_KEYS: frozenset[str] = frozenset(
    {
        "presigned_url",
        "signed_url",
        "url",
        "file_name",
        "filename",
        "original_filename",
        "authorization",
        "token",
        "secret",
        "password",
    }
)

_REDACTED = "[redacted]"


def _redact(_logger: WrappedLogger, _method_name: str, event_dict: EventDict) -> EventDict:
    for key in list(event_dict):
        if key.lower() in REDACTED_KEYS:
            event_dict[key] = _REDACTED
    return event_dict


def configure_logging(level: str) -> None:
    """Configure structlog to emit one JSON object per line, redacted.

    `_redact` sits BEFORE the renderer for the only reason that matters: after
    it, the event is a string and there are no keys left to match.
    """
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            _redact,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.getLevelNamesMapping()[level.upper()]
        ),
        cache_logger_on_first_use=True,
    )
