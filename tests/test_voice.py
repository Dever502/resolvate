from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiogram.types import Message

from resolvate.archive_media_policy import forbidden_attachment
from resolvate.media_storage import StoredMedia
from resolvate.telegram_attachments import save_attachment
from resolvate.voice_inspect import inspect_voice


def ogg_page(number: int, flags: int, body: bytes) -> bytes:
    # Probe is mocked in these container-boundary tests; real decoding is checked
    # with ffprobe by the application's isolated media inspection process.
    return (
        b"OggS\0"
        + bytes([flags])
        + b"\0" * 8
        + b"test"
        + number.to_bytes(4, "little")
        + b"\0" * 4
        + bytes([1, len(body)])
        + body
    )


def voice_bytes() -> bytes:
    head = b"OpusHead" + bytes([1, 1]) + b"\0" * 9
    return ogg_page(0, 2, head) + ogg_page(1, 0, b"OpusTags") + ogg_page(2, 4, b"audio")


@pytest.fixture
def recording(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(
        "resolvate.voice_inspect.probe",
        lambda *a, **kw: {
            "streams": [{"codec_type": "audio", "codec_name": "opus", "channels": 1}],
            "format": {"duration": "1.0"},
        },
    )
    path = tmp_path / "voice.ogg"
    path.write_bytes(voice_bytes())
    return path


def test_voice_accepts_one_complete_opus_stream(recording: Path) -> None:
    assert inspect_voice(recording) == "audio/ogg"
    assert not forbidden_attachment("voice", None)
    assert not forbidden_attachment("document", "message.ogg")


@pytest.mark.parametrize(
    "content",
    [
        b"OggS",
        voice_bytes()[:-1],
        voice_bytes() + b"PK\x03\x04archive",
        voice_bytes() * 2,
        voice_bytes().replace(b"OpusHead", b"Vorbis!!"),
        voice_bytes().replace(b"test", b"new!", 1),
    ],
)
def test_voice_rejects_truncated_chained_or_disguised_files(
    recording: Path, content: bytes
) -> None:
    recording.write_bytes(content)
    with pytest.raises(ValueError):
        inspect_voice(recording)


@pytest.mark.parametrize("duration", ["nan", "inf", "0", "-1", "3601"])
def test_voice_duration_is_bounded(
    recording: Path, monkeypatch: pytest.MonkeyPatch, duration: str
) -> None:
    monkeypatch.setattr(
        "resolvate.voice_inspect.probe",
        lambda *a, **kw: {
            "streams": [{"codec_type": "audio", "codec_name": "opus", "channels": 1}],
            "format": {"duration": duration},
        },
    )
    with pytest.raises(ValueError):
        inspect_voice(recording)


async def test_telegram_voice_uses_same_validated_storage_as_uploads() -> None:
    message = Message.model_validate(
        {
            "message_id": 1,
            "date": 100,
            "chat": {"id": 42, "type": "private"},
            "voice": {
                "file_id": "voice-file",
                "file_unique_id": "voice-unique",
                "duration": 1,
                "file_size": 1000,
                "mime_type": "audio/ogg",
            },
        }
    )
    media = StoredMedia("voice", "web-media/assets/voice.ogg", "audio/ogg", 1000, "digest", None)
    storage = SimpleNamespace(save_telegram_file=AsyncMock(return_value=media))
    bot = AsyncMock()
    assert await save_attachment(message, bot, storage) is media  # type: ignore[arg-type]
    storage.save_telegram_file.assert_awaited_once_with(
        bot,
        file_id="voice-file",
        declared_mime="audio/ogg",
        filename=None,
    )
    assert media.delivery_kind == "send_voice"
    assert media.message_metadata()["type"] == "voice"
