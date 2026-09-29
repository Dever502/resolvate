from __future__ import annotations

import time
from pathlib import Path

from resolvate.config import get_settings


def heartbeats_healthy(
    data_dir: Path,
    *,
    notification_webhook_enabled: bool,
    max_age_seconds: float = 45,
    now: float | None = None,
) -> bool:
    names = ["heartbeat", "delivery-worker-heartbeat"]
    if notification_webhook_enabled:
        names.append("notification-webhook-worker-heartbeat")
    current_time = time.time() if now is None else now
    return all(
        (heartbeat := data_dir / name).exists()
        and current_time - heartbeat.stat().st_mtime <= max_age_seconds
        for name in names
    )


def main() -> None:
    settings = get_settings()
    # Project worker health is surfaced independently; a broken bot must not take
    # down the installation console or healthy projects.
    heartbeat = settings.data_dir / "heartbeat"
    healthy = heartbeat.exists() and time.time() - heartbeat.stat().st_mtime <= 45
    raise SystemExit(0 if healthy else 1)


if __name__ == "__main__":
    main()
