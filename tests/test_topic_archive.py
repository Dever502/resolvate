import asyncio
from collections.abc import AsyncIterator
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from aiogram import Bot
from aiogram.exceptions import TelegramBadRequest, TelegramNetworkError
from aiogram.methods import CreateForumTopic, DeleteForumTopic, GetFile
from aiogram.types import File
from project_support import ProjectDatabase as Database
from sqlalchemy import select

from resolvate.archive_media_policy import CLOUD_DOWNLOAD_LIMIT_BYTES, SKIPPED_CLOUD_LIMIT
from resolvate.archive_media_storage import ArchivedFile, ArchiveMediaStorage
from resolvate.config import Settings
from resolvate.durable_work import DurableWorkRepository
from resolvate.models import (
    CustomerSummary,
    DeliveryOutbox,
    DeliveryStatus,
    Direction,
    InboundUpdate,
    OperationalNotice,
    Ticket,
    TicketStatus,
    TopicArchive,
    TranscriptMedia,
    User,
    UserIdentity,
    WorkStatus,
    utcnow,
)
from resolvate.outbox_repository import OutboxRepository
from resolvate.rotation_recovery import RotationRecovery
from resolvate.services import TicketService
from resolvate.telegram_archive_media import TelegramArchiveMedia
from resolvate.telegram_rotation import TopicRotationWorker
from resolvate.topic_archive import TopicArchiveRepository
from resolvate.topic_rotation import TopicRotationRepository


@pytest.fixture
async def archive_repo(postgres_database_url: str) -> AsyncIterator[TopicArchiveRepository]:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    settings = Settings(
        _env_file=None,
        database_url=postgres_database_url,
        support_bot_token="test-token",
        support_group_id=-100123,
        topic_rotation_message_limit=2,
    )
    yield TopicArchiveRepository(database, settings)
    await database.dispose()


async def make_topic(
    repo: TopicArchiveRepository, *, complete: bool = True, topic: int = 10
) -> str:
    async with repo.database.session() as session:
        user = User(display_name="Customer")
        session.add(user)
        await session.flush()
        ticket = Ticket(
            user_id=user.id,
            topic_id=topic,
            status=TicketStatus.CLOSED,
            closed_at=utcnow() - timedelta(minutes=10),
            close_cycle=1,
        )
        session.add(ticket)
        await session.commit()
    return await repo.register_topic(ticket_id=ticket.id, topic_id=topic, complete=complete)


async def test_counting_includes_commands_but_not_duplicate_updates_or_edits(
    archive_repo: TopicArchiveRepository,
) -> None:
    archive_id = await make_topic(archive_repo)
    for message_id, value in enumerate(("hello", "/stop", "card"), 1):
        assert await archive_repo.observe(
            topic_id=10, message_id=message_id, payload={"text": value}
        )
        assert not await archive_repo.observe(
            topic_id=10, message_id=message_id, payload={"text": value}
        )
    assert await archive_repo.observe(topic_id=10, message_id=1, payload={"text": "edited"})
    archive = await archive_repo.topic(10)
    assert archive is not None
    assert archive.message_count == 3
    assert archive.revision == 4
    assert await archive_repo.candidates(capacity=False) == [archive_id]
    page = await archive_repo.transcript(archive_id, after=1, limit=1)
    assert [row.message_id for row in page] == [2]


async def test_legacy_topic_cannot_be_certified_by_registering_it_again(
    archive_repo: TopicArchiveRepository,
) -> None:
    archive_id = await make_topic(archive_repo, complete=False)
    archive = await archive_repo.topic(10)
    assert archive is not None
    assert (
        await archive_repo.register_topic(ticket_id=archive.ticket_id, topic_id=10, complete=True)
        == archive_id
    )
    assert await archive_repo.prepare(archive_id, capacity=True) is None
    assert await archive_repo.candidates(capacity=True) == []


async def test_reopen_during_preparation_cancels_switch(
    archive_repo: TopicArchiveRepository,
) -> None:
    archive_id = await make_topic(archive_repo)
    prepared = await archive_repo.prepare(archive_id, capacity=False)
    assert prepared is not None
    async with archive_repo.database.session() as session:
        ticket = await session.get(Ticket, prepared.ticket_id)
        assert ticket is not None
        ticket.status = TicketStatus.OPEN
        ticket.closed_at = None
        await session.commit()
    assert not await archive_repo.begin_switch(archive_id)
    current = await archive_repo.topic(10)
    assert current is not None and current.state == "live"


async def test_new_message_invalidates_prepared_snapshot(
    archive_repo: TopicArchiveRepository,
) -> None:
    archive_id = await make_topic(archive_repo)
    assert await archive_repo.prepare(archive_id, capacity=True)
    await archive_repo.observe(topic_id=10, message_id=1, payload={"text": "late"})
    assert not await archive_repo.begin_switch(archive_id)


async def test_new_close_cycle_cannot_reuse_prepared_summary(
    archive_repo: TopicArchiveRepository,
) -> None:
    archive_id = await make_topic(archive_repo)
    prepared = await archive_repo.prepare(archive_id, capacity=True)
    assert prepared is not None
    async with archive_repo.database.session() as session:
        ticket = await session.get(Ticket, prepared.ticket_id)
        assert ticket is not None
        ticket.close_cycle += 1
        await session.commit()
    assert not await archive_repo.begin_switch(archive_id)


async def test_unsaved_attachment_blocks_switch_and_shared_file_is_not_duplicated(
    archive_repo: TopicArchiveRepository,
) -> None:
    archive_id = await make_topic(archive_repo)
    media = {
        "file_id": "file-test",
        "file_unique_id": "unique-test",
        "telegram_content_type": "photo",
    }
    for message_id in (1, 2):
        await archive_repo.observe(
            topic_id=10, message_id=message_id, payload={"photo": media}, attachment=media
        )
    assert not await archive_repo.media_ready(archive_id)
    assert await archive_repo.prepare(archive_id, capacity=True)
    assert not await archive_repo.begin_switch(archive_id)
    async with archive_repo.database.session() as session:
        files = list((await session.scalars(select(TranscriptMedia))).all())
        assert len(files) == 1
        files[0].state = "stored"
        files[0].storage_path = "transcript-media/test.blob"
        files[0].sha256 = "0" * 64
        files[0].size_bytes = 1
        await session.commit()
    assert await archive_repo.media_ready(archive_id)
    assert await archive_repo.begin_switch(archive_id)


async def test_queued_delivery_prevents_starting_switch(
    archive_repo: TopicArchiveRepository,
) -> None:
    archive_id = await make_topic(archive_repo)
    prepared = await archive_repo.prepare(archive_id, capacity=True)
    assert prepared is not None
    async with archive_repo.database.session() as session:
        session.add(
            DeliveryOutbox(
                ticket_id=prepared.ticket_id,
                idempotency_key="test:pending",
                direction=Direction.USER_TO_OPERATOR,
                payload={},
                status=DeliveryStatus.PENDING,
            )
        )
        await session.commit()
    assert not await archive_repo.begin_switch(archive_id)


async def test_ai_requires_summary_for_exact_generation_and_revision(
    archive_repo: TopicArchiveRepository,
) -> None:
    archive_repo.settings.ai_enabled = True
    archive_id = await make_topic(archive_repo)
    prepared = await archive_repo.prepare(archive_id, capacity=True)
    assert prepared is not None
    assert not await archive_repo.begin_switch(archive_id)
    async with archive_repo.database.session() as session:
        summary = CustomerSummary(
            ticket_id=prepared.ticket_id,
            text="Summary",
            through_archive_id=archive_id,
            through_revision=prepared.revision,
        )
        session.add(summary)
        await session.commit()
    assert await archive_repo.begin_switch(archive_id)


async def test_notice_deduplicates_without_suppressing_severity_change(
    archive_repo: TopicArchiveRepository,
) -> None:
    await archive_repo.notice("capacity", "warning")
    async with archive_repo.database.session() as session:
        notice = await session.get(OperationalNotice, "capacity")
        assert notice is not None
        due = utcnow() + timedelta(hours=1)
        notice.next_delivery_at = due
        await session.commit()
    await archive_repo.notice("capacity", "updated warning")
    async with archive_repo.database.session() as session:
        notice = await session.get(OperationalNotice, "capacity")
        assert notice is not None and notice.next_delivery_at == due
    await archive_repo.notice("capacity", "critical", severity="critical")
    async with archive_repo.database.session() as session:
        notice = await session.get(OperationalNotice, "capacity")
        assert notice is not None and notice.next_delivery_at < due


async def archive_with_file(repo: TopicArchiveRepository, size: int | None) -> str:
    archive_id = await make_topic(repo)
    attachment = {
        "file_id": "file",
        "file_unique_id": "unique",
        "file_size": size,
        "file_name": "attachment.pdf",
        "telegram_content_type": "document",
    }
    await repo.observe(
        topic_id=10, message_id=1, payload={"document": attachment}, attachment=attachment
    )
    assert await repo.prepare(archive_id, capacity=True)
    return archive_id


@pytest.mark.parametrize(
    ("size", "skipped"),
    [
        (CLOUD_DOWNLOAD_LIMIT_BYTES - 1, False),
        (CLOUD_DOWNLOAD_LIMIT_BYTES, False),
        (CLOUD_DOWNLOAD_LIMIT_BYTES + 1, True),
    ],
)
async def test_only_files_strictly_above_cloud_limit_are_skipped(
    archive_repo: TopicArchiveRepository, size: int, skipped: bool
) -> None:
    archive_id = await archive_with_file(archive_repo, size)
    storage = AsyncMock(spec=ArchiveMediaStorage)
    storage.download.return_value = ArchivedFile("transcript-media/file.blob", size, "a" * 64)
    bot = AsyncMock(spec=Bot)
    preparer = TelegramArchiveMedia(archive_repo, bot, storage)
    archive_repo.prepare_media = preparer.prepare_archive
    assert await archive_repo.begin_switch(archive_id)
    async with archive_repo.database.session() as session:
        row = await session.scalar(select(TranscriptMedia))
        assert row is not None
        assert row.state == (SKIPPED_CLOUD_LIMIT if skipped else "stored")
        assert row.declared_size == size
        assert row.file_id == "file"
        if skipped:
            assert row.storage_path is None
    if skipped:
        storage.download.assert_not_awaited()
        bot.get_file.assert_not_awaited()
    else:
        assert storage.download.await_args.kwargs["expected_bytes"] == size


@pytest.mark.parametrize("size", [None, 0, CLOUD_DOWNLOAD_LIMIT_BYTES])
async def test_skip_marker_does_not_bypass_size_check(
    archive_repo: TopicArchiveRepository, size: int | None
) -> None:
    archive_id = await archive_with_file(archive_repo, size)
    async with archive_repo.database.session() as session:
        row = await session.scalar(select(TranscriptMedia))
        assert row is not None
        row.state = SKIPPED_CLOUD_LIMIT
        await session.commit()
    assert not await archive_repo.media_ready(archive_id)
    assert not await archive_repo.begin_switch(archive_id)


@pytest.mark.parametrize("failure", ["api", "disk", "unknown_size", "truncated"])
async def test_failed_media_preparation_defers_without_skipping(
    archive_repo: TopicArchiveRepository, tmp_path: Path, failure: str
) -> None:
    archive_id = await archive_with_file(archive_repo, None if failure == "unknown_size" else 5)
    bot = AsyncMock(spec=Bot)
    bot.get_file.return_value = File(
        file_id="file",
        file_unique_id="unique",
        file_size=None if failure == "unknown_size" else 5,
        file_path="documents/file.bin",
    )
    if failure == "api":
        bot.get_file.side_effect = TelegramBadRequest(
            method=GetFile(file_id="file"), message="file is too big"
        )
    storage = ArchiveMediaStorage(tmp_path, reserve_bytes=2**60 if failure == "disk" else 0)
    preparer = TelegramArchiveMedia(archive_repo, bot, storage)
    archive_repo.prepare_media = preparer.prepare_archive
    assert not await archive_repo.begin_switch(archive_id)
    archive = await archive_repo.topic(10)
    assert archive is not None and archive.state == "live"
    assert archive.error_code == "media_unavailable"
    assert archive.next_attempt_at > utcnow()
    assert not await archive_repo.media_ready(archive_id)
    async with archive_repo.database.session() as session:
        row = await session.scalar(select(TranscriptMedia))
        assert row is not None and row.state == "pending"
    assert not await asyncio.to_thread(lambda: list(tmp_path.rglob("*.part")))
    assert not await asyncio.to_thread(lambda: list(tmp_path.rglob("*.blob")))


async def test_small_file_is_saved_verified_and_reused(
    archive_repo: TopicArchiveRepository, tmp_path: Path
) -> None:
    archive_id = await archive_with_file(archive_repo, None)
    bot = AsyncMock(spec=Bot)
    bot.get_file.return_value = File(
        file_id="file", file_unique_id="unique", file_size=5, file_path="documents/file.bin"
    )

    async def download(path: str, **kwargs: object) -> None:
        output = kwargs["destination"]
        output.write(b"hello")

    bot.download_file.side_effect = download
    storage = ArchiveMediaStorage(tmp_path, reserve_bytes=0)
    preparer = TelegramArchiveMedia(archive_repo, bot, storage)
    assert await preparer.prepare_archive(archive_id)
    assert await preparer.prepare_archive(archive_id)
    bot.get_file.assert_awaited_once()
    bot.download_file.assert_awaited_once()
    async with archive_repo.database.session() as session:
        row = await session.scalar(select(TranscriptMedia))
        assert row is not None and row.state == "stored"
        assert row.storage_path and row.sha256
        assert await storage.verify(row.storage_path, size_bytes=5, sha256=row.sha256)


async def identify_customer(repo: TopicArchiveRepository, archive_id: str) -> str:
    async with repo.database.session() as session:
        archive = await session.get(TopicArchive, archive_id)
        assert archive is not None
        ticket = await session.get(Ticket, archive.ticket_id)
        assert ticket is not None
        session.add(UserIdentity(user_id=ticket.user_id, provider="telegram", external_id="123"))
        await session.commit()
        return ticket.id


@pytest.mark.parametrize("ordering_key", ["chat:123:thread:0", "chat:-100123:thread:10"])
async def test_preexisting_ingress_prevents_cutover(
    archive_repo: TopicArchiveRepository, ordering_key: str
) -> None:
    archive_id = await make_topic(archive_repo)
    await identify_customer(archive_repo, archive_id)
    await archive_repo.prepare(archive_id, capacity=False)
    await DurableWorkRepository(archive_repo.database).enqueue_inbound_update(
        1, {}, ordering_key=ordering_key
    )
    assert not await archive_repo.begin_switch(archive_id)


async def test_cutover_freezes_both_ingress_directions_but_not_other_customers(
    archive_repo: TopicArchiveRepository,
) -> None:
    archive_id = await make_topic(archive_repo)
    await identify_customer(archive_repo, archive_id)
    await archive_repo.prepare(archive_id, capacity=False)
    assert await archive_repo.begin_switch(archive_id)
    queue = DurableWorkRepository(archive_repo.database)
    for update_id, key in enumerate(
        ("chat:123:thread:0", "chat:-100123:thread:10", "chat:456:thread:0"), 1
    ):
        await queue.enqueue_inbound_update(update_id, {}, ordering_key=key)
    job = await queue.claim_inbound_update()
    assert job is not None and job.telegram_update_id == 3
    assert await queue.claim_inbound_update() is None
    async with archive_repo.database.session() as session:
        for update_id in (1, 2):
            row = await session.get(InboundUpdate, update_id)
            assert row is not None and row.status == WorkStatus.PENDING
            assert row.attempt_count == 0


@pytest.mark.parametrize("direction", [Direction.USER_TO_OPERATOR, Direction.OPERATOR_TO_USER])
async def test_cutover_does_not_claim_or_exhaust_queued_delivery(
    archive_repo: TopicArchiveRepository, direction: Direction
) -> None:
    archive_id = await make_topic(archive_repo)
    prepared = await archive_repo.prepare(archive_id, capacity=False)
    assert prepared is not None and await archive_repo.begin_switch(archive_id)
    async with archive_repo.database.session() as session:
        session.add(
            DeliveryOutbox(
                ticket_id=prepared.ticket_id,
                direction=direction,
                idempotency_key="during-switch",
                payload={"target_thread_id": 10},
            )
        )
        await session.commit()
    assert await OutboxRepository(archive_repo.database).claim_due_deliveries() == []
    async with archive_repo.database.session() as session:
        row = await session.scalar(select(DeliveryOutbox))
        assert row is not None and row.attempt_count == 0


def rotation_worker(repo: TopicArchiveRepository, tmp_path: Path) -> TopicRotationWorker:
    bot = AsyncMock(spec=Bot)
    bot.create_forum_topic.return_value = SimpleNamespace(message_thread_id=20)
    bot.send_message.return_value = SimpleNamespace(message_id=21)
    return TopicRotationWorker(
        archives=repo,
        bot=bot,
        tickets=TicketService(repo.database),
        media=TelegramArchiveMedia(repo, bot, ArchiveMediaStorage(tmp_path, reserve_bytes=0)),
        limiter=AsyncMock(),
        customer_card=AsyncMock(return_value="Customer card"),
        poll_progress=Mock(ready_to_delete=Mock(return_value=True)),
    )


@pytest.mark.parametrize("outcome", ["absent", "empty", "setup"])
async def test_offline_rotation_recovery_reuses_verified_topic(
    archive_repo: TopicArchiveRepository, tmp_path: Path, outcome: str
) -> None:
    archive_id = await make_topic(archive_repo)
    await identify_customer(archive_repo, archive_id)
    worker = rotation_worker(archive_repo, tmp_path)
    await archive_repo.prepare(archive_id, capacity=False)
    assert await archive_repo.begin_switch(archive_id)
    token = await worker.repository.claim_creation(archive_id)
    assert token
    expected = "creating"
    if outcome == "setup":
        assert await worker.repository.created(archive_id, token, 20)
        await archive_repo.begin_write(20)
        expected = "installing"
    assert await worker.repository.transition(archive_id, expected, "uncertain")
    recovery = RotationRecovery(archive_repo.database)
    row = (await recovery.inspect())[0]
    arguments = dict(
        token=token,
        revision=row["revision"],
        empty_topic_id=None if outcome == "absent" else 20,
        confirmed_stopped=True,
        confirmed_outcome=True,
    )
    await recovery.recover(archive_id, **arguments)
    with pytest.raises(ValueError, match="changed"):
        await recovery.recover(archive_id, **arguments)
    await worker.advance(archive_id)
    await worker.advance(archive_id)
    current = await worker.repository.get(archive_id)
    assert current and current.state == "retiring" and current.replacement_topic_id == 20
    assert worker.bot.create_forum_topic.await_count == (1 if outcome == "absent" else 0)
    worker.bot.send_message.assert_awaited_once()
    worker.bot.delete_forum_topic.assert_not_awaited()


async def test_recovery_refuses_unverified_stale_or_nonempty_target(
    archive_repo: TopicArchiveRepository, tmp_path: Path
) -> None:
    archive_id = await make_topic(archive_repo)
    worker = rotation_worker(archive_repo, tmp_path)
    await archive_repo.prepare(archive_id, capacity=False)
    assert await archive_repo.begin_switch(archive_id)
    token = await worker.repository.claim_creation(archive_id)
    assert token and await worker.repository.created(archive_id, token, 20)
    await worker.repository.transition(archive_id, "installing", "uncertain")
    recovery = RotationRecovery(archive_repo.database)
    row = (await recovery.inspect())[0]
    arguments = dict(
        token=token,
        revision=row["revision"],
        empty_topic_id=20,
        confirmed_stopped=True,
        confirmed_outcome=True,
    )
    for override in (
        {"confirmed_stopped": False},
        {"confirmed_outcome": False},
        {"token": "stale"},
        {"revision": row["revision"] + 1},
        {"empty_topic_id": 10},
        {"empty_topic_id": 30},
        {"empty_topic_id": None},
    ):
        with pytest.raises(ValueError):
            await recovery.recover(archive_id, **{**arguments, **override})
    await archive_repo.observe(topic_id=20, message_id=21, payload={"text": "Customer history"})
    with pytest.raises(ValueError, match="history"):
        await recovery.recover(archive_id, **arguments)
    assert (await worker.repository.get(archive_id)).state == "uncertain"


async def test_recovered_rotation_waits_for_reopened_conversation(
    archive_repo: TopicArchiveRepository, tmp_path: Path
) -> None:
    archive_id = await make_topic(archive_repo)
    ticket_id = await identify_customer(archive_repo, archive_id)
    worker = rotation_worker(archive_repo, tmp_path)
    await archive_repo.prepare(archive_id, capacity=False)
    assert await archive_repo.begin_switch(archive_id)
    token = await worker.repository.claim_creation(archive_id)
    assert token
    await worker.repository.transition(archive_id, "creating", "uncertain")
    row = (await RotationRecovery(archive_repo.database).inspect())[0]
    async with archive_repo.database.session() as session:
        ticket = await session.get(Ticket, ticket_id)
        ticket.status = TicketStatus.OPEN
        ticket.closed_at = None
        await session.commit()
    await RotationRecovery(archive_repo.database).recover(
        archive_id,
        token=token,
        revision=row["revision"],
        empty_topic_id=20,
        confirmed_stopped=True,
        confirmed_outcome=True,
    )
    await worker.advance(archive_id)
    assert (await worker.repository.get(archive_id)).state == "live"
    assert (await worker.tickets.get_ticket(ticket_id)).topic_id == 10
    worker.bot.create_forum_topic.assert_not_awaited()
    worker.bot.send_message.assert_not_awaited()
    worker.bot.reopen_forum_topic.assert_awaited_once()
    async with archive_repo.database.session() as session:
        ticket = await session.get(Ticket, ticket_id)
        ticket.status = TicketStatus.CLOSED
        ticket.closed_at = utcnow() - timedelta(minutes=10)
        ticket.close_cycle += 1
        await session.commit()
    # Capacity cleanup must not orphan an already adopted replacement.
    prepared = await archive_repo.prepare(archive_id, capacity=True)
    assert prepared and prepared.mode == "replace"
    await worker.advance(archive_id)
    await worker.advance(archive_id)
    assert (await worker.tickets.get_ticket(ticket_id)).topic_id == 20
    worker.bot.create_forum_topic.assert_not_awaited()


async def age_retirement(repo: TopicArchiveRepository, archive_id: str) -> None:
    async with repo.database.session() as session:
        archive = await session.get(TopicArchive, archive_id)
        assert archive is not None
        archive.cutover_at = utcnow() - timedelta(minutes=1)
        archive.last_observed_at = utcnow() - timedelta(minutes=1)
        await session.commit()


async def test_replacement_resumes_queue_before_deleting_old_topic(
    archive_repo: TopicArchiveRepository, tmp_path: Path
) -> None:
    archive_id = await make_topic(archive_repo)
    ticket_id = await identify_customer(archive_repo, archive_id)
    worker = rotation_worker(archive_repo, tmp_path)
    assert await archive_repo.prepare(archive_id, capacity=False)
    assert await archive_repo.begin_switch(archive_id)
    async with archive_repo.database.session() as session:
        session.add(
            DeliveryOutbox(
                ticket_id=ticket_id,
                direction=Direction.USER_TO_OPERATOR,
                idempotency_key="during-switch",
                payload={"target_thread_id": 10},
            )
        )
        await session.commit()
    await worker.advance(archive_id)
    assert (await worker.tickets.get_ticket(ticket_id)).topic_id == 20
    assert (await worker.tickets.get_by_topic(10)).id == ticket_id
    assert await archive_repo.publication_topic(10) == 20
    worker.bot.delete_forum_topic.assert_not_awaited()
    jobs = await OutboxRepository(archive_repo.database).claim_due_deliveries()
    assert len(jobs) == 1 and jobs[0].payload["target_thread_id"] == 20
    await age_retirement(archive_repo, archive_id)
    await worker.advance(archive_id)
    worker.bot.delete_forum_topic.assert_not_awaited()
    assert await OutboxRepository(archive_repo.database).mark_delivery_delivered(
        jobs[0].id, claim_token=jobs[0].claim_token, delivered_message_id=22
    )
    await worker.advance(archive_id)
    worker.bot.delete_forum_topic.assert_awaited_once_with(chat_id=-100123, message_thread_id=10)
    archived = await worker.repository.get(archive_id)
    assert archived is not None and archived.state == "archived" and archived.archived_at
    assert (await worker.tickets.get_ticket(ticket_id)).topic_id == 20


async def test_restart_after_replacement_creation_does_not_create_again(
    archive_repo: TopicArchiveRepository, tmp_path: Path
) -> None:
    archive_id = await make_topic(archive_repo)
    await identify_customer(archive_repo, archive_id)
    repo = TopicRotationRepository(archive_repo)
    await archive_repo.prepare(archive_id, capacity=False)
    assert await archive_repo.begin_switch(archive_id)
    token = await repo.claim_creation(archive_id)
    assert token and await repo.created(archive_id, token, 20)
    worker = rotation_worker(archive_repo, tmp_path)
    await worker.recover()
    await worker.advance(archive_id)
    worker.bot.create_forum_topic.assert_not_awaited()
    worker.bot.send_message.assert_awaited_once()
    assert (await repo.get(archive_id)).state == "retiring"


async def test_uncertain_creation_is_not_retried_and_releases_old_conversation(
    archive_repo: TopicArchiveRepository, tmp_path: Path
) -> None:
    archive_id = await make_topic(archive_repo)
    await identify_customer(archive_repo, archive_id)
    await archive_repo.prepare(archive_id, capacity=False)
    assert await archive_repo.begin_switch(archive_id)
    assert await TopicRotationRepository(archive_repo).claim_creation(archive_id)
    worker = rotation_worker(archive_repo, tmp_path)
    await worker.recover()
    assert (await worker.repository.get(archive_id)).state == "uncertain"
    worker.bot.create_forum_topic.assert_not_awaited()
    worker.bot.reopen_forum_topic.assert_awaited_once()
    queue = DurableWorkRepository(archive_repo.database)
    await queue.enqueue_inbound_update(1, {}, ordering_key="chat:123:thread:0")
    assert await queue.claim_inbound_update() is not None


@pytest.mark.parametrize("reopen", [False, True])
async def test_capacity_eviction_creates_replacement_only_for_post_barrier_return(
    archive_repo: TopicArchiveRepository, tmp_path: Path, reopen: bool
) -> None:
    archive_id = await make_topic(archive_repo)
    ticket_id = await identify_customer(archive_repo, archive_id)
    worker = rotation_worker(archive_repo, tmp_path)
    await archive_repo.prepare(archive_id, capacity=True)
    await worker.advance(archive_id)
    await age_retirement(archive_repo, archive_id)
    if reopen:
        async with archive_repo.database.session() as session:
            ticket = await session.get(Ticket, ticket_id)
            ticket.status = TicketStatus.OPEN
            ticket.closed_at = None
            await session.commit()
    await worker.advance(archive_id)
    if reopen:
        worker.bot.delete_forum_topic.assert_not_awaited()
        assert (await worker.repository.get(archive_id)).state == "switching"
        await worker.advance(archive_id)
        worker.bot.create_forum_topic.assert_awaited_once()
        assert (await worker.tickets.get_ticket(ticket_id)).topic_id == 20
    else:
        worker.bot.create_forum_topic.assert_not_awaited()
        worker.bot.delete_forum_topic.assert_awaited_once()
        assert (await worker.tickets.get_ticket(ticket_id)).topic_id is None


async def test_queued_operator_message_after_eviction_barrier_requires_new_topic(
    archive_repo: TopicArchiveRepository, tmp_path: Path
) -> None:
    archive_id = await make_topic(archive_repo)
    await identify_customer(archive_repo, archive_id)
    worker = rotation_worker(archive_repo, tmp_path)
    await archive_repo.prepare(archive_id, capacity=True)
    await worker.advance(archive_id)
    queue = DurableWorkRepository(archive_repo.database)
    await queue.enqueue_inbound_update(1, {}, ordering_key="chat:-100123:thread:10")
    assert await queue.claim_inbound_update() is None
    await worker.advance(archive_id)
    assert (await worker.repository.get(archive_id)).state == "switching"
    await worker.advance(archive_id)
    assert await queue.claim_inbound_update() is not None
    worker.bot.delete_forum_topic.assert_not_awaited()


async def test_changed_transcript_prevents_deletion_of_verified_snapshot(
    archive_repo: TopicArchiveRepository, tmp_path: Path
) -> None:
    archive_id = await make_topic(archive_repo)
    await identify_customer(archive_repo, archive_id)
    worker = rotation_worker(archive_repo, tmp_path)
    await archive_repo.prepare(archive_id, capacity=False)
    await worker.advance(archive_id)
    old_revision = (await worker.repository.get(archive_id)).revision
    await archive_repo.observe(topic_id=10, message_id=99, payload={"text": "late"})
    await age_retirement(archive_repo, archive_id)
    assert not await worker.repository.begin_delete(archive_id, revision=old_revision)


async def test_processing_reconciliation_blocks_cutover_and_new_claims_wait(
    archive_repo: TopicArchiveRepository,
) -> None:
    from resolvate.durable_work import enqueue_topic_reconciliation

    archive_id = await make_topic(archive_repo)
    ticket_id = await identify_customer(archive_repo, archive_id)
    queue = DurableWorkRepository(archive_repo.database)
    async with archive_repo.database.session() as session:
        await enqueue_topic_reconciliation(session, ticket_id=ticket_id, desired_status="closed")
        await session.commit()
    job = await queue.claim_reconciliation()
    assert job is not None
    await archive_repo.prepare(archive_id, capacity=False)
    assert not await archive_repo.begin_switch(archive_id)
    assert await queue.finish_reconciliation(job)
    assert await archive_repo.begin_switch(archive_id)
    async with archive_repo.database.session() as session:
        await enqueue_topic_reconciliation(session, ticket_id=ticket_id, desired_status="open")
        await session.commit()
    assert await queue.claim_reconciliation() is None


async def test_operator_mirror_is_durable_idempotent_and_only_targets_operator_topic(
    archive_repo: TopicArchiveRepository, tmp_path: Path
) -> None:
    archive_id = await make_topic(archive_repo)
    ticket_id = await identify_customer(archive_repo, archive_id)
    worker = rotation_worker(archive_repo, tmp_path)
    await archive_repo.prepare(archive_id, capacity=False)
    await worker.advance(archive_id)
    for _ in range(2):
        await worker.repository.enqueue_operator_mirror(
            ticket_id=ticket_id,
            source_chat_id=-100123,
            source_message_id=12,
            source_topic_id=10,
            author="Operator",
            snapshot={"text": "Reply", "date": "date"},
        )
    async with archive_repo.database.session() as session:
        jobs = list(
            (
                await session.scalars(
                    select(DeliveryOutbox).order_by(DeliveryOutbox.created_at, DeliveryOutbox.id)
                )
            ).all()
        )
        assert len(jobs) == 2
        assert jobs[0].payload["kind"] == "send_text"
        assert jobs[1].payload["kind"] == "snapshot"
        assert all(row.direction == Direction.USER_TO_OPERATOR for row in jobs)
        assert all(row.payload["target_thread_id"] == 20 for row in jobs)


@pytest.mark.parametrize("ambiguous", [False, True])
async def test_creation_failure_never_deletes_the_source(
    archive_repo: TopicArchiveRepository, tmp_path: Path, ambiguous: bool
) -> None:
    archive_id = await make_topic(archive_repo)
    await identify_customer(archive_repo, archive_id)
    worker = rotation_worker(archive_repo, tmp_path)
    error_type = TelegramNetworkError if ambiguous else TelegramBadRequest
    worker.bot.create_forum_topic.side_effect = error_type(
        method=CreateForumTopic(chat_id=-100123, name="topic"), message="failed"
    )
    await archive_repo.prepare(archive_id, capacity=False)
    await worker.advance(archive_id)
    current = await worker.repository.get(archive_id)
    assert current is not None
    assert current.state == ("uncertain" if ambiguous else "switching")
    assert current.next_attempt_at > utcnow()
    worker.bot.delete_forum_topic.assert_not_awaited()
    if ambiguous:
        worker.bot.reopen_forum_topic.assert_awaited_once()
        assert await archive_repo.count_topics() == 2  # Reserve for a possibly created topic.


async def test_delete_failure_retries_same_topic_after_restart(
    archive_repo: TopicArchiveRepository, tmp_path: Path
) -> None:
    archive_id = await make_topic(archive_repo)
    ticket_id = await identify_customer(archive_repo, archive_id)
    worker = rotation_worker(archive_repo, tmp_path)
    await archive_repo.prepare(archive_id, capacity=False)
    await worker.advance(archive_id)
    await age_retirement(archive_repo, archive_id)
    worker.bot.delete_forum_topic.side_effect = TelegramNetworkError(
        method=DeleteForumTopic(chat_id=-100123, message_thread_id=10), message="timeout"
    )
    await worker.advance(archive_id)
    assert (await worker.repository.get(archive_id)).state == "deleting"
    resumed = rotation_worker(archive_repo, tmp_path)
    resumed.bot.delete_forum_topic.side_effect = TelegramBadRequest(
        method=DeleteForumTopic(chat_id=-100123, message_thread_id=10),
        message="TOPIC_ID_INVALID",
    )
    await resumed.advance(archive_id)
    assert (await resumed.repository.get(archive_id)).state == "archived"
    assert (await resumed.tickets.get_ticket(ticket_id)).topic_id == 20
    resumed.bot.create_forum_topic.assert_not_awaited()


@pytest.mark.parametrize("uncertain", [False, True])
async def test_setup_recovery_uses_journal_and_never_blindly_repeats_uncertain_send(
    archive_repo: TopicArchiveRepository, tmp_path: Path, uncertain: bool
) -> None:
    archive_id = await make_topic(archive_repo)
    await identify_customer(archive_repo, archive_id)
    worker = rotation_worker(archive_repo, tmp_path)
    await archive_repo.prepare(archive_id, capacity=False)
    assert await archive_repo.begin_switch(archive_id)
    token = await worker.repository.claim_creation(archive_id)
    assert token and await worker.repository.created(archive_id, token, 20)
    if uncertain:
        await archive_repo.begin_write(20)
    else:
        await archive_repo.observe(
            topic_id=20,
            message_id=21,
            payload={
                "text": "Earlier card with older external subscription information",
                "rotation_setup_id": archive_id,
            },
        )
    await worker.advance(archive_id)
    worker.bot.send_message.assert_not_awaited()
    current = await worker.repository.get(archive_id)
    assert current is not None
    assert current.state == ("uncertain" if uncertain else "retiring")


async def test_rotation_requires_fresh_durable_poll_checkpoint_before_delete(
    archive_repo: TopicArchiveRepository, tmp_path: Path
) -> None:
    archive_id = await make_topic(archive_repo)
    await identify_customer(archive_repo, archive_id)
    worker = rotation_worker(archive_repo, tmp_path)
    await archive_repo.prepare(archive_id, capacity=False)
    await worker.advance(archive_id)
    await age_retirement(archive_repo, archive_id)
    worker.poll_progress.ready_to_delete.return_value = False
    await worker.advance(archive_id)
    worker.bot.delete_forum_topic.assert_not_awaited()
    assert (await worker.repository.get(archive_id)).state == "retiring"


async def test_ai_without_current_summary_defers_without_touching_telegram(
    archive_repo: TopicArchiveRepository, tmp_path: Path
) -> None:
    archive_id = await make_topic(archive_repo)
    archive_repo.settings.ai_enabled = True
    worker = rotation_worker(archive_repo, tmp_path)
    await archive_repo.prepare(archive_id, capacity=False)
    await worker.advance(archive_id)
    current = await worker.repository.get(archive_id)
    assert current is not None and current.state == "live"
    assert current.error_code == "summary_unavailable"
    worker.bot.close_forum_topic.assert_not_awaited()
    worker.bot.create_forum_topic.assert_not_awaited()


async def test_worker_starts_message_rotation_and_disabled_flag_stops_new_work(
    archive_repo: TopicArchiveRepository, tmp_path: Path
) -> None:
    archive_id = await make_topic(archive_repo)
    await identify_customer(archive_repo, archive_id)
    for message_id in range(1, 4):
        await archive_repo.observe(topic_id=10, message_id=message_id, payload={"text": "hello"})
    worker = rotation_worker(archive_repo, tmp_path)
    archive_repo.settings.topic_rotation_enabled = False
    await worker.tick()
    worker.bot.create_forum_topic.assert_not_awaited()
    archive_repo.settings.topic_rotation_enabled = True
    await worker.tick()
    worker.bot.create_forum_topic.assert_awaited_once()
    assert (await worker.repository.get(archive_id)).state == "retiring"


async def test_capacity_cleanup_hysteresis_survives_worker_restart(
    archive_repo: TopicArchiveRepository, tmp_path: Path
) -> None:
    archive_repo.settings.topic_rotation_topic_limit = 5
    archive_repo.settings.topic_rotation_topic_reserve = 1
    ids = [await make_topic(archive_repo, topic=topic) for topic in (10, 11, 12, 13)]
    await identify_customer(archive_repo, ids[0])
    worker = rotation_worker(archive_repo, tmp_path)
    await worker.tick()
    assert (await worker.repository.get(ids[0])).state == "evicting"
    await age_retirement(archive_repo, ids[0])
    resumed = rotation_worker(archive_repo, tmp_path)
    await resumed.tick()
    assert await archive_repo.count_topics() == 3
    async with archive_repo.database.session() as session:
        notice = await session.get(OperationalNotice, "rotation_capacity")
        assert notice is not None and not notice.active
    resumed.bot.create_forum_topic.assert_not_awaited()


@pytest.mark.parametrize("failure", [False, True])
async def test_late_attachment_after_deletion_is_saved_without_extending_retention(
    archive_repo: TopicArchiveRepository, tmp_path: Path, failure: bool
) -> None:
    archive_id = await make_topic(archive_repo)
    ticket_id = await identify_customer(archive_repo, archive_id)
    worker = rotation_worker(archive_repo, tmp_path)
    await archive_repo.prepare(archive_id, capacity=False)
    await worker.advance(archive_id)
    await age_retirement(archive_repo, archive_id)
    await worker.advance(archive_id)
    archived_at = (await worker.repository.get(archive_id)).archived_at
    document = {
        "file_id": "late",
        "file_unique_id": "late-unique",
        "file_size": 5,
        "file_name": "late.pdf",
        "telegram_content_type": "document",
    }
    await archive_repo.observe(
        topic_id=10, message_id=30, payload={"document": document}, attachment=document
    )
    assert (await worker.repository.get(archive_id)).state == "archived_pending"
    assert (await worker.tickets.get_by_topic(10)).id == ticket_id
    assert await archive_repo.publication_topic(10) == 20
    assert await archive_repo.count_topics() == 1
    worker.bot.get_file.return_value = File(
        file_id="late", file_unique_id="late-unique", file_size=5, file_path="files/late.bin"
    )

    async def download(path: str, **kwargs: object) -> None:
        kwargs["destination"].write(b"hello")

    worker.bot.download_file.side_effect = OSError("disk error") if failure else download
    await worker.advance(archive_id)
    archive = await worker.repository.get(archive_id)
    assert archive is not None and archive.archived_at == archived_at
    assert archive.state == ("archived_pending" if failure else "archived")
    assert await archive_repo.media_ready(archive_id) is not failure
    worker.bot.delete_forum_topic.assert_awaited_once()


async def test_late_media_completion_cannot_clear_newer_pending_work(
    archive_repo: TopicArchiveRepository,
) -> None:
    archive_id = await make_topic(archive_repo)
    repo = TopicRotationRepository(archive_repo)
    assert await repo.transition(archive_id, "live", "archived_pending")
    revision = (await repo.get(archive_id)).revision
    await archive_repo.observe(topic_id=10, message_id=30, payload={"text": "newer"})
    assert not await repo.transition(archive_id, "archived_pending", "archived", revision=revision)
    assert (await repo.get(archive_id)).state == "archived_pending"


async def test_new_topic_binding_publishes_journal_before_releasing_waiting_deliveries(
    archive_repo: TopicArchiveRepository,
) -> None:
    tickets = TicketService(archive_repo.database)
    accepted = await tickets.accept_customer_message(
        telegram_user_id=123,
        display_name="Customer",
        username=None,
        source_chat_id=123,
        source_message_id=1,
        target_chat_id=-100123,
        content="Hello",
        media=None,
    )
    assert accepted.ticket is not None
    token = await tickets.claim_topic_provisioning(accepted.ticket.id)
    assert token
    await tickets.attach_topic(accepted.ticket.id, 20, token=token, archive_chat_id=-100123)
    journal = await archive_repo.topic(20)
    assert journal is not None and journal.complete
    jobs = await tickets.outbox.claim_due_deliveries()
    assert len(jobs) == 1 and jobs[0].payload["target_thread_id"] == 20
