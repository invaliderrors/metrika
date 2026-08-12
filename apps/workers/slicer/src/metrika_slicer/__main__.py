"""`python -m metrika_slicer` — the slicer worker process.

Deliberately the same fifteen lines as `metrika_geometry.__main__`, differing in
the activities it registers and in nothing else. The queue is not here either:
it is `METRIKA_WORKER_TEMPORAL_TASK_QUEUE`, so the same image can be deployed
against `slicer-small` and `slicer-large` without a code change, and the two
entry points cannot drift on how they connect or how they shut down.

If these two files ever need to differ by more than their `ACTIVITIES` import,
that difference belongs in `metrika_core.temporal` behind an argument — not
copied into both.
"""

from __future__ import annotations

import asyncio

from metrika_core.logging import configure_logging
from metrika_core.settings import WorkerSettings
from metrika_core.temporal import run_worker
from metrika_slicer.activities import ACTIVITIES


def main() -> None:
    """Read the environment, then run until the platform says stop.

    `WorkerSettings()` first and logging second: the log level is a setting, so
    a configuration error is reported by pydantic to stderr rather than through
    a logger that has not been configured yet.
    """
    settings = WorkerSettings()
    configure_logging(settings.log_level)
    asyncio.run(run_worker(settings, ACTIVITIES))


if __name__ == "__main__":
    main()
