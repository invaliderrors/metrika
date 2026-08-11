"""Fixtures shared by `metrika_core`'s suite.

Only one, and it exists because `WorkerSettings` reads a whole namespace rather
than the six names it declares: a developer with `METRIKA_WORKER_LOG_LEVEL`
exported would otherwise see tests fail for a reason that has nothing to do
with the code under test.
"""

from __future__ import annotations

import os

import pytest

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
