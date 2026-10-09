from __future__ import annotations

import asyncio
import hashlib
import io
import os
import shutil
import uuid
from collections.abc import AsyncIterator, Buffer
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Protocol


class ArchiveStorageFull(OSError):
    pass


class ArchiveMediaTooLarge(ValueError):
    pass


class ArchiveDownloader(Protocol):
    async def download(self, file: str, destination: BinaryIO, **kwargs: object) -> object: ...


@dataclass(frozen=True)
class ArchivedFile:
    path: str
    size_bytes: int
    sha256: str


class _BoundedWriter(io.BufferedWriter):
    def __init__(self, raw: io.FileIO, limit: int) -> None:
        super().__init__(raw)
        self.limit = limit
        self.written = 0

    def write(self, data: Buffer, /) -> int:
        if self.written + memoryview(data).nbytes > self.limit:
            raise ArchiveMediaTooLarge("download exceeded reserved size")
        written = super().write(data)
        self.written += written
        return written


class ArchiveMediaStorage:
    """Opaque local blobs: untrusted filenames never become filesystem paths."""

    def __init__(self, data_dir: Path, *, reserve_bytes: int) -> None:
        if reserve_bytes < 0:
            raise ValueError("disk reserve must not be negative")
        self.data_dir = data_dir.resolve()
        self.root = self.data_dir / "transcript-media"
        self.reserve_bytes = reserve_bytes
        self._reserved = 0
        self._lock = asyncio.Lock()

    @asynccontextmanager
    async def reserve(self, size: int) -> AsyncIterator[None]:
        if size <= 0:
            raise ValueError("reservation size must be positive")
        await asyncio.to_thread(self.root.mkdir, parents=True, exist_ok=True)
        async with self._lock:
            free = (await asyncio.to_thread(shutil.disk_usage, self.root)).free
            if free - self._reserved - size < self.reserve_bytes:
                raise ArchiveStorageFull("insufficient free space above the disk reserve")
            self._reserved += size
        try:
            yield
        finally:
            async with self._lock:
                self._reserved -= size

    def usage(self) -> tuple[int, int]:
        """Include Web and Telegram originals, derivatives and temporary files."""
        total = 0
        pending = [self.root, self.data_dir / "web-media"]
        while pending:
            directory = pending.pop()
            if directory.is_symlink():
                continue
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                pending.append(Path(entry.path))
                            elif entry.is_file(follow_symlinks=False):
                                # DirEntry reuses filesystem metadata instead of separate
                                # Path.is_symlink()/stat() calls for every stored file.
                                total += entry.stat(follow_symlinks=False).st_size
                        except FileNotFoundError:
                            continue
            except FileNotFoundError:
                continue
        return total, shutil.disk_usage(self.data_dir).free

    def resolve(self, relative: str) -> Path:
        path = (self.data_dir / relative).resolve()
        roots = (self.root.resolve(), (self.data_dir / "web-media" / "assets").resolve())
        if not any(path.is_relative_to(root) and path != root for root in roots):
            raise ValueError("path is outside transcript media storage")
        return path

    @staticmethod
    def inspect(path: Path) -> ArchivedFile:
        digest = hashlib.sha256()
        size = 0
        with path.open("rb") as source:
            while chunk := source.read(64 * 1024):
                digest.update(chunk)
                size += len(chunk)
        return ArchivedFile(str(path), size, digest.hexdigest())

    async def download(
        self,
        bot: ArchiveDownloader,
        *,
        file_id: str,
        max_bytes: int,
        expected_bytes: int | None = None,
    ) -> ArchivedFile:
        if expected_bytes is not None and (expected_bytes <= 0 or expected_bytes > max_bytes):
            raise ArchiveMediaTooLarge("attachment exceeds the download limit")
        allocation = expected_bytes or max_bytes
        async with self.reserve(allocation):
            key = uuid.uuid4().hex
            relative = f"transcript-media/{key[:2]}/{key}.blob"
            destination = self.resolve(relative)
            await asyncio.to_thread(destination.parent.mkdir, parents=True, exist_ok=True)
            temporary = destination.with_suffix(".part")
            try:
                with _BoundedWriter(io.FileIO(temporary, "x"), allocation) as output:
                    await bot.download(file_id, destination=output)
                    output.flush()
                    await asyncio.to_thread(os.fsync, output.fileno())
                stored = await asyncio.to_thread(self.inspect, temporary)
                if not stored.size_bytes or (
                    expected_bytes is not None and stored.size_bytes != expected_bytes
                ):
                    raise ValueError("downloaded attachment size does not match its metadata")
                await asyncio.to_thread(temporary.replace, destination)
                return ArchivedFile(relative, stored.size_bytes, stored.sha256)
            finally:
                await asyncio.to_thread(temporary.unlink, missing_ok=True)

    async def verify(self, path: str, *, size_bytes: int, sha256: str) -> bool:
        try:
            actual = await asyncio.to_thread(self.inspect, self.resolve(path))
        except OSError:
            return False
        return actual.size_bytes == size_bytes and actual.sha256 == sha256
