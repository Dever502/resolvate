from __future__ import annotations

import asyncio
import hashlib
import io
import os
import subprocess
import sys
import uuid
import warnings
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Protocol

from PIL import Image, UnidentifiedImageError
from starlette.datastructures import UploadFile

from resolvate.archive_media_storage import ArchiveMediaStorage

MAX_WEB_PHOTO_BYTES = 20 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 64 * 1024
ALLOWED_PHOTO_MIME_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})
MIME_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "audio/ogg": ".ogg",
}
PILLOW_FORMAT_MIME_TYPES = {
    "JPEG": "image/jpeg",
    "PNG": "image/png",
    "WEBP": "image/webp",
}
MAX_TELEGRAM_PHOTO_DIMENSION_SUM = 10_000
MAX_TELEGRAM_PHOTO_ASPECT_RATIO = 20


class TelegramDownloader(Protocol):
    async def download(self, file: str, destination: Path | BinaryIO) -> object: ...


class LimitedDownload(io.BufferedRandom):
    def write(self, data: Any) -> int:
        if self.tell() + len(data) > MAX_WEB_PHOTO_BYTES:
            raise MediaValidationError("Файл больше 20 МБ.")
        return super().write(data)


class MediaValidationError(ValueError):
    pass


@dataclass(frozen=True)
class StoredMedia:
    id: str
    storage_path: str
    mime_type: str
    size_bytes: int
    sha256: str
    original_filename: str | None

    @property
    def delivery_kind(self) -> str:
        if self.mime_type == "audio/ogg":
            return "send_voice"
        if self.mime_type.startswith("video/"):
            return "send_video"
        if self.mime_type.startswith("image/") and self.size_bytes <= 10 * 1024 * 1024:
            return "send_photo"
        return "send_document"

    def message_metadata(self) -> dict[str, object]:
        return {
            "type": (
                "voice"
                if self.mime_type == "audio/ogg"
                else "photo"
                if self.mime_type.startswith("image/")
                else "video"
                if self.mime_type.startswith("video/")
                else "document"
            ),
            "media_id": self.id,
            "mime_type": self.mime_type,
            "size_bytes": self.size_bytes,
            "sha256": self.sha256,
        }


def _detected_mime(header: bytes) -> str | None:
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "image/webp"
    return None


def _decoded_photo_mime(path: Path) -> str:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                image_format = image.format
                width, height = image.size
                if image_format not in PILLOW_FORMAT_MIME_TYPES:
                    raise MediaValidationError("unsupported photo format")
                if width <= 0 or height <= 0:
                    raise MediaValidationError("photo dimensions are invalid")
                if width + height > MAX_TELEGRAM_PHOTO_DIMENSION_SUM:
                    raise MediaValidationError("photo dimensions are too large")
                if max(width, height) / min(width, height) > MAX_TELEGRAM_PHOTO_ASPECT_RATIO:
                    raise MediaValidationError("photo aspect ratio is too large")
                if getattr(image, "n_frames", 1) != 1:
                    raise MediaValidationError("animated photos are not supported")
                image.verify()
            with Image.open(path) as image:
                image.load()
    except MediaValidationError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise MediaValidationError("photo dimensions are too large") from error
    except (OSError, UnidentifiedImageError) as error:
        raise MediaValidationError("photo is corrupted or incomplete") from error

    return PILLOW_FORMAT_MIME_TYPES[image_format]


class LocalMediaStorage:
    def __init__(self, data_dir: Path, *, capacity: ArchiveMediaStorage | None = None) -> None:
        self.capacity = capacity
        self.data_dir = data_dir.resolve()
        self.root = self.data_dir / "web-media"
        self.temp_root = self.root / "tmp"
        self.asset_root = self.root / "assets"
        self.validation_slots = asyncio.Semaphore(2)
        self.mutation_lock = asyncio.Lock()

    @asynccontextmanager
    async def transaction(self, has_file: bool) -> AsyncIterator[None]:
        # Keep publication and the DB reference together relative to archive unlink/compression.
        # Text-only work does not wait for file processing.
        if has_file:
            async with self.mutation_lock:
                yield
        else:
            yield

    def _prepare(self) -> None:
        self.temp_root.mkdir(parents=True, exist_ok=True)
        self.asset_root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _inspect(temp_path: Path) -> tuple[int, bytes, str]:
        size = temp_path.stat().st_size
        with temp_path.open("rb") as source:
            header = source.read(16)
            digest = hashlib.sha256(header)
            while chunk := source.read(UPLOAD_CHUNK_BYTES):
                digest.update(chunk)
        return size, header, digest.hexdigest()

    @staticmethod
    def _write_chunk(destination: BinaryIO, chunk: bytes) -> None:
        destination.write(chunk)

    def _finalize(
        self,
        *,
        temp_path: Path,
        media_id: str,
        declared_mime: str | None,
        original_filename: str | None,
        inspection: tuple[int, bytes, str] | None = None,
    ) -> StoredMedia:
        size, header, sha256 = self._inspect(temp_path) if inspection is None else inspection
        if size == 0:
            temp_path.unlink(missing_ok=True)
            raise MediaValidationError("⚠️ Файл пустой. Отправьте другой файл.")
        if size > MAX_WEB_PHOTO_BYTES:
            temp_path.unlink(missing_ok=True)
            raise MediaValidationError("⚠️ Файл больше 20 МБ. Отправьте файл меньшего размера.")
        try:
            result = subprocess.run(
                [sys.executable, "-m", "resolvate.media_inspect", str(temp_path)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=20,
                check=True,
                env={
                    "PATH": os.defpath,
                    "PYTHONPATH": str(Path(__file__).parent.parent),
                    "PYTHONDONTWRITEBYTECODE": "1",
                },
            )
            detected_mime = result.stdout.decode().strip()
            if detected_mime not in MIME_EXTENSIONS:
                raise ValueError("unsupported media")
        except (subprocess.SubprocessError, ValueError, OSError) as error:
            temp_path.unlink(missing_ok=True)
            raise MediaValidationError(
                "Файл не прошёл проверку. "
                "Допустимы фото, MP4/MOV, PDF и голосовые OGG/Opus до 20 МБ."
            ) from error
        if detected_mime == "audio/ogg" and declared_mime in {"application/ogg", "audio/opus"}:
            declared_mime = "audio/ogg"
        if declared_mime and declared_mime.casefold() not in {
            detected_mime,
            "application/octet-stream",
        }:
            temp_path.unlink(missing_ok=True)
            raise MediaValidationError("⚠️ Содержимое файла не соответствует заявленному формату.")
        relative = (
            Path("web-media") / "assets" / sha256[:2] / (sha256 + MIME_EXTENSIONS[detected_mime])
        )
        destination = self.data_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Immutable content-addressed files; publishing another reference never replaces bytes.
        with temp_path.open("rb") as source:
            os.fsync(source.fileno())
        try:
            os.link(temp_path, destination)
        except FileExistsError:
            actual_size, _, actual_digest = self._inspect(destination)
            if actual_size != size or actual_digest != sha256 or destination.is_symlink():
                raise MediaValidationError("Повреждена сохранённая копия файла.") from None
        temp_path.unlink()
        return StoredMedia(
            id=media_id,
            storage_path=relative.as_posix(),
            mime_type=detected_mime,
            size_bytes=size,
            sha256=sha256,
            original_filename=(Path(original_filename).name[:255] if original_filename else None),
        )

    async def save_upload(self, upload: UploadFile) -> StoredMedia:
        async with self.validation_slots:
            return await self._save_reserved_upload(upload)

    async def _save_reserved_upload(self, upload: UploadFile) -> StoredMedia:
        if self.capacity is not None:
            try:
                async with self.capacity.reserve(MAX_WEB_PHOTO_BYTES):
                    return await self._save_upload(upload)
            finally:
                await upload.close()
        return await self._save_upload(upload)

    async def _save_upload(self, upload: UploadFile) -> StoredMedia:
        await asyncio.to_thread(self._prepare)
        media_id = str(uuid.uuid4())
        temp_path = self.temp_root / f"{media_id}.upload"
        size = 0
        header = bytearray()
        digest = hashlib.sha256()
        destination: BinaryIO | None = None
        try:
            destination = await asyncio.to_thread(temp_path.open, "xb")
            while chunk := await upload.read(UPLOAD_CHUNK_BYTES):
                size += len(chunk)
                if size > MAX_WEB_PHOTO_BYTES:
                    raise MediaValidationError("photo is too large")
                if len(header) < 16:
                    header.extend(chunk[: 16 - len(header)])
                await asyncio.to_thread(self._write_chunk, destination, chunk)
                digest.update(chunk)
            await asyncio.to_thread(destination.close)
            return await asyncio.to_thread(
                self._finalize,
                temp_path=temp_path,
                media_id=media_id,
                declared_mime=upload.content_type,
                original_filename=upload.filename,
                inspection=(size, bytes(header), digest.hexdigest()),
            )
        except BaseException:
            if destination is not None:
                await asyncio.to_thread(destination.close)
            await asyncio.to_thread(temp_path.unlink, missing_ok=True)
            raise
        finally:
            await upload.close()

    async def save_telegram_photo(self, bot: TelegramDownloader, *, file_id: str) -> StoredMedia:
        if self.capacity is not None:
            async with self.capacity.reserve(MAX_WEB_PHOTO_BYTES):
                return await self._save_telegram_photo(bot, file_id=file_id)
        return await self._save_telegram_photo(bot, file_id=file_id)

    async def save_telegram_file(
        self,
        bot: TelegramDownloader,
        *,
        file_id: str,
        declared_mime: str | None,
        filename: str | None,
    ) -> StoredMedia:
        async with self.validation_slots:
            if self.capacity is not None:
                async with self.capacity.reserve(MAX_WEB_PHOTO_BYTES):
                    return await self._download_file(bot, file_id, declared_mime, filename)
            return await self._download_file(bot, file_id, declared_mime, filename)

    async def _download_file(
        self, bot: TelegramDownloader, file_id: str, declared_mime: str | None, filename: str | None
    ) -> StoredMedia:
        await asyncio.to_thread(self._prepare)
        media_id = str(uuid.uuid4())
        temp_path = self.temp_root / f"{media_id}.telegram"
        try:
            with LimitedDownload(io.FileIO(temp_path, "x+")) as destination:
                await bot.download(file_id, destination=destination)
                destination.flush()
            return await asyncio.to_thread(
                self._finalize,
                temp_path=temp_path,
                media_id=media_id,
                declared_mime=declared_mime,
                original_filename=filename,
            )
        finally:
            await asyncio.to_thread(temp_path.unlink, missing_ok=True)

    async def _save_telegram_photo(self, bot: TelegramDownloader, *, file_id: str) -> StoredMedia:
        await asyncio.to_thread(self._prepare)
        media_id = str(uuid.uuid4())
        temp_path = self.temp_root / f"{media_id}.telegram"
        try:
            await bot.download(file_id, destination=temp_path)
            return await asyncio.to_thread(
                self._finalize,
                temp_path=temp_path,
                media_id=media_id,
                declared_mime="image/jpeg",
                original_filename=None,
            )
        except BaseException:
            await asyncio.to_thread(temp_path.unlink, missing_ok=True)
            raise

    def resolve(self, storage_path: str) -> Path:
        candidate = (self.data_dir / storage_path).resolve()
        roots = (self.asset_root.resolve(), (self.data_dir / "transcript-media").resolve())
        if not any(candidate.is_relative_to(root) and candidate != root for root in roots):
            raise MediaValidationError("invalid media path")
        return candidate

    async def resolve_file(self, storage_path: str) -> Path | None:
        def resolve_existing_file() -> Path | None:
            path = self.resolve(storage_path)
            return path if path.is_file() else None

        return await asyncio.to_thread(resolve_existing_file)

    async def delete(self, media: StoredMedia) -> None:
        # New content-addressed assets can already be referenced by another message.
        # Only reference-aware orphan cleanup may unlink these files.
        if len(Path(media.storage_path).stem) == 64:
            return

        def delete_file() -> None:
            self.resolve(media.storage_path).unlink(missing_ok=True)

        await asyncio.to_thread(delete_file)
