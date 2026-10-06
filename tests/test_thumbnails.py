from __future__ import annotations

import asyncio
import io
import threading
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException
from PIL import Image
from sqlalchemy import delete
from test_console import console as console
from test_console import customer

from resolvate.models import ProjectMember
from resolvate.thumbnail_inspect import thumbnail
from resolvate.thumbnails import CACHE_BYTES, CACHE_ITEMS, Thumbnails
from resolvate.web_models import MediaAsset


def photo() -> bytes:
    result = io.BytesIO()
    Image.new("RGB", (2400, 1600), "blue").save(result, "JPEG", quality=95)
    return result.getvalue()


def test_thumbnail_dimensions_format_and_metadata(tmp_path: Path) -> None:
    path = tmp_path / "original.jpg"
    original = photo()
    path.write_bytes(original)
    small = thumbnail(path)
    with Image.open(io.BytesIO(small)) as image:
        assert image.format == "WEBP"
        assert image.size == (768, 512)
        assert "exif" not in image.info and "icc_profile" not in image.info
    assert len(small) < len(original) / 5
    assert path.read_bytes() == original


def test_thumbnail_preserves_orientation_and_palette_transparency(tmp_path: Path) -> None:
    path = tmp_path / "photo.jpg"
    exif = Image.Exif()
    exif[274] = 6
    Image.new("RGB", (100, 50), "red").save(path, exif=exif)
    with Image.open(io.BytesIO(thumbnail(path))) as result:
        assert result.size == (50, 100)
        assert "exif" not in result.info
    path = tmp_path / "palette.png"
    Image.new("P", (10, 10), 0).save(path, transparency=0)
    with Image.open(io.BytesIO(thumbnail(path))) as result:
        assert result.convert("RGBA").getpixel((0, 0))[3] == 0


@pytest.mark.parametrize("payload", [b"not an image", b"%PDF-1.4\n%%EOF", b"PK\x03\x04"])
def test_thumbnail_rejects_non_images(tmp_path: Path, payload: bytes) -> None:
    path = tmp_path / "input"
    path.write_bytes(payload)
    with pytest.raises((ValueError, OSError)):
        thumbnail(path)


async def test_thumbnail_cache_single_flight_and_bounds(monkeypatch: pytest.MonkeyPatch) -> None:
    cache = Thumbnails()
    calls = 0

    def generate(path: Path) -> bytes:
        nonlocal calls
        calls += 1
        return b"x" * (256 * 1024)

    monkeypatch.setattr(cache, "_generate", generate)
    await asyncio.gather(*(cache.get("same", Path("unused")) for _ in range(5)))
    assert calls == 1
    for index in range(CACHE_ITEMS + 1):
        await cache.get(str(index), Path("unused"))
    assert cache.size <= CACHE_BYTES and len(cache.cache) <= CACHE_ITEMS
    assert "same" not in cache.cache


async def test_cancelled_request_keeps_decoder_slot(monkeypatch: pytest.MonkeyPatch) -> None:
    cache = Thumbnails()
    started = threading.Event()
    release = threading.Event()

    def generate(path: Path) -> bytes:
        started.set()
        assert release.wait(5)
        return b"test"

    monkeypatch.setattr(cache, "_generate", generate)
    task = asyncio.create_task(cache.get("key", Path("unused")))
    assert await asyncio.to_thread(started.wait, 5)
    task.cancel()
    await asyncio.sleep(0)
    assert cache.slot.locked()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not cache.slot.locked()


async def test_authorized_thumbnail_original_and_revocation(console: Any) -> None:
    client, database, tickets, _, actor, storage = console
    ticket_id = await customer(tickets)
    original = photo()
    response = await client.post(
        f"/console/tickets/{ticket_id}/send",
        files={"file": ("photo.jpg", original, "image/jpeg")},
        headers={"X-Idempotency-Key": str(uuid.uuid4())},
    )
    assert response.status_code == 200, response.text
    history = (await client.post(f"/console/tickets/{ticket_id}/sync", json={})).json()
    media = next(row for row in history["items"] if row["media_id"])
    url = f"/console/media/{media['media_id']}"
    small = await client.get(url + "/thumbnail")
    assert small.status_code == 200
    assert small.headers["content-type"] == "image/webp"
    assert small.headers["cache-control"] == "no-store"
    assert len(small.content) < len(original) / 5
    assert (await client.get(url)).content == original
    assert (await client.get(url + "/thumbnail")).content == small.content
    async with database.session() as session:
        asset = await session.get(MediaAsset, media["media_id"])
    path = await storage.resolve_file(asset.storage_path)
    path.unlink()
    assert (await client.get(url + "/thumbnail")).status_code == 410
    async with database.session() as session:
        await session.execute(delete(ProjectMember).where(ProjectMember.account_id == actor.id))
        await session.commit()
    assert (await client.get(url + "/thumbnail")).status_code == 403
    client.cookies.clear()
    assert (await client.get(url + "/thumbnail")).status_code == 401


def test_bounded_decoder_failure_is_safe(tmp_path: Path) -> None:
    path = tmp_path / "broken"
    path.write_bytes(b"not an image")
    with pytest.raises(HTTPException) as error:
        Thumbnails._generate(path)
    assert error.value.status_code == 503
