from __future__ import annotations

import asyncio
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field


@dataclass
class _RateWindow:
    hits: deque[float] = field(default_factory=deque)
    last_seen: float = 0.0


class InMemoryRateLimiter:
    """Bounded single-process sliding-window limiter for the MVP API."""

    def __init__(self, *, limit: int, window_seconds: float, max_keys: int = 10_000) -> None:
        if limit <= 0 or window_seconds <= 0 or max_keys <= 0:
            raise ValueError("rate limiter values must be positive")
        self.limit = limit
        self.window_seconds = window_seconds
        self.max_keys = max_keys
        self._windows: OrderedDict[str, _RateWindow] = OrderedDict()
        self._lock = asyncio.Lock()

    async def consume(self, key: str) -> tuple[bool, int]:
        async with self._lock:
            now = time.monotonic()
            cutoff = now - self.window_seconds
            window = self._windows.get(key)
            if window is None:
                self._evict_stale(cutoff)
                if len(self._windows) >= self.max_keys:
                    self._windows.popitem(last=False)
                window = _RateWindow()
                self._windows[key] = window
            while window.hits and window.hits[0] <= cutoff:
                window.hits.popleft()
            window.last_seen = now
            self._windows.move_to_end(key)
            if len(window.hits) >= self.limit:
                retry_after = max(1, int(window.hits[0] + self.window_seconds - now + 0.999))
                return False, retry_after
            window.hits.append(now)
            return True, 0

    async def reset(self, key: str) -> None:
        async with self._lock:
            self._windows.pop(key, None)

    def _evict_stale(self, cutoff: float) -> None:
        # Access order is also last_seen order. Visit only expired entries, not
        # every client on each new key (quadratic under high-cardinality traffic).
        while self._windows:
            key = next(iter(self._windows))
            if self._windows[key].last_seen > cutoff:
                break
            self._windows.popitem(last=False)
