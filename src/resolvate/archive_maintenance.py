from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy import select

from resolvate.archive_media_policy import CLOUD_DOWNLOAD_LIMIT_BYTES
from resolvate.archive_media_storage import ArchiveMediaStorage
from resolvate.archive_retention import ArchiveRetention
from resolvate.models import TranscriptMedia, utcnow
from resolvate.runtime_supervision import wait_for_event
from resolvate.topic_archive import TopicArchiveRepository

logger = logging.getLogger(__name__)


class ArchiveMaintenance:
    """Bounded, restart-safe maintenance for the single application process."""

    def __init__(self, archives: TopicArchiveRepository, storage: ArchiveMediaStorage) -> None:
        self.archives = archives
        self.storage = storage
        self.settings = archives.settings
        self.retention = ArchiveRetention(archives)
        self._stopped = asyncio.Event()
        self._media_due: datetime | None = None
        self._text_due: datetime | None = None
        self._compression_after = ""

    def stop(self) -> None:
        self._stopped.set()

    async def run(self) -> None:
        while not self._stopped.is_set():
            try:
                await self.tick()
            except Exception as error:
                logger.warning(
                    "Archive maintenance deferred",
                    extra={
                        "event": "archive_maintenance_failed",
                        "exception_type": type(error).__name__,
                    },
                )
                try:
                    await self.archives.notice(
                        "archive_maintenance_failed", "Очистка архивов отложена из-за ошибки."
                    )
                except Exception:
                    # A database outage must not permanently stop this background worker.
                    logger.warning("Unable to persist archive maintenance incident")
            await wait_for_event(self._stopped, timeout_seconds=60)

    async def remove_media(self, media_id: str, before: datetime, now: datetime) -> bool:
        async with self.archives.media_lock:
            async with self.archives.database.session() as session:
                row = await self.retention.media_for_change(session, media_id, before)
                if row is None or not row.storage_path:
                    return False
                path = self.storage.resolve(row.storage_path)
                # Commit the tombstone first. A crash leaves an orphan, never a live DB
                # reference to a file intentionally removed by this operation.
                row.state = "deleted"
                row.deleted_at = now
                row.storage_path = None
                await session.commit()
            await asyncio.to_thread(path.unlink, missing_ok=True)
        return True

    async def compress_media(self, media_id: str, before: datetime, now: datetime) -> bool:
        async with self.archives.database.session() as session:
            row = await session.get(TranscriptMedia, media_id)
        if (
            row is None
            or row.kind not in {"photo", "video"}
            or not row.storage_path
            or row.compressed_at is not None
            or row.size_bytes <= 0
            or not row.sha256
        ):
            return False
        original = self.storage.resolve(row.storage_path)
        if not await self.storage.verify(
            row.storage_path, size_bytes=row.size_bytes, sha256=row.sha256
        ):
            await self.archives.notice(
                "archive_media_corrupt", "Проверка целостности архивного вложения не прошла."
            )
            return False
        key = uuid.uuid4().hex
        suffix = "webp" if row.kind == "photo" else "mp4"
        relative = f"transcript-media/{key[:2]}/{key}.{suffix}"
        destination = self.storage.resolve(relative)
        published = False
        process: asyncio.subprocess.Process | None = None
        try:
            async with self.storage.reserve(row.size_bytes):
                await asyncio.to_thread(destination.parent.mkdir, parents=True, exist_ok=True)
                process = await asyncio.create_subprocess_exec(
                    sys.executable,
                    "-m",
                    "resolvate.archive_compressor",
                    row.kind,
                    str(original),
                    str(destination),
                    str(row.size_bytes),
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                    start_new_session=True,
                    # Do not pass bot tokens, database credentials or other app secrets.
                    env={"PATH": os.defpath, "LANG": "C.UTF-8"},
                )
                await asyncio.wait_for(process.wait(), timeout=120)
                if process.returncode != 0:
                    return False
                result = await asyncio.to_thread(self.storage.inspect, destination)
                if not 0 < result.size_bytes < row.size_bytes:
                    return False
                await asyncio.to_thread(self._sync_file, destination)
                async with self.archives.media_lock:
                    async with self.archives.database.session() as session:
                        current = await self.retention.media_for_change(session, media_id, before)
                        if (
                            current is None
                            or current.storage_path != row.storage_path
                            or current.sha256 != row.sha256
                        ):
                            return False
                        current.storage_path = relative
                        current.size_bytes = result.size_bytes
                        current.sha256 = result.sha256
                        current.compressed_at = now
                        await session.commit()
                        published = True
                    await asyncio.to_thread(original.unlink, missing_ok=True)
                return True
        finally:
            if process is not None and process.returncode is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await process.wait()
            if not published:
                await asyncio.to_thread(destination.unlink, missing_ok=True)

    @staticmethod
    def _sync_file(path: Path) -> None:
        with path.open("rb") as stream:
            os.fsync(stream.fileno())

    async def cleanup_orphans(self, now: datetime) -> None:
        # All normal writers finish within minutes; 24 hours also covers crash leftovers.
        cutoff = now.timestamp() - 86400
        async with self.archives.media_lock:
            async with self.archives.database.session() as session:
                referenced = set(
                    (
                        await session.scalars(
                            select(TranscriptMedia.storage_path).where(
                                TranscriptMedia.storage_path.is_not(None)
                            )
                        )
                    ).all()
                )

            def cleanup() -> None:
                for path in self.storage.root.glob("*/*"):
                    if (
                        path.is_symlink()
                        or not path.is_file()
                        or path.suffix not in {".blob", ".part", ".webp", ".mp4"}
                    ):
                        continue
                    if path.relative_to(self.storage.data_dir).as_posix() in referenced:
                        continue
                    if path.stat().st_mtime < cutoff:
                        self.storage.resolve(
                            path.relative_to(self.storage.data_dir).as_posix()
                        ).unlink(missing_ok=True)

            await asyncio.to_thread(cleanup)

    async def tick(self, now: datetime | None = None) -> None:
        now = now or utcnow()
        await asyncio.to_thread(self.storage.data_dir.mkdir, parents=True, exist_ok=True)
        used, free = await asyncio.to_thread(self.storage.usage)
        # Start reclaiming before the hard reserve is reached, so the next maximum-size
        # attachment can be admitted without spending the reserve itself.
        free_target = self.settings.storage_reserve_bytes + CLOUD_DOWNLOAD_LIMIT_BYTES
        pressure = used >= self.settings.media_budget_bytes * 0.9 or free < free_target
        if self._media_due is None or now >= self._media_due or pressure:
            before = now - timedelta(days=self.settings.archive_media_retention_days)
            ids = await self.retention.media_candidates(before)
            for media_id in ids:
                await self.remove_media(media_id, before, now)
            await self.cleanup_orphans(now)
            self._media_due = now + (
                timedelta(minutes=1) if len(ids) == 100 else timedelta(hours=1)
            )

        before_compression = now - timedelta(days=self.settings.archive_media_compress_after_days)
        ids = await self.retention.media_candidates(
            before_compression, after=self._compression_after, compression=True
        )
        if not ids:
            self._compression_after = ""
        for media_id in ids[:2]:
            if self._stopped.is_set():
                return
            self._compression_after = media_id
            try:
                await self.compress_media(media_id, before_compression, now)
            except (OSError, ValueError, TimeoutError):
                # Original remains intact; a later pass retries. No per-file alert storm.
                await self.archives.notice(
                    "archive_compression_deferred",
                    "Сжатие архивных медиа отложено; оригиналы сохранены.",
                )

        used, free = await asyncio.to_thread(self.storage.usage)
        if used > self.settings.media_budget_bytes or free < free_target:
            # Do not erase text or active files to meet a soft budget.
            before = now
            oldest = await self.retention.media_candidates(before, oldest_first=True)
            removed = 0
            for media_id in oldest:
                if used <= self.settings.media_budget_bytes * 0.9 and free >= free_target:
                    break
                removed += await self.remove_media(media_id, before, now)
                used, free = await asyncio.to_thread(self.storage.usage)
            if removed:
                await self.archives.notice(
                    "archive_media_early_deletion",
                    "Из-за нехватки места удалены старые архивные вложения до обычного срока. "
                    "Метаданные сохранены.",
                )

        if self._text_due is None or now >= self._text_due:
            removed = await self.retention.purge_transcripts(now)
            self._text_due = now + (timedelta(minutes=1) if removed == 100 else timedelta(days=1))
        logical = await self.retention.logical_bytes()
        for key, value, budget, description in (
            (
                "archive_media_budget",
                used,
                self.settings.media_budget_bytes,
                "архивных и Web-медиа",
            ),
            (
                "archive_text_budget",
                logical,
                self.settings.archive_budget_bytes,
                "архивных текстов",
            ),
        ):
            await self.archives.notice(
                key,
                f"Использование хранилища {description}: {value} из {budget} байт.",
                active=value >= budget * 0.8,
                severity="critical" if value >= budget else "warning",
            )
        await self.archives.notice(
            "archive_disk_reserve",
            "Недостаточно свободного места сверх резерва для новых вложений.",
            active=free < free_target,
            severity="critical",
        )
        await self.archives.notice(
            "archive_maintenance_failed", "Очистка архивов восстановлена.", active=False
        )
