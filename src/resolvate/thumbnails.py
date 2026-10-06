"""Project-local bounded memory cache; every HTTP read still checks access and the original."""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from collections import OrderedDict
from pathlib import Path

from fastapi import HTTPException

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
            task = asyncio.create_task(asyncio.to_thread(self._generate, path))
            try:
                content = await asyncio.shield(task)
            except asyncio.CancelledError:
                # A disconnected client must not release the slot while its decoder still runs.
                try:
                    await task
                finally:
                    raise
            self.cache[key] = content
            self.size += len(content)
            while self.size > CACHE_BYTES or len(self.cache) > CACHE_ITEMS:
                _, expired = self.cache.popitem(last=False)
                self.size -= len(expired)
            return content

    @staticmethod
    def _generate(path: Path) -> bytes:
        try:
            result = subprocess.run(
                [sys.executable, "-m", "resolvate.thumbnail_inspect", str(path)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=12,
                check=True,
                env={
                    "PATH": os.defpath,
                    "PYTHONPATH": str(Path(__file__).parent.parent),
                    "PYTHONDONTWRITEBYTECODE": "1",
                },
            )
            content = result.stdout
            if (
                not 12 <= len(content) <= MAX_THUMBNAIL_BYTES
                or content[:4] != b"RIFF"
                or content[8:12] != b"WEBP"
            ):
                raise ValueError("invalid thumbnail")
            return content
        except (OSError, ValueError, subprocess.SubprocessError):
            raise HTTPException(503, "Миниатюра недоступна. Откройте оригинал.") from None
