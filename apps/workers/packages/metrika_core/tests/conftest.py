"""Fixtures shared by `metrika_core`'s suite.

Only one, and it exists because `WorkerSettings` now reads the whole
`METRIKA_*` namespace rather than the six names it declares: a developer with
`METRIKA_TEST_DATABASE_URL` exported — a variable this repository really does
use, in `packages/testing/src/database.ts` — would otherwise see the settings
tests fail for a reason that has nothing to do with the settings.
"""

from __future__ import annotations

import os

import pytest

_PREFIX = "METRIKA_"


@pytest.fixture(autouse=True)
def isolated_metrika_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove every inherited `METRIKA_*` variable before each test.

    Function-scoped and autouse. The session-scoped MinIO fixtures in
    `test_storage.py` are unaffected: pytest instantiates higher-scoped fixtures
    first, so the settings they need are already read by the time this runs, and
    the AWS credentials they keep using are not in this namespace.
    """
    for name in list(os.environ):
        if name.upper().startswith(_PREFIX):
            monkeypatch.delenv(name, raising=False)
