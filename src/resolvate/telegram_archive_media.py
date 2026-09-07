from __future__ import annotations

import asyncio
import logging
from typing import BinaryIO

from aiogram import Bot
from aiogram.exceptions import TelegramAPIError
from aiogram.types import File
from sqlalchemy import select

from resolvate.archive_media_policy import (
    CLOUD_DOWNLOAD_LIMIT_BYTES,
    SKIPPED_CLOUD_LIMIT,
    may_skip_media,
)
from resolvate.archive_media_storage import ArchiveMediaStorage
from resolvate.models import TopicArchive, TranscriptMedia, TranscriptMessage
from resolvate.topic_archive import TopicArchiveRepository

logger = logging.getLogger(__name__)


class TelegramArchiveDownloader:
    def __init__(self, bot: Bot, size: int, resolved: File | None = None) -> None:
        self.bot = bot
        self.size = size
        self.resolved = resolved

    async def download(self, file: str, destination: BinaryIO, **kwargs: object) -> object:
        metadata = self.resolved or await self.bot.get_file(file, request_timeout=120)
        if metadata.file_size is not None and metadata.file_size != self.size:
            raise ValueError("Telegram attachment size changed during preparation")
        if not metadata.file_path:
            raise ValueError("Telegram attachment has no downloadable path")
        return await self.bot.download_file(
            metadata.file_path, destination=destination, timeout=120, seek=False
        )


class TelegramArchiveMedia:
    """Prepare files before the DB cutover; failures never authorize a skip.

    A single process serializes preparation. The actual topic switch must still
    recheck its revision and pending writes after this potentially slow operation.
    """

    def __init__(
        self, repository: TopicArchiveRepository, bot: Bot, storage: ArchiveMediaStorage
    ) -> None:
        self.repository = repository
        self.bot = bot
        self.storage = storage
        self._lock = asyncio.Lock()

    async def prepare_archive(self, archive_id: str) -> bool:
        async with self._lock:
            async with self.repository.database.session() as session:
                archive = await session.get(TopicArchive, archive_id)
                if archive is None or archive.state not in {
                    "preparing",
                    "retiring",
                    "evicting",
                    "archived_pending",
                }:
                    return False
            try:
                after = ""
                while True:
                    async with self.repository.database.session() as session:
                        rows = list(
                            (
                                await session.scalars(
                                    select(TranscriptMedia)
                                    .where(
                                        TranscriptMedia.id > after,
                                        TranscriptMedia.id.in_(
                                            select(TranscriptMessage.media_id).where(
                                                TranscriptMessage.archive_id == archive_id
                                            )
                                        ),
                                    )
                                    .order_by(TranscriptMedia.id)
                                    .limit(100)
                                )
                            ).all()
                        )
                    if not rows:
                        break
                    for row in rows:
                        await self._prepare_file(row)
                    after = rows[-1].id
                return await self.repository.media_ready(archive_id)
            except (TelegramAPIError, OSError, ValueError, TimeoutError) as error:
                # Exception messages can contain bot tokens, paths or remote response bodies.
                logger.warning(
                    "Archive media preparation deferred",
                    extra={
                        "event": "archive_media_deferred",
                        "archive_id": archive_id,
                        "exception_type": type(error).__name__,
                    },
                )
                await self.repository.notice(
                    "archive_media_unavailable",
                    "Не удалось сохранить вложения архива. Ротация отложена; топик сохранён.",
                )
                return False

    async def _prepare_file(self, row: TranscriptMedia) -> None:
        if (
            row.state == "stored"
            and row.storage_path
            and row.sha256
            and await self.storage.verify(
                row.storage_path, size_bytes=row.size_bytes, sha256=row.sha256
            )
        ):
            return
        size = row.declared_size
        metadata = None
        if size is None:
            metadata = await self.bot.get_file(row.file_id, request_timeout=30)
            size = metadata.file_size
        if size is None or size <= 0:
            raise ValueError("Telegram attachment has no valid size")
        if may_skip_media(size=size):
            async with self.repository.database.session() as session:
                current = await session.get(TranscriptMedia, row.id, with_for_update=True)
                assert current is not None
                current.declared_size = size
                current.state = SKIPPED_CLOUD_LIMIT
                await session.commit()
            return
        saved = await self.storage.download(
            TelegramArchiveDownloader(self.bot, size, metadata),
            file_id=row.file_id,
            max_bytes=CLOUD_DOWNLOAD_LIMIT_BYTES,
            expected_bytes=size,
        )
        async with self.repository.media_lock, self.repository.database.session() as session:
            current = await session.get(TranscriptMedia, row.id, with_for_update=True)
            assert current is not None
            if current.storage_path != row.storage_path or current.state != row.state:
                # Cleanup/publication won the race; retry against the new metadata.
                await asyncio.to_thread(self.storage.resolve(saved.path).unlink, missing_ok=True)
                raise ValueError("archive media changed during download")
            current.state = "stored"
            current.declared_size = size
            current.storage_path = saved.path
            current.size_bytes = saved.size_bytes
            current.sha256 = saved.sha256
            current.compressed_at = None
            current.deleted_at = None
            await session.commit()
