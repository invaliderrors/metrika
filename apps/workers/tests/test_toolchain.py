"""The gates this repository relies on, asserted rather than assumed.

Every one of these has a Node-side equivalent that was once documented and
absent. The point of the file is that `mypy --strict` and `ruff` are not
optional and not silently downgradeable.
"""

from __future__ import annotations

import asyncio
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


async def _resolved() -> int:
    await asyncio.sleep(0)
    return 1


async def test_an_unmarked_coroutine_test_actually_runs() -> None:
    """ADR-0027 obligation 9, first half.

    No `@pytest.mark.asyncio` anywhere, so this passes only under
    `asyncio_mode = "auto"`. Under the default strict mode, pytest@9.1.1 FAILS an
    unmarked async test rather than skipping it — which is the good failure, and
    is what makes this test a check on the setting rather than on pytest.

    It awaits something and asserts the result, because a coroutine test body
    that is never awaited also never fails.
    """
    assert await _resolved() == 1


def test_a_failing_async_test_is_reported_as_a_failure(tmp_path: Path) -> None:
    """ADR-0027 obligation 9, second half — the one that is easy to skip.

    The test above proves an async test RUNS. It cannot prove one can FAIL, and
    those are different properties: a runner that collected the coroutine and
    dropped it would leave a whole category of assertion silently green, which is
    exactly the shape this repository keeps meeting.

    So a deliberately failing async test is written to a temp file and run in a
    subprocess against THIS package's configuration (`-c`, so `asyncio_mode`
    applies), and both the exit code and the summary line are checked — `1
    failed` specifically, because `1 skipped`, `1 error` and `1 passed` all
    describe a broken gate and only one of them exits non-zero.
    """
    failing = tmp_path / "test_deliberately_failing_async.py"
    failing.write_text(
        "async def test_fails() -> None:\n    assert 1 == 2, 'this must be reported'\n",
        encoding="utf-8",
    )

    # S603 fires because two argv entries are not string literals. They are
    # `ROOT`, derived from this file's own path, and pytest's `tmp_path` — there
    # is no untrusted input in this list, and S603 stays enabled for test files
    # (see the per-file-ignores comment) precisely so that a call with real
    # untrusted input has to argue for itself the way this one does.
    result = subprocess.run(  # noqa: S603  # -- argv is literal plus two paths this test built
        [
            "uv",
            "run",
            "--locked",
            "--all-packages",
            "pytest",
            "-c",
            str(ROOT / "pyproject.toml"),
            "-p",
            "no:cacheprovider",
            "-q",
            str(failing),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0, f"a failing async test exited 0:\n{result.stdout}"
    assert "1 failed" in result.stdout, (
        f"expected the failure to be REPORTED, not skipped or errored:\n{result.stdout}"
    )


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
