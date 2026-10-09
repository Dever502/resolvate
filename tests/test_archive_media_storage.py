import asyncio
import io
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


def test_usage_counts_real_files_without_following_symlinks(tmp_path: Path) -> None:
    storage = ArchiveMediaStorage(tmp_path, reserve_bytes=0)
    storage.root.mkdir()
    assets = tmp_path / "web-media" / "assets"
    assets.mkdir(parents=True)
    (storage.root / "original.blob").write_bytes(b"123")
    (assets / "file.png").write_bytes(b"12345")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "not-media").write_bytes(b"x" * 100)
    (assets / "directory-link").symlink_to(outside, target_is_directory=True)
    (assets / "file-link").symlink_to(outside / "not-media")
    (assets / "missing-link").symlink_to(outside / "missing")
    assert storage.usage()[0] == 8


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


async def test_web_upload_uses_shared_disk_reserve_and_closes_rejected_upload(
    tmp_path: Path,
) -> None:
    from starlette.datastructures import UploadFile

    from resolvate.media_storage import LocalMediaStorage

    capacity = ArchiveMediaStorage(tmp_path, reserve_bytes=2**60)
    source = io.BytesIO(b"photo")
    upload = UploadFile(source, filename="photo.png")
    with pytest.raises(ArchiveStorageFull):
        await LocalMediaStorage(tmp_path, capacity=capacity).save_upload(upload)
    assert source.closed
    assert not await asyncio.to_thread(files, tmp_path / "web-media", "*")
