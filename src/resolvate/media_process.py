"""Run media workers without application secrets; timeouts kill their decoder children too."""

import os
import signal
import subprocess
from pathlib import Path


def run_media_process(args: list[str], *, timeout: float) -> bytes:
    with subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        env={
            "PATH": os.defpath,
            "PYTHONPATH": str(Path(__file__).parent.parent),
            "PYTHONDONTWRITEBYTECODE": "1",
        },
    ) as process:
        try:
            output, _ = process.communicate(timeout=timeout)
        except BaseException:
            # Killing only Python leaves ffprobe running after validation timed out.
            # A private process group cannot include the application or other workers.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            raise
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, args)
        return output
