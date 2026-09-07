from collections.abc import AsyncIterator
from datetime import timedelta
from unittest.mock import AsyncMock, Mock

import pytest
from aiogram import Bot
from aiogram.exceptions import TelegramBadRequest, TelegramNetworkError, TelegramRetryAfter
from aiogram.methods import SendMessage

from resolvate.config import Settings
from resolvate.database import Database
from resolvate.models import OperationalNotice, utcnow
from resolvate.operational_notices import OperationalNoticeRepository
from resolvate.telegram_limits import TelegramRateLimiter
from resolvate.telegram_notices import GeneralNoticeWorker
from resolvate.topic_archive import TopicArchiveRepository


@pytest.fixture
async def notices(
    migrated_postgres_database_url: str,
) -> AsyncIterator[tuple[TopicArchiveRepository, GeneralNoticeWorker]]:
    database = Database(migrated_postgres_database_url)
    settings = Settings(
        _env_file=None,
        database_url=migrated_postgres_database_url,
        support_bot_token="test-token",
        support_group_id=-100123,
    )
    archives = TopicArchiveRepository(database, settings)
    bot = Mock(spec=Bot)
    bot.send_message = AsyncMock()
    yield (
        archives,
        GeneralNoticeWorker(
            OperationalNoticeRepository(database),
            bot,
            settings.support_group_id,
            TelegramRateLimiter(0),
        ),
    )
    await database.dispose()


async def test_general_delivery_is_safe_and_survives_restart(notices) -> None:
    archives, worker = notices
    await archives.notice("archive_media_budget", "private text must not be sent")
    await worker.tick()
    sent = worker.bot.send_message.call_args.kwargs
    assert sent["chat_id"] == -100123
    assert "message_thread_id" not in sent and "reply_parameters" not in sent
    assert sent["parse_mode"] is None and sent["link_preview_options"].is_disabled
    assert "private" not in sent["text"] and sent["text"].startswith("⚠️ ")
    recreated = GeneralNoticeWorker(worker.repository, worker.bot, -100123, worker.limiter)
    await archives.notice("archive_media_budget", "updated numbers")
    await recreated.tick()
    assert worker.bot.send_message.call_count == 1
    future = utcnow() + timedelta(hours=1, seconds=1)
    assert await worker.repository.claim(future) is not None


async def test_inactive_initial_state_and_internal_status_do_not_spam(notices) -> None:
    archives, worker = notices
    await archives.notice("archive_media_budget", "normal", active=False)
    await archives.notice("rotation_capacity", "routine cleanup")
    await archives.notice("unknown-internal-key", "private")
    await worker.tick()
    worker.bot.send_message.assert_not_called()


async def test_recovery_is_sent_once_and_severity_escalation_is_immediate(notices) -> None:
    archives, worker = notices
    await archives.notice("archive_media_budget", "warning")
    await worker.tick()
    await archives.notice("archive_media_budget", "critical", severity="critical")
    await worker.tick()
    assert worker.bot.send_message.call_args.kwargs["text"].startswith("🚨 ")
    await archives.notice("archive_media_budget", "normal", active=False)
    await worker.tick()
    assert worker.bot.send_message.call_args.kwargs["text"].startswith("✅ ")
    await worker.tick()
    assert worker.bot.send_message.call_count == 3


async def test_state_change_during_send_is_not_lost(notices) -> None:
    archives, worker = notices
    await archives.notice("archive_media_budget", "warning")
    delivery = await worker.repository.claim()
    assert delivery is not None
    await archives.notice("archive_media_budget", "normal", active=False)
    await worker.repository.delivered(delivery)
    await worker.tick()
    assert worker.bot.send_message.call_args.kwargs["text"].startswith("✅ ")


async def test_event_is_once_per_hour_without_false_recovery(notices) -> None:
    archives, worker = notices
    await archives.notice("archive_media_early_deletion", "removed")
    await worker.tick()
    await worker.tick()
    await archives.notice("archive_media_early_deletion", "removed again")
    await worker.tick()
    assert worker.bot.send_message.call_count == 1
    assert await worker.repository.claim(utcnow() + timedelta(hours=1, seconds=1))


@pytest.mark.parametrize("failure", ["network", "closed", "rate_limit"])
async def test_failed_delivery_is_durable_and_never_changes_group(notices, failure: str) -> None:
    archives, worker = notices
    method = SendMessage(chat_id=-100123, text="notice")
    errors = {
        "network": TelegramNetworkError(method=method, message="private network details"),
        "closed": TelegramBadRequest(method=method, message="TOPIC_CLOSED"),
        "rate_limit": TelegramRetryAfter(method=method, message="flood", retry_after=120),
    }
    worker.bot.send_message.side_effect = errors[failure]
    worker.limiter = Mock(wait=AsyncMock(), defer=AsyncMock())
    await archives.notice("archive_media_budget", "warning")
    before = utcnow()
    await worker.tick()
    async with archives.database.session() as session:
        row = await session.get(OperationalNotice, "archive_media_budget")
        assert row.delivered_at is None and row.active
        assert row.next_delivery_at > before + timedelta(seconds=59)
    await worker.tick()
    assert worker.bot.send_message.call_count == 1
    worker.bot.reopen_general_forum_topic.assert_not_called()
    worker.bot.unhide_general_forum_topic.assert_not_called()


async def test_claim_before_restart_has_persistent_cooldown(notices) -> None:
    archives, worker = notices
    await archives.notice("archive_media_budget", "warning")
    assert await worker.repository.claim()
    assert await OperationalNoticeRepository(archives.database).claim() is None


async def test_new_incident_after_recovery_is_sent(notices) -> None:
    archives, worker = notices
    await archives.notice("archive_media_budget", "warning")
    await worker.tick()
    await archives.notice("archive_media_budget", "normal", active=False)
    await worker.tick()
    await archives.notice("archive_media_budget", "new warning")
    await worker.tick()
    assert worker.bot.send_message.call_count == 3
