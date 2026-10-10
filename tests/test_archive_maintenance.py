import asyncio
import os
from collections.abc import AsyncIterator
from datetime import timedelta
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from PIL import Image
from project_support import ProjectDatabase as Database
from sqlalchemy import select

from resolvate.archive_maintenance import ArchiveMaintenance
from resolvate.archive_media_storage import ArchiveMediaStorage, ArchiveStorageFull
from resolvate.config import Settings
from resolvate.models import (
    DeliveryOutbox,
    DeliveryStatus,
    Direction,
    InboundUpdate,
    OperationalNotice,
    Ticket,
    TicketMessage,
    TicketStatus,
    TopicArchive,
    TranscriptMedia,
    TranscriptMessage,
    User,
    WorkStatus,
    utcnow,
)
from resolvate.topic_archive import TopicArchiveRepository
from resolvate.web_models import MediaAsset


@pytest.fixture
async def maintenance(
    postgres_database_url: str, tmp_path: Path
) -> AsyncIterator[ArchiveMaintenance]:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    settings = Settings(
        _env_file=None,
        database_url=postgres_database_url,
        support_bot_token="test-token",
        support_group_id=-100123,
        data_dir=tmp_path,
        storage_reserve_bytes=1,
    )
    repository = TopicArchiveRepository(database, settings)
    yield ArchiveMaintenance(repository, ArchiveMediaStorage(tmp_path, reserve_bytes=1))
    await database.dispose()


async def seed(
    worker: ArchiveMaintenance,
    *,
    days: int = 31,
    state: str = "archived",
    kind: str = "document",
    topic: int = 10,
) -> tuple[str, str, str]:
    now = utcnow()
    path = worker.storage.resolve(f"transcript-media/aa/{topic}.blob")
    path.parent.mkdir(parents=True, exist_ok=True)
    if kind == "photo":
        Image.new("RGB", (300, 300), "white").save(path, format="PNG", compress_level=0)
    else:
        path.write_bytes(b"stored attachment")
    file = worker.storage.inspect(path)
    async with worker.archives.database.session() as session:
        user = User(display_name="Customer")
        session.add(user)
        await session.flush()
        ticket = Ticket(user_id=user.id, status=TicketStatus.CLOSED, topic_id=None)
        session.add(ticket)
        await session.flush()
        archive = TopicArchive(
            ticket_id=ticket.id,
            chat_id=-100123,
            topic_id=topic,
            state=state,
            complete=True,
            archived_at=now - timedelta(days=days),
        )
        media = TranscriptMedia(
            file_unique_id=f"unique-{topic}",
            file_id="file",
            kind=kind,
            state="stored",
            storage_path=path.relative_to(worker.storage.data_dir).as_posix(),
            size_bytes=file.size_bytes,
            sha256=file.sha256,
            declared_size=file.size_bytes,
            created_at=now - timedelta(days=90),
        )
        session.add_all([archive, media])
        await session.flush()
        session.add(
            TranscriptMessage(
                archive_id=archive.id, message_id=1, payload={"text": "history"}, media_id=media.id
            )
        )
        await session.commit()
        return archive.id, media.id, ticket.id


async def test_expiry_keeps_metadata_and_removes_only_old_files(
    maintenance: ArchiveMaintenance,
) -> None:
    old, media_id, _ = await seed(maintenance)
    await seed(maintenance, days=29, topic=11)
    now = utcnow()
    assert await maintenance.retention.media_candidates(now - timedelta(days=30)) == [media_id]
    assert await maintenance.remove_media(media_id, now - timedelta(days=30), now)
    async with maintenance.archives.database.session() as session:
        media = await session.get(TranscriptMedia, media_id)
        assert media.state == "deleted" and media.deleted_at == now
        assert media.storage_path is None and media.declared_size > 0
        assert await session.scalar(
            select(TranscriptMessage).where(TranscriptMessage.archive_id == old)
        )
    assert not (maintenance.storage.root / "aa/10.blob").exists()
    assert (maintenance.storage.root / "aa/11.blob").exists()


@pytest.mark.parametrize("kind", ["inbound", "delivery"])
@pytest.mark.parametrize("recent_attempt", [False, True])
async def test_failed_work_protects_only_during_recovery_window(
    maintenance: ArchiveMaintenance, kind: str, recent_attempt: bool
) -> None:
    _, media_id, ticket_id = await seed(maintenance, days=90)
    now = utcnow()
    old = now - timedelta(days=31)
    async with maintenance.archives.database.session() as session:
        common = dict(created_at=old, next_attempt_at=now if recent_attempt else old)
        if kind == "delivery":
            session.add(
                DeliveryOutbox(
                    ticket_id=ticket_id,
                    direction=Direction.USER_TO_OPERATOR,
                    idempotency_key="failed-recovery-window",
                    status=DeliveryStatus.FAILED,
                    payload={},
                    **common,
                )
            )
        else:
            session.add(
                InboundUpdate(
                    telegram_update_id=123,
                    ordering_key="chat:-100123:thread:10",
                    status=WorkStatus.FAILED,
                    payload={"photo": {"file_unique_id": "unique-10"}},
                    **common,
                )
            )
        await session.commit()
    assert await maintenance.retention.media_candidates(now - timedelta(days=30)) == (
        [] if recent_attempt else [media_id]
    )
    assert await maintenance.retention.purge_transcripts(now) == (0 if recent_attempt else 1)


async def test_compression_candidate_limit_keeps_contiguous_cursor(
    maintenance: ArchiveMaintenance,
) -> None:
    ids = []
    for topic in range(20, 25):
        _, media_id, _ = await seed(maintenance, days=20, kind="photo", topic=topic)
        ids.append(media_id)
    before = utcnow() - timedelta(days=14)
    first = await maintenance.retention.media_candidates(before, compression=True, limit=2)
    second = await maintenance.retention.media_candidates(
        before, compression=True, limit=2, after=first[-1]
    )
    third = await maintenance.retention.media_candidates(
        before, compression=True, limit=2, after=second[-1]
    )
    assert len(first) == len(second) == 2
    assert first + second + third == sorted(ids)
    for limit in (0, 101):
        with pytest.raises(ValueError, match="candidate limit"):
            await maintenance.retention.media_candidates(before, limit=limit)


@pytest.mark.parametrize(
    "state", ["live", "preparing", "switching", "retiring", "archived_pending", "uncertain"]
)
async def test_in_progress_archives_are_protected(
    maintenance: ArchiveMaintenance, state: str
) -> None:
    _, media_id, _ = await seed(maintenance, days=90, state=state)
    assert await maintenance.retention.media_candidates(utcnow()) == []
    assert not await maintenance.remove_media(media_id, utcnow(), utcnow())
    assert await maintenance.retention.purge_transcripts(utcnow()) == 0


async def test_shared_file_waits_for_newest_reference(maintenance: ArchiveMaintenance) -> None:
    _, media_id, _ = await seed(maintenance, days=90)
    recent, _, _ = await seed(maintenance, days=2, topic=11)
    async with maintenance.archives.database.session() as session:
        session.add(
            TranscriptMessage(archive_id=recent, message_id=2, payload={}, media_id=media_id)
        )
        await session.commit()
    assert media_id not in await maintenance.retention.media_candidates(
        utcnow() - timedelta(days=30)
    )
    assert not await maintenance.remove_media(media_id, utcnow() - timedelta(days=30), utcnow())


async def test_web_reference_protects_shared_blob_and_expires_with_archive(
    maintenance: ArchiveMaintenance,
) -> None:
    archive_id, media_id, ticket_id = await seed(maintenance, days=90)
    async with maintenance.archives.database.session() as session:
        media = await session.get(TranscriptMedia, media_id)
        message = TicketMessage(
            ticket_id=ticket_id,
            direction=Direction.OPERATOR_TO_USER,
            channel="console",
            content="Archived answer",
        )
        session.add(message)
        await session.flush()
        asset = MediaAsset(
            ticket_id=ticket_id,
            message_id=message.id,
            storage_path=media.storage_path,
            mime_type="application/pdf",
            size_bytes=media.size_bytes,
            sha256=media.sha256,
        )
        session.add(asset)
        await session.commit()
        ident = message.id
    assert not await maintenance.remove_media(media_id, utcnow(), utcnow())
    async with maintenance.archives.database.session() as session:
        message = await session.get(TicketMessage, ident)
        message.archive_id = archive_id
        await session.commit()
    assert await maintenance.remove_media(media_id, utcnow() - timedelta(days=30), utcnow())
    async with maintenance.archives.database.session() as session:
        assert await session.get(MediaAsset, asset.id) is None
        assert await session.get(TicketMessage, ident) is not None
    assert await maintenance.retention.purge_transcripts(utcnow()) == 1
    async with maintenance.archives.database.session() as session:
        assert await session.get(TicketMessage, ident) is None


async def test_compression_updates_web_asset_reference(maintenance: ArchiveMaintenance) -> None:
    archive_id, media_id, ticket_id = await seed(maintenance, days=20, kind="photo")
    async with maintenance.archives.database.session() as session:
        media = await session.get(TranscriptMedia, media_id)
        old_path = media.storage_path
        message = TicketMessage(
            ticket_id=ticket_id,
            archive_id=archive_id,
            direction=Direction.OPERATOR_TO_USER,
            channel="console",
            media={"mime_type": "image/png"},
        )
        session.add(message)
        await session.flush()
        asset = MediaAsset(
            ticket_id=ticket_id,
            message_id=message.id,
            storage_path=old_path,
            mime_type="image/png",
            size_bytes=media.size_bytes,
            sha256=media.sha256,
        )
        session.add(asset)
        await session.commit()
    assert await maintenance.compress_media(media_id, utcnow() - timedelta(days=14), utcnow())
    async with maintenance.archives.database.session() as session:
        updated = await session.get(MediaAsset, asset.id)
        assert updated.storage_path != old_path and updated.mime_type == "image/webp"
        assert maintenance.storage.resolve(updated.storage_path).is_file()
        message = await session.get(TicketMessage, message.id)
        assert message.media["mime_type"] == "image/webp"


@pytest.mark.parametrize(
    "status", [DeliveryStatus.PENDING, DeliveryStatus.PROCESSING, DeliveryStatus.FAILED]
)
async def test_unfinished_delivery_protects_file_and_text(
    maintenance: ArchiveMaintenance, status: DeliveryStatus
) -> None:
    _, media_id, ticket_id = await seed(maintenance, days=90)
    async with maintenance.archives.database.session() as session:
        session.add(
            DeliveryOutbox(
                ticket_id=ticket_id,
                direction=Direction.USER_TO_OPERATOR,
                idempotency_key="pending-copy",
                status=status,
                payload={},
            )
        )
        await session.commit()
    assert not await maintenance.remove_media(media_id, utcnow(), utcnow())
    assert await maintenance.retention.purge_transcripts(utcnow()) == 0


async def test_queued_unjournaled_attachment_is_protected(maintenance: ArchiveMaintenance) -> None:
    _, media_id, _ = await seed(maintenance)
    async with maintenance.archives.database.session() as session:
        session.add(
            InboundUpdate(
                telegram_update_id=1,
                ordering_key="chat:555",
                status=WorkStatus.PENDING,
                payload={"message": {"photo": [{"file_unique_id": "unique-10"}]}},
            )
        )
        await session.commit()
    assert not await maintenance.remove_media(media_id, utcnow(), utcnow())


async def test_text_expiry_keeps_routing_tombstone_and_rejects_late_edit(
    maintenance: ArchiveMaintenance,
) -> None:
    old, _, _ = await seed(maintenance, days=61)
    recent, _, _ = await seed(maintenance, days=59, topic=11)
    assert await maintenance.retention.purge_transcripts(utcnow()) == 1
    assert not await maintenance.archives.observe(
        topic_id=10, message_id=1, payload={"text": "late"}
    )
    async with maintenance.archives.database.session() as session:
        assert await session.get(TopicArchive, old) is not None
        messages = list((await session.scalars(select(TranscriptMessage))).all())
        assert len(messages) == 1 and messages[0].archive_id == recent


async def test_lossless_photo_compression_preserves_pixels_and_age(
    maintenance: ArchiveMaintenance,
) -> None:
    archive_id, media_id, _ = await seed(maintenance, days=15, kind="photo")
    before = await maintenance.archives.topic(10)
    assert await maintenance.compress_media(media_id, utcnow() - timedelta(days=14), utcnow())
    async with maintenance.archives.database.session() as session:
        row = await session.get(TranscriptMedia, media_id)
        assert row.storage_path.endswith(".webp")
        assert row.compressed_at is not None and row.size_bytes < row.declared_size
        assert await maintenance.storage.verify(
            row.storage_path, size_bytes=row.size_bytes, sha256=row.sha256
        )
        with Image.open(maintenance.storage.resolve(row.storage_path)) as image:
            assert image.size == (300, 300) and image.convert("RGB").getpixel((0, 0)) == (
                255,
                255,
                255,
            )
        assert (await session.get(TopicArchive, archive_id)).archived_at == before.archived_at
    assert not (maintenance.storage.root / "aa/10.blob").exists()


async def test_compression_never_replaces_corrupt_source(maintenance: ArchiveMaintenance) -> None:
    _, media_id, _ = await seed(maintenance, kind="photo")
    original = maintenance.storage.root / "aa/10.blob"
    original.write_bytes(b"damaged")
    assert not await maintenance.compress_media(media_id, utcnow(), utcnow())
    assert original.read_bytes() == b"damaged"


async def test_reserve_failure_preserves_original(maintenance: ArchiveMaintenance) -> None:
    _, media_id, _ = await seed(maintenance, kind="photo")
    maintenance.storage.reserve_bytes = 2**60
    with pytest.raises(ArchiveStorageFull):
        await maintenance.compress_media(media_id, utcnow(), utcnow())
    assert (maintenance.storage.root / "aa/10.blob").exists()


async def test_budget_cleans_archive_but_never_young_text_or_active_media(
    maintenance: ArchiveMaintenance,
) -> None:
    _, archived_media, _ = await seed(maintenance, days=2)
    _, active_media, _ = await seed(maintenance, days=90, state="live", topic=11)
    maintenance.settings.media_budget_bytes = 1
    await maintenance.tick()
    async with maintenance.archives.database.session() as session:
        assert (await session.get(TranscriptMedia, archived_media)).state == "deleted"
        assert (await session.get(TranscriptMedia, active_media)).state == "stored"
        assert len(list((await session.scalars(select(TranscriptMessage))).all())) == 2
        assert (await session.get(OperationalNotice, "archive_media_early_deletion")).active
        assert (await session.get(OperationalNotice, "archive_media_budget")).active


async def test_orphan_recovery_never_removes_referenced_file(
    maintenance: ArchiveMaintenance,
) -> None:
    await seed(maintenance)
    original = maintenance.storage.root / "aa/10.blob"
    orphan = original.with_name("orphan.blob")
    orphan.write_bytes(b"leftover")
    old = (utcnow() - timedelta(days=2)).timestamp()
    os.utime(orphan, (old, old))
    os.utime(original, (old, old))
    await maintenance.cleanup_orphans(utcnow())
    assert original.exists() and not orphan.exists()


async def test_background_failure_retries_and_stops(maintenance: ArchiveMaintenance) -> None:
    maintenance.tick = AsyncMock(side_effect=OSError("private details"))
    task = asyncio.create_task(maintenance.run())
    for _ in range(100):
        async with maintenance.archives.database.session() as session:
            if await session.get(OperationalNotice, "archive_maintenance_failed"):
                break
        await asyncio.sleep(0.01)
    maintenance.stop()
    await asyncio.wait_for(task, timeout=2)
    assert maintenance.tick.call_count == 1


async def test_late_download_does_not_extend_archive_retention(
    maintenance: ArchiveMaintenance,
) -> None:
    _, media_id, _ = await seed(maintenance)
    async with maintenance.archives.database.session() as session:
        row = await session.get(TranscriptMedia, media_id)
        row.created_at = utcnow()
        await session.commit()
    assert media_id in await maintenance.retention.media_candidates(utcnow() - timedelta(days=30))


async def test_pressure_order_uses_archive_age_not_file_creation(
    maintenance: ArchiveMaintenance,
) -> None:
    _, recent, _ = await seed(maintenance, days=2)
    _, older, _ = await seed(maintenance, days=10, topic=11)
    assert await maintenance.retention.media_candidates(utcnow(), oldest_first=True) == [
        older,
        recent,
    ]


async def test_reclaims_headroom_before_hard_disk_reserve(
    maintenance: ArchiveMaintenance, monkeypatch: pytest.MonkeyPatch
) -> None:
    from resolvate.archive_media_policy import CLOUD_DOWNLOAD_LIMIT_BYTES

    _, media_id, _ = await seed(maintenance, days=2)
    path = maintenance.storage.root / "aa/10.blob"
    monkeypatch.setattr(
        maintenance.storage,
        "usage",
        lambda: (
            17 if path.exists() else 0,
            maintenance.settings.storage_reserve_bytes
            + (1 if path.exists() else CLOUD_DOWNLOAD_LIMIT_BYTES),
        ),
    )
    await maintenance.tick()
    async with maintenance.archives.database.session() as session:
        assert (await session.get(TranscriptMedia, media_id)).state == "deleted"


async def test_compression_publication_rechecks_eligibility(
    maintenance: ArchiveMaintenance, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, media_id, _ = await seed(maintenance, days=15, kind="photo")
    monkeypatch.setattr(maintenance.retention, "media_for_change", AsyncMock(return_value=None))
    assert not await maintenance.compress_media(media_id, utcnow(), utcnow())
    assert (maintenance.storage.root / "aa/10.blob").exists()
    assert not list(maintenance.storage.root.glob("*/*.webp"))
