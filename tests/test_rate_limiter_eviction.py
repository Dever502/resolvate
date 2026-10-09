from __future__ import annotations

import random
from collections import deque

import pytest

from resolvate.api_security import InMemoryRateLimiter
from resolvate.user_message_limits import UserMessageRateLimiter


async def test_api_limiter_matches_sliding_window_reference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = 0.0
    monkeypatch.setattr("resolvate.api_security.time.monotonic", lambda: now)
    limiter = InMemoryRateLimiter(limit=3, window_seconds=10, max_keys=8)
    windows: dict[str, tuple[deque[float], float]] = {}
    randomizer = random.Random(42)
    for _ in range(2000):
        now += randomizer.uniform(0.01, 1)
        key = str(randomizer.randrange(12))
        if randomizer.randrange(20) == 0:
            windows.pop(key, None)
            await limiter.reset(key)
            continue
        cutoff = now - 10
        if key not in windows:
            windows = {k: value for k, value in windows.items() if value[1] > cutoff}
            if len(windows) >= 8:
                del windows[min(windows, key=lambda k: windows[k][1])]
            windows[key] = (deque(), now)
        hits, _ = windows[key]
        while hits and hits[0] <= cutoff:
            hits.popleft()
        windows[key] = (hits, now)
        expected = (False, max(1, int(hits[0] + 10 - now + 0.999))) if len(hits) >= 3 else (True, 0)
        if expected[0]:
            hits.append(now)
        assert await limiter.consume(key) == expected
        assert set(limiter._windows) == set(windows)


async def test_user_limiter_eviction_preserves_recent_blocked_clients() -> None:
    now = 0.0
    limiter = UserMessageRateLimiter(per_minute=1, per_hour=1, max_users=2, monotonic=lambda: now)
    assert (await limiter.consume("a")).allowed
    now = 1
    assert (await limiter.consume("b")).allowed
    now = 2
    decision = await limiter.consume("a")
    assert not decision.allowed and decision.notify_client and decision.notify_operators
    now = 3
    assert (await limiter.consume("c")).allowed
    assert set(limiter._windows) == {"a", "c"}
    now = 4
    decision = await limiter.consume("a")
    assert not decision.allowed
    assert decision.retry_after_seconds == 3596
    assert not decision.notify_client and not decision.notify_operators
    now = 3605
    assert (await limiter.consume("d")).allowed
    assert set(limiter._windows) == {"d"}
