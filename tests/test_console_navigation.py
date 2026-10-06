from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.parametrize(
    "script", ["console_navigation.cjs", "console_live.cjs", "console_members.cjs"]
)
def test_console_navigation_behaviour(script: str) -> None:
    node = shutil.which("node")
    if node is None:
        if os.environ.get("CI"):
            pytest.fail("Node.js is required for console navigation regression tests in CI")
        pytest.skip("Install Node.js to run console navigation regression tests")
    result = subprocess.run(
        [node, str(Path(__file__).with_name(script))],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
