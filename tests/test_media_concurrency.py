from __future__ import annotations

import asyncio
import io
import threading
from pathlib import Path
from typing import Any

import pytest
from PIL import Image
from starlette.datastructures import Headers, UploadFile

from resolvate.media_storage import LocalMediaStorage, StoredMedia


def photo() -> UploadFile:
    stream = io.BytesIO()
    Image.new("RGB", (8, 8), "blue").save(stream, format="PNG")
    stream.seek(0)
    return UploadFile(stream, filename="test.png", headers=Headers({"content-type": "image/png"}))


async def test_validation_does_not_block_archive_but_publication_does(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    storage = LocalMediaStorage(tmp_path)
    validating, proceed = threading.Event(), threading.Event()
    published, commit = asyncio.Event(), asyncio.Event()
    original = storage._validate

    def validate(**kwargs: Any) -> StoredMedia:
        validating.set()
        assert proceed.wait(10)
        return original(**kwargs)

    monkeypatch.setattr(storage, "_validate", validate)

    async def writer() -> StoredMedia:
        async with storage.transaction(True):
            media = await storage.save_upload(photo())
            assert storage.mutation_lock.locked()
            assert storage.resolve(media.storage_path).is_file()
            published.set()
            await commit.wait()
            return media

    task = asyncio.create_task(writer())
    try:
        assert await asyncio.to_thread(validating.wait, 10)
        # The archive's shared lock remains available during expensive inspection.
        await asyncio.wait_for(storage.mutation_lock.acquire(), 1)
        storage.mutation_lock.release()
        proceed.set()
        await asyncio.wait_for(published.wait(), 10)
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(storage.mutation_lock.acquire(), 0.05)
        commit.set()
        await task
        assert not storage.mutation_lock.locked()
        assert not list(storage.temp_root.iterdir())
    finally:
        proceed.set()
        commit.set()
        await asyncio.gather(task, return_exceptions=True)


async def test_cancelled_validation_finishes_before_temp_cleanup(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    storage = LocalMediaStorage(tmp_path)
    validating, proceed, finished = threading.Event(), threading.Event(), threading.Event()
    original = storage._validate

    def validate(**kwargs: Any) -> StoredMedia:
        validating.set()
        assert proceed.wait(10)
        result = original(**kwargs)
        finished.set()
        return result

    monkeypatch.setattr(storage, "_validate", validate)

    async def writer() -> None:
        async with storage.transaction(True):
            await storage.save_upload(photo())

    task = asyncio.create_task(writer())
    try:
        assert await asyncio.to_thread(validating.wait, 10)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        assert list(storage.temp_root.iterdir())
        proceed.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert finished.is_set()
        assert not list(storage.temp_root.iterdir())
        assert not list(storage.asset_root.rglob("*.png"))
        assert not storage.mutation_lock.locked()
    finally:
        proceed.set()
        await asyncio.gather(task, return_exceptions=True)


async def test_parallel_identical_uploads_preserve_shared_file(tmp_path: Path) -> None:
    storage = LocalMediaStorage(tmp_path)

    async def writer() -> StoredMedia:
        async with storage.transaction(True):
            return await storage.save_upload(photo())

    first, second = await asyncio.gather(writer(), writer())
    assert first.id != second.id
    assert first.storage_path == second.storage_path
    assert storage.resolve(first.storage_path).is_file()
    assert not list(storage.temp_root.iterdir())
    assert not storage.mutation_lock.locked()


async def test_repeated_cancellation_does_not_release_publication_lock_early(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    storage = LocalMediaStorage(tmp_path)
    publishing, proceed = threading.Event(), threading.Event()
    original = storage._publish

    def publish(path: Path, media: StoredMedia) -> StoredMedia:
        publishing.set()
        assert proceed.wait(10)
        return original(path, media)

    monkeypatch.setattr(storage, "_publish", publish)

    async def writer() -> None:
        async with storage.transaction(True):
            await storage.save_upload(photo())

    task = asyncio.create_task(writer())
    try:
        assert await asyncio.to_thread(publishing.wait, 10)
        for _ in range(2):
            task.cancel()
            await asyncio.sleep(0)
        assert not task.done()
        assert storage.mutation_lock.locked()
        proceed.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not storage.mutation_lock.locked()
        assert not list(storage.temp_root.iterdir())
    finally:
        proceed.set()
        await asyncio.gather(task, return_exceptions=True)
