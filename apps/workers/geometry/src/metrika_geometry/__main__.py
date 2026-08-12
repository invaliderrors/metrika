"""`python -m metrika_geometry` — the geometry worker process.

Fifteen lines, and that is the design rather than a consequence of there being
one stub activity. Everything a worker process does that is not its own
activities — reading settings, configuring logging, connecting, polling,
shutting down on SIGTERM — lives in `metrika_core.temporal`, so this file and
`metrika_slicer.__main__` differ in exactly two things: the activities they
register and the queue their settings name. Two entry points that each grew
their own client setup would drift on precisely the details nobody looks at
until an incident.

Everything is behind `main()` and `if __name__ == "__main__":`. ADR-0027
obligation 8 requires that of any module a workflow definition can reach, and
the spike measured what happens otherwise: a module-scope `asyncio.run(...)`
beside a workflow definition is re-entered by Temporal's sandbox and fails
validation. Nothing here defines a workflow today — this side of the repository
runs activities only — but a file whose import starts a process is a hazard on
its own terms: `python -c "import metrika_geometry.__main__"` would connect to
Temporal.
"""

from __future__ import annotations

import asyncio

from metrika_core.logging import configure_logging
from metrika_core.settings import WorkerSettings
from metrika_core.temporal import run_worker
from metrika_geometry.activities import ACTIVITIES


def main() -> None:
    """Read the environment, then run until the platform says stop.

    `WorkerSettings()` first and logging second, which is the one ordering
    decision here: the log level is a setting, so a configuration error is
    reported by pydantic to stderr rather than through a logger that has not
    been configured yet. `extra="forbid"` plus the validator in
    `metrika_core.settings` means a typo'd `METRIKA_WORKER_*` variable is a
    startup failure naming the variable — never a worker that starts and polls
    a queue nobody publishes to.
    """
    settings = WorkerSettings()
    configure_logging(settings.log_level)
    asyncio.run(run_worker(settings, ACTIVITIES))


if __name__ == "__main__":
    main()
