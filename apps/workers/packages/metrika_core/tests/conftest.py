"""Fixtures shared by `metrika_core`'s suite.

One is defined here, and it exists because `WorkerSettings` reads a whole
namespace rather than the names it declares: a developer with
`METRIKA_WORKER_LOG_LEVEL` exported would otherwise see tests fail for a reason
that has nothing to do with the code under test.

The other two are IMPORTED, from `_temporal_server.py`. pytest shares fixtures
only through a `conftest.py`, and it collects them from this module's namespace
whether they were defined here or imported into it — so re-exporting is how
`test_temporal.py` and `test_telemetry.py` come to share ONE `auto-setup`
container for the session instead of booting one each. They are not defined
inline because the container configuration is sixty lines of measured detail
with a docstring per decision, and this file would then be that file.
"""

from __future__ import annotations

import os

import _temporal_server
import pytest

# THE RE-EXPORT, spelled as assignments rather than as a `from … import` line
# carrying a suppression. pytest collects fixtures from this module's namespace,
# so binding the names here is what shares them.
#
# Written this way there is no unused-import warning to suppress, which is worth
# two lines: a suppression on this line would need an inline justification (and
# CI greps for that, not for the linters' opinion of it), and it would have to
# carry an isort directive as well, because `_temporal_server` is a sibling
# module that ruff files as third-party. Assignments need neither.
settings = _temporal_server.settings
temporal_address = _temporal_server.temporal_address

# `METRIKA_WORKER_`, deliberately narrower than the `METRIKA_` this file used to
# clear. Two reasons, and the second is the interesting one.
#
# It is the namespace `WorkerSettings` actually claims, so clearing more would be
# a fixture reaching outside its subject. And leaving the rest of `METRIKA_`
# alone means that on any machine where the Node integration harness has run —
# where `METRIKA_TEST_DATABASE_URL` really is exported — every `WorkerSettings()`
# in this suite constructs with it present. The prefix narrowing is then load-
# bearing for the whole file rather than for the one test that names it.
_PREFIX = "METRIKA_WORKER_"


@pytest.fixture(autouse=True)
def isolated_worker_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove every inherited `METRIKA_WORKER_*` variable before each test.

    Function-scoped and autouse. The session-scoped MinIO fixtures in
    `test_storage.py` are unaffected: pytest instantiates higher-scoped fixtures
    first, so the settings they need are already read by the time this runs, and
    the AWS credentials they keep using are not in this namespace.
    """
    for name in list(os.environ):
        if name.upper().startswith(_PREFIX):
            monkeypatch.delenv(name, raising=False)
