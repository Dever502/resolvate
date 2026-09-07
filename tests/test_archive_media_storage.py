import asyncio
from pathlib import Path
from typing import BinaryIO

import pytest

from resolvate.archive_media_storage import (
    ArchiveMediaStorage,
    ArchiveMediaTooLarge,
    ArchiveStorageFull,
)


class Downloader:
    def __init__(self, content: bytes) -> None:
        self.content = content

    async def download(self, file: str, destination: BinaryIO, **kwargs: object) -> object:
        destination.write(self.content)
        return destination


def files(path: Path, pattern: str) -> list[Path]:
    return list(path.rglob(pattern))


async def test_archive_file_is_verified_and_paths_are_generated(tmp_path: Path) -> None:
    storage = ArchiveMediaStorage(tmp_path, reserve_bytes=0)
    stored = await storage.download(
        Downloader(b"example"), file_id="file", max_bytes=32, expected_bytes=7
    )
    assert stored.path.startswith("transcript-media/")
    assert await storage.verify(stored.path, size_bytes=7, sha256=stored.sha256)
    assert not await storage.verify(stored.path, size_bytes=8, sha256=stored.sha256)
    assert not await asyncio.to_thread(files, tmp_path, "*.part")


@pytest.mark.parametrize("relative", ["../outside", "/etc/passwd", "transcript-media/../outside"])
def test_archive_paths_cannot_escape_storage(tmp_path: Path, relative: str) -> None:
    with pytest.raises(ValueError):
        ArchiveMediaStorage(tmp_path, reserve_bytes=0).resolve(relative)


async def test_downloader_cannot_write_beyond_reserved_bytes(tmp_path: Path) -> None:
    storage = ArchiveMediaStorage(tmp_path, reserve_bytes=0)
    with pytest.raises(ArchiveMediaTooLarge):
        await storage.download(Downloader(b"too long"), file_id="file", max_bytes=3)
    assert not await asyncio.to_thread(files, tmp_path, "*.part")
    assert not await asyncio.to_thread(files, tmp_path, "*.blob")
    assert storage._reserved == 0


async def test_truncated_download_is_not_published(tmp_path: Path) -> None:
    storage = ArchiveMediaStorage(tmp_path, reserve_bytes=0)
    with pytest.raises(ValueError, match="size"):
        await storage.download(Downloader(b"x"), file_id="file", max_bytes=8, expected_bytes=5)
    assert not await asyncio.to_thread(files, tmp_path, "*.blob")


async def test_reservations_are_released_after_cancellation(tmp_path: Path) -> None:
    storage = ArchiveMediaStorage(tmp_path, reserve_bytes=0)
    with pytest.raises(asyncio.CancelledError):
        async with storage.reserve(10):
            raise asyncio.CancelledError
    assert storage._reserved == 0


async def test_disk_reserve_prevents_admission(tmp_path: Path) -> None:
    storage = ArchiveMediaStorage(tmp_path, reserve_bytes=2**60)
    with pytest.raises(ArchiveStorageFull):
        await storage.download(Downloader(b"x"), file_id="file", max_bytes=1)
    assert storage._reserved == 0
