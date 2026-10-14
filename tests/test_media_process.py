from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from resolvate.media_process import run_media_process


@pytest.mark.parametrize("parent_exit", ["time.sleep(60)", "sys.exit(1)"])
def test_timeout_stops_decoder_descendants(parent_exit: str) -> None:
    # An inert child stands in for a stuck native decoder. Even an already dead
    # Python worker must not leave its child (and inherited stdout) alive.
    code = (
        "import subprocess,sys,time; "
        "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); "
        "print(child.pid,flush=True); " + parent_exit
    )
    with pytest.raises(subprocess.TimeoutExpired) as raised:
        run_media_process([sys.executable, "-c", code], timeout=2)
    assert raised.value.output
    child = int(raised.value.output.strip())
    status = Path(f"/proc/{child}/stat")
    try:
        deadline = time.monotonic() + 2
        while status.exists():
            try:
                if status.read_text().rsplit(") ", 1)[1].startswith("Z"):
                    break  # Dead; reaping belongs to the container/host init.
            except (FileNotFoundError, ProcessLookupError):
                break
            assert time.monotonic() < deadline, "decoder survived validation timeout"
            time.sleep(0.01)
    finally:
        try:
            os.kill(child, signal.SIGKILL)
        except ProcessLookupError:
            pass


def test_worker_environment_excludes_application_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RESOLVATE_TEST_SENTINEL", "not-a-real-secret")
    output = run_media_process(
        [sys.executable, "-c", "import os; print(os.getenv('RESOLVATE_TEST_SENTINEL', 'absent'))"],
        timeout=5,
    )
    assert output == b"absent\n"


def test_worker_failure_is_not_success() -> None:
    with pytest.raises(subprocess.CalledProcessError):
        run_media_process([sys.executable, "-c", "raise SystemExit(1)"], timeout=5)
