from __future__ import annotations

import gzip
import io
import json
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from aiogram.methods import SendSticker
from aiogram.types import Message
from PIL import Image
from sqlalchemy import select
from starlette.datastructures import UploadFile
from test_console import console as console

from resolvate.archive_media_policy import forbidden_attachment
from resolvate.config import Settings
from resolvate.delivery import DeliveryWorker
from resolvate.media_storage import LocalMediaStorage, MediaValidationError
from resolvate.models import DeliveryOutbox, Direction, TicketMessage, TranscriptMedia, utcnow
from resolvate.sticker_inspect import TGS_MIME, inspect_sticker, validate_tgs, validate_webm
from resolvate.telegram_attachments import save_attachment
from resolvate.telegram_limits import TelegramRateLimiter
from resolvate.telegram_message_utils import media_metadata, operator_reply_snapshot
from resolvate.topic_archive import TopicArchiveRepository


def animation() -> dict[str, Any]:
    return {
        "v": "5.5.2",
        "tgs": 1,
        "fr": 60,
        "ip": 0,
        "op": 120,
        "w": 512,
        "h": 512,
        "assets": [],
        "layers": [],
    }


def packed(value: Any) -> bytes:
    return gzip.compress(json.dumps(value).encode())


def picture() -> bytes:
    output = io.BytesIO()
    Image.new("RGBA", (512, 512), (50, 70, 180, 180)).save(output, "WEBP", lossless=True)
    return output.getvalue()


def message(kind: str, size: int = 100) -> Message:
    return Message.model_validate(
        {
            "message_id": 901,
            "date": 1791300000,
            "chat": {"id": 42, "type": "private"},
            "from_user": {"id": 42, "is_bot": False, "first_name": "Customer"},
            "sticker": {
                "file_id": f"sticker-{kind}",
                "file_unique_id": f"unique-{kind}",
                "type": "regular",
                "width": 512,
                "height": 512,
                "emoji": "🙂",
                "is_animated": kind == "animated",
                "is_video": kind == "video",
                "file_size": size,
            },
        }
    )


class Downloader:
    def __init__(self, data: bytes) -> None:
        self.data = data

    async def download(self, file: str, destination: Any) -> None:
        destination.write(self.data)


def test_tgs_accepts_bounded_vector_animation() -> None:
    assert validate_tgs(packed(animation())) == animation()
    assert not forbidden_attachment("sticker", None)
    assert forbidden_attachment("document", "archive.tgs")
    assert forbidden_attachment("document", "movie.webm")


@pytest.mark.parametrize(
    "changes",
    [
        {"w": 4096},
        {"op": 181},
        {"fr": 0},
        {"fr": float("inf")},
        {"assets": [{"id": "image", "p": "https://example.org/image.png"}]},
        {"x": "alert(1)"},
        {"fonts": {}},
        {"ef": []},
        {"__proto__": {}},
        {"layers": [{"ind": 1, "ty": 2}]},
        {"layers": [{"ind": 1, "ty": 4, "w": 999999}]},
        {"layers": [{"ind": 1, "ty": 4, "parent": 1}]},
        {"layers": [{"ind": 1, "ty": 4, "parent": 2}]},
        {"layers": [{"ind": 1, "ty": 4, "shapes": [{"ty": "rp", "c": {"k": 99999}}]}]},
        {
            "layers": [{"ind": 1, "ty": 0, "refId": "a"}],
            "assets": [{"id": "a", "layers": [{"ind": 1, "ty": 0, "refId": "a"}]}],
        },
        {"nm": "x" * 2048},
        {"extra": [0] * 4097},
    ],
)
def test_tgs_rejects_unsafe_or_expensive_features(changes: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        validate_tgs(packed({**animation(), **changes}))


@pytest.mark.parametrize(
    "data",
    [
        b"not gzip",
        packed(animation())[:-2],
        packed(animation()) + b"PK\x03\x04",
        packed(animation()) * 2,
        gzip.compress(b" " * (2 * 1024 * 1024 + 1)),
        packed([]),
    ],
)
def test_tgs_rejects_truncated_appended_and_expansion_bombs(data: bytes) -> None:
    with pytest.raises((ValueError, OSError)):
        validate_tgs(data)


@pytest.mark.parametrize(
    "kind,data,mime",
    [
        ("static", picture(), "image/webp"),
        ("animated", packed(animation()), TGS_MIME),
    ],
)
async def test_real_sticker_storage_and_upload_boundary(
    tmp_path: Path, kind: str, data: bytes, mime: str
) -> None:
    storage = LocalMediaStorage(tmp_path)
    saved = await save_attachment(message(kind, len(data)), Downloader(data), storage)  # type: ignore[arg-type]
    assert saved and saved.mime_type == mime
    assert storage.resolve(saved.storage_path).read_bytes() == data
    duplicate = await save_attachment(message(kind, len(data)), Downloader(data), storage)  # type: ignore[arg-type]
    assert duplicate and duplicate.id != saved.id and duplicate.storage_path == saved.storage_path
    if kind == "animated":
        with pytest.raises(MediaValidationError):
            await storage.save_upload(UploadFile(io.BytesIO(data), filename="animation.tgs"))
    with pytest.raises(MediaValidationError):
        await save_attachment(message(kind, len(data)), Downloader(data + b"ZIP"), storage)  # type: ignore[arg-type]
    assert not list(storage.temp_root.iterdir())


async def test_invalid_sticker_metadata_rejected_without_download(tmp_path: Path) -> None:
    bot = AsyncMock()
    with pytest.raises(MediaValidationError):
        await save_attachment(message("animated", 65537), bot, LocalMediaStorage(tmp_path))
    bot.download.assert_not_called()


@pytest.mark.parametrize("kind", ["static", "animated", "video"])
async def test_operator_snapshot_preserves_sticker(kind: str) -> None:
    original = message(kind)
    canonical = TicketMessage(
        id="test",
        ticket_id="test",
        direction=Direction.OPERATOR_TO_USER,
        source_chat_id=42,
        source_message_id=901,
        created_at=utcnow(),
        media=media_metadata(original),
    )
    snapshot = operator_reply_snapshot(canonical)
    bot = AsyncMock(return_value=SimpleNamespace(message_id=999))
    worker = DeliveryWorker.__new__(DeliveryWorker)
    worker.bot = bot
    assert await worker._send_snapshot({"snapshot": snapshot, "target_chat_id": 42}, None) == 999
    sent = bot.call_args.args[0]
    assert isinstance(sent, SendSticker) and sent.sticker == original.sticker.file_id


@pytest.mark.parametrize(
    "changes",
    [
        {"codec_name": "h264"},
        {"width": 1024},
        {"height": 0},
        {"avg_frame_rate": "60/1"},
    ],
)
def test_video_sticker_checks_codec_and_dimensions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, changes: dict[str, Any]
) -> None:
    path = tmp_path / "sticker.webm"
    path.write_bytes(b"\x1a\x45\xdf\xa3\x87\x42\x82\x84webm\x18\x53\x80\x67\x80")
    info = {
        "streams": [
            {
                "codec_type": "video",
                "codec_name": "vp9",
                "width": 512,
                "height": 512,
                "avg_frame_rate": "30/1",
            }
        ],
        "format": {"duration": "2"},
    }
    monkeypatch.setattr("resolvate.sticker_inspect.probe", lambda *a, **kw: info)
    assert inspect_sticker(path, "video") == "video/webm"
    info["streams"][0].update(changes)
    with pytest.raises(ValueError):
        inspect_sticker(path, "video")


async def test_sticker_history_media_and_durable_topic_delivery(console: Any) -> None:
    client, database, tickets, _, _, storage = console
    data = packed(animation())
    original = message("animated", len(data))
    saved = await save_attachment(original, Downloader(data), storage)  # type: ignore[arg-type]
    result = await tickets.accept_customer_message(
        telegram_user_id=42,
        display_name="Customer",
        username=None,
        source_chat_id=42,
        source_message_id=901,
        target_chat_id=-100123456,
        content=None,
        media=media_metadata(original),
        stored_media=saved,
    )
    page = (await client.post(f"/console/tickets/{result.ticket.id}/sync", json={})).json()
    item = page["items"][0]
    assert item["sticker"] and item["mime"] == TGS_MIME and item["sticker_emoji"] == "🙂"
    response = await client.get(f"/console/media/{item['media_id']}")
    assert response.status_code == 200 and response.json() == animation()
    assert response.headers["content-encoding"] == "gzip"
    assert response.headers["x-content-type-options"] == "nosniff"
    async with database.session() as session:
        jobs = list(
            (
                await session.scalars(select(DeliveryOutbox).order_by(DeliveryOutbox.created_at))
            ).all()
        )
        assert [job.payload["kind"] for job in jobs] == ["send_text", "send_sticker"]
        assert "КЛИЕНТ" in jobs[0].payload["text"]
        assert jobs[1].payload["file_id"] == original.sticker.file_id
        assert jobs[0].created_at < jobs[1].created_at
    token = await tickets.claim_topic_provisioning(result.ticket.id)
    await tickets.attach_topic(result.ticket.id, 123, token=token)
    settings = Settings(
        _env_file=None,
        support_bot_token="123456:TEST",
        support_group_id=-100123456,
        data_dir=storage.data_dir,
    )
    bot = AsyncMock()
    bot.send_message.return_value = SimpleNamespace(message_id=902)
    bot.send_sticker.return_value = SimpleNamespace(message_id=903)
    worker = DeliveryWorker(
        bot=bot,
        ticket_service=tickets,
        outbox=tickets.outbox,
        settings=settings,
        limiter=TelegramRateLimiter(0),
        heartbeat_path=storage.data_dir / "heartbeat",
        recover_missing_topic=AsyncMock(),
    )
    for _ in range(2):
        claimed = await tickets.outbox.claim_due_deliveries()
        assert len(claimed) == 1
        await worker._deliver(claimed[0])
    bot.send_sticker.assert_awaited_once_with(
        chat_id=-100123456,
        sticker=original.sticker.file_id,
        message_thread_id=123,
    )
    archives = TopicArchiveRepository(database, settings)
    await archives.register_topic(ticket_id=result.ticket.id, topic_id=123, complete=True)
    await archives.observe(
        topic_id=123,
        message_id=903,
        payload={**original.model_dump(mode="json"), "canonical_message_id": item["id"]},
        attachment=media_metadata(original),
    )
    async with database.session() as session:
        archived = await session.scalar(select(TranscriptMedia))
        assert archived and archived.kind == "sticker" and archived.state == "stored"
        assert archived.storage_path == saved.storage_path
    await client.post("/console/logout")
    assert (await client.get(f"/console/media/{item['media_id']}")).status_code == 401


def test_lottie_dependency_is_pinned_light_and_locally_licensed() -> None:
    assets = Path(__file__).resolve().parents[1] / "src/resolvate/console_assets"
    player = (assets / "lottie_light_canvas.js").read_bytes()
    assert (
        sha256(player).hexdigest()
        == "0930bfecb5b5dad59dd9049a139fa957e57f70e0805fc94a311204e524e45e28"
    )
    assert b"eval(" not in player and b"new Function" not in player
    assert "MIT" in (assets / "lottie_license.txt").read_text()


@pytest.mark.parametrize("extra", [b"PK\x03\x04", b"\x19\x41\xa4\x69\x80", b"\0"])
def test_webm_rejects_appended_data_and_attachments(extra: bytes) -> None:
    header = b"\x1a\x45\xdf\xa3\x87\x42\x82\x84webm\x18\x53\x80\x67"
    with pytest.raises(ValueError):
        validate_webm(header + b"\x80" + extra)
    with pytest.raises(ValueError):
        validate_webm(header + b"\xff" + extra)
