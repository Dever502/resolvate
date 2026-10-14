"""Project-local bounded memory cache; every HTTP read still checks access and the original."""

from __future__ import annotations

import asyncio
import subprocess
import sys
from collections import OrderedDict
from pathlib import Path

from fastapi import HTTPException

from resolvate.media_process import run_media_process
from resolvate.media_storage import _file_operation
from resolvate.thumbnail_inspect import MAX_THUMBNAIL_BYTES

CACHE_BYTES = 4 * 1024 * 1024
CACHE_ITEMS = 64


class Thumbnails:
    def __init__(self) -> None:
        self.cache: OrderedDict[str, bytes] = OrderedDict()
        self.size = 0
        self.slot = asyncio.Lock()

    async def get(self, key: str, path: Path) -> bytes:
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key]
        # One decoder at a time per project; concurrent requests for one image share the result.
        async with self.slot:
            if key in self.cache:
                self.cache.move_to_end(key)
                return self.cache[key]
            content = await _file_operation(lambda: self._generate(path))
            self.cache[key] = content
            self.size += len(content)
            while self.size > CACHE_BYTES or len(self.cache) > CACHE_ITEMS:
                _, expired = self.cache.popitem(last=False)
                self.size -= len(expired)
            return content

    @staticmethod
    def _generate(path: Path) -> bytes:
        try:
            content = run_media_process(
                [sys.executable, "-m", "resolvate.thumbnail_inspect", str(path)],
                timeout=12,
            )
            if (
                not 12 <= len(content) <= MAX_THUMBNAIL_BYTES
                or content[:4] != b"RIFF"
                or content[8:12] != b"WEBP"
            ):
                raise ValueError("invalid thumbnail")
            return content
        except (OSError, ValueError, subprocess.SubprocessError):
            raise HTTPException(503, "Миниатюра недоступна. Откройте оригинал.") from None
