"""The gates this repository relies on, asserted rather than assumed.

Every one of these has a Node-side equivalent that was once documented and
absent. The point of the file is that `mypy --strict` and `ruff` are not
optional and not silently downgradeable.
"""

from __future__ import annotations

import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _pyproject() -> dict[str, object]:
    with (ROOT / "pyproject.toml").open("rb") as handle:
        return tomllib.load(handle)


def test_python_major_matches_the_pinned_version_file() -> None:
    pinned = (ROOT / ".python-version").read_text().strip()
    assert sys.version.startswith(pinned), (
        f"running {sys.version.split()[0]}, .python-version says {pinned}"
    )


def test_mypy_runs_in_strict_mode() -> None:
    config = _pyproject()
    tool = config.get("tool")
    assert isinstance(tool, dict)
    mypy = tool.get("mypy")
    assert isinstance(mypy, dict)
    assert mypy.get("strict") is True, "mypy must be strict; an untyped worker can price wrongly"


def test_ruff_check_is_clean() -> None:
    result = subprocess.run(
        ["uv", "run", "ruff", "check", "."], cwd=ROOT, capture_output=True, text=True
    )
    assert result.returncode == 0, result.stdout + result.stderr
