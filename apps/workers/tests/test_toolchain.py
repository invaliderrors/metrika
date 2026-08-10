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

# Directories the member walk does not enter. `.venv` is the one that matters:
# every installed package under it carries a `pyproject.toml` of its own, and
# grading those would be grading PyPI.
_SKIPPED_DIRECTORIES = frozenset(
    {
        ".git",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".venv",
        "__pycache__",
        "build",
        "dist",
        "node_modules",
    }
)


def _pyproject() -> dict[str, object]:
    with (ROOT / "pyproject.toml").open("rb") as handle:
        return tomllib.load(handle)


def _load(path: Path) -> dict[str, object]:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def _under_root(pattern: str) -> list[Path]:
    return [
        path
        for path in ROOT.rglob(pattern)
        if not _SKIPPED_DIRECTORIES.intersection(path.relative_to(ROOT).parts)
    ]


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
        ["uv", "run", "--locked", "--all-packages", "ruff", "check", "."],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_the_lockfile_is_current() -> None:
    """`uv.lock` is what makes ADR-0027's pin table real, so it is checked.

    MEASURED, and the reason this is a test rather than a sentence in a README:
    after an edit to `pyproject.toml`, a bare `uv run` **re-locks and exits 0**.
    Every pin in the table silently becomes whatever re-resolves today. The
    package scripts all pass `--locked`, which fails loudly instead; this asserts
    the same property once more, so that deleting the flag from a script cannot
    quietly delete the guarantee with it.

    Note `--check`, not `--frozen`: `--frozen` declines to UPDATE the lockfile
    and says nothing about whether it still matches `pyproject.toml`.
    """
    result = subprocess.run(["uv", "lock", "--check"], cwd=ROOT, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr


def test_no_member_narrows_the_ruff_configuration() -> None:
    """One ruff configuration for the whole workspace, and it is this one.

    MEASURED: adding `[tool.ruff.lint] select = ["F"]` to a member's
    `pyproject.toml` makes `ruff check .` from the workspace root exit **0** on
    an `N802` it reported a moment earlier. ruff resolves configuration per
    file, from the nearest `pyproject.toml` or `ruff.toml` upward — so a member
    package can turn off any rule for its own subtree with an edit that looks
    like ordinary package configuration and produces no warning anywhere.

    That is the "executes but checks nothing" failure this repository has met
    twice on the Node side, which is why `packages/eslint-config` has a parity
    test of its own. Members configure their dependencies; they do not configure
    the gate.
    """
    offenders = [
        str(path.relative_to(ROOT))
        for path in _under_root("pyproject.toml")
        if path != ROOT / "pyproject.toml"
        and isinstance(tool := _load(path).get("tool"), dict)
        and "ruff" in tool
    ]
    offenders += [
        str(path.relative_to(ROOT))
        for pattern in ("ruff.toml", ".ruff.toml")
        for path in _under_root(pattern)
    ]

    assert offenders == [], (
        "these narrow ruff for their own subtree; the workspace has one rule set, "
        f"in apps/workers/pyproject.toml: {offenders}"
    )
