from __future__ import annotations

import asyncio
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiogram.exceptions import TelegramBadRequest, TelegramNetworkError, TelegramRetryAfter
from aiogram.methods import DeleteMessage, EditMessageText, SendMessage
from project_support import ADMIN_ID, ProjectDatabase

from resolvate.config import Settings
from resolvate.models import ConsoleAccount, QuickResponse
from resolvate.quick_replies import QuickReplyService
from resolvate.quick_reply_catalog import QuickReplyCatalog
from resolvate.telegram_quick_replies import (
    QUICK_RESPONSE_DELETED_TEXT,
    QuickResponseTopicRefreshWorker,
    TelegramQuickReplyHandlers,
    publication,
)


@pytest.fixture
async def catalog_runtime(migrated_postgres_database_url):
    database = ProjectDatabase(migrated_postgres_database_url)
    service = QuickReplyService(database)
    catalog = QuickReplyCatalog(database)
    async with database.session() as session:
        actor = await session.get(ConsoleAccount, ADMIN_ID)
    group = await catalog.create_group(actor, "оплата")
    reply = await catalog.save(actor, group["id"], "Оплатите <счёт> & сохраните чек 😀")
    topic = TelegramQuickReplyHandlers()
    topic.settings = Settings(_env_file=None, support_group_id=-100123)
    topic.bot = SimpleNamespace(
        send_message=AsyncMock(return_value=SimpleNamespace(message_id=501)),
        edit_message_text=AsyncMock(),
        delete_message=AsyncMock(),
        pin_chat_message=AsyncMock(),
    )
    topic.limiter = SimpleNamespace(wait=AsyncMock(), defer=AsyncMock())
    topic.quick_reply_service = service
    topic.quick_replies_topic_id = 777
    topic.recover_quick_replies_topic = AsyncMock(return_value=888)
    topic.initialize_quick_reply_runtime()
    await service.save_instruction_message_id(-100123, 900, 777)
    try:
        yield topic, service, catalog, actor, group, reply
    finally:
        await database.dispose()


async def test_web_reply_published_as_copyable_block_without_metadata(catalog_runtime):
    topic, service, _, _, _, reply = catalog_runtime
    await topic.ensure_quick_response_topic()
    sent = topic.bot.send_message.await_args.kwargs
    assert sent["text"] == "/оплата\n\n" + reply["text"]
    assert sent["parse_mode"] is None and "reply_markup" not in sent
    (entity,) = sent["entities"]
    assert entity.type == "pre"
    assert entity.offset == len("/оплата\n\n")
    assert entity.length == len(reply["text"]) + 1
    saved = await service.get(int(reply["id"]))
    assert saved.published_revision == saved.revision
    assert saved.published_message_id == 501
    assert await service.list_publication_candidates() == []


async def test_edit_and_group_rename_keep_message_identity(catalog_runtime):
    topic, service, catalog, actor, group, reply = catalog_runtime
    await topic.ensure_quick_response_topic()
    await catalog.save(actor, group["id"], "Новый текст", reply_id=int(reply["id"]), revision=0)
    await topic.ensure_quick_response_topic()
    topic.bot.send_message.assert_awaited_once()
    assert topic.bot.edit_message_text.await_args.kwargs["text"] == "/оплата\n\nНовый текст"
    await catalog.change_group(actor, group["id"], 0, "платежи")
    await topic.ensure_quick_response_topic()
    assert topic.bot.edit_message_text.await_args.kwargs["text"] == "/платежи\n\nНовый текст"
    assert (await service.get(int(reply["id"]))).published_message_id == 501


@pytest.mark.parametrize("old", [False, True])
async def test_web_delete_removes_publication_or_tombstones_old_message(catalog_runtime, old):
    topic, service, catalog, actor, _, reply = catalog_runtime
    await topic.ensure_quick_response_topic()
    if old:
        topic.bot.delete_message.side_effect = TelegramBadRequest(
            method=DeleteMessage(chat_id=-100123, message_id=501),
            message="message can't be deleted",
        )
    await catalog.delete(actor, int(reply["id"]), 0)
    await topic.ensure_quick_response_topic()
    assert (await service.get(int(reply["id"]))).published_message_id is None
    if old:
        assert topic.bot.edit_message_text.await_args.kwargs["text"] == QUICK_RESPONSE_DELETED_TEXT
    topic.initialize_quick_reply_runtime()
    await topic.ensure_quick_response_topic()
    topic.bot.send_message.assert_awaited_once()  # Deleted catalog entries never return.


async def test_edit_during_publish_is_not_acknowledged_as_new_revision(catalog_runtime):
    topic, service, catalog, actor, group, reply = catalog_runtime

    async def send(**kwargs):
        await catalog.save(
            actor, group["id"], "Concurrent edit", reply_id=int(reply["id"]), revision=0
        )
        return SimpleNamespace(message_id=501)

    topic.bot.send_message.side_effect = send
    await topic.ensure_quick_response_topic()
    assert len(await service.list_publication_candidates()) == 1
    topic.bot.send_message.side_effect = None
    await topic.ensure_quick_response_topic()
    assert await service.list_publication_candidates() == []
    assert topic.bot.edit_message_text.await_args.kwargs["text"].endswith("Concurrent edit")


async def test_delete_during_publish_retains_message_id_for_cleanup(catalog_runtime):
    topic, service, catalog, actor, _, reply = catalog_runtime

    async def send(**kwargs):
        await catalog.delete(actor, int(reply["id"]), 0)
        return SimpleNamespace(message_id=501)

    topic.bot.send_message.side_effect = send
    await topic.ensure_quick_response_topic()
    assert (await service.get(int(reply["id"]))).published_message_id == 501
    await topic.ensure_quick_response_topic()
    assert (await service.get(int(reply["id"]))).published_message_id is None


@pytest.mark.parametrize("kind", ["429", "network"])
async def test_telegram_outage_retries_without_stopping_project(catalog_runtime, kind):
    topic, service, _, _, _, _ = catalog_runtime
    method = SendMessage(chat_id=-100123, text="reply")
    topic.bot.send_message.side_effect = (
        TelegramRetryAfter(method=method, message="flood", retry_after=10)
        if kind == "429"
        else TelegramNetworkError(method=method, message="offline")
    )
    await topic.ensure_quick_response_topic()
    assert len(await service.list_publication_candidates()) == 1
    if kind == "429":
        topic.limiter.defer.assert_awaited_once_with(10)
    topic.bot.send_message.side_effect = None
    await topic.ensure_quick_response_topic()
    assert await service.list_publication_candidates() == []


async def test_missing_topic_recovery_republishes_catalog(catalog_runtime):
    topic, service, _, _, _, reply = catalog_runtime
    await topic.ensure_quick_response_topic()
    topic.bot.edit_message_text.side_effect = [
        TelegramBadRequest(
            method=EditMessageText(chat_id=-100123, message_id=900, text="help"),
            message="Bad Request: message thread not found",
        ),
        True,
    ]
    topic.bot.send_message.side_effect = [
        SimpleNamespace(message_id=901),
        SimpleNamespace(message_id=502),
    ]
    await topic.ensure_quick_response_topic()
    assert topic.quick_replies_topic_id == 888
    assert (await service.get(int(reply["id"]))).published_message_id == 502
    assert await service.instruction_topic_id(-100123) == 888


async def test_read_only_topic_preserves_operator_text_and_old_delete_callback(catalog_runtime):
    topic, service, _, _, _, _ = catalog_runtime
    message = SimpleNamespace(
        message_thread_id=777,
        from_user=SimpleNamespace(is_bot=False),
        text="Не потерять текст",
        reply=AsyncMock(),
    )
    assert await topic.handle_quick_reply_topic_message(message)
    message.reply.assert_awaited_once()
    assert len(await service.list_valid()) == 1
    topic.bot.delete_message.assert_not_awaited()
    callback = SimpleNamespace(answer=AsyncMock())
    await topic.handle_quick_response_delete_callback(callback)
    callback.answer.assert_awaited_once()
    message.message_thread_id = 999
    assert not await topic.handle_quick_reply_topic_message(message)


async def test_block_offset_handles_unicode_group(catalog_runtime):
    _, service, _, _, _, reply = catalog_runtime
    view = await service.get(int(reply["id"]))
    rendered, entities = publication(replace(view, group_name="𐐨"))
    assert rendered.startswith("/𐐨\n\n")
    assert entities[0].offset == 5


async def test_worker_retries_and_stops():
    finished = asyncio.Event()
    attempts = 0

    async def sync():
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError()
        finished.set()

    topic = SimpleNamespace(ensure_quick_response_topic=AsyncMock(side_effect=sync))
    worker = QuickResponseTopicRefreshWorker(topic, interval_seconds=0.001)
    task = asyncio.create_task(worker.run())
    async with asyncio.timeout(2):
        await finished.wait()
    worker.stop()
    await task


async def test_instruction_pin_failure_is_retried(catalog_runtime):
    topic, service, _, _, _, _ = catalog_runtime
    topic.bot.pin_chat_message.side_effect = TelegramNetworkError(
        method=SendMessage(chat_id=-100123, text="help"), message="offline"
    )
    await topic.ensure_quick_response_topic()
    assert not topic._quick_response_catalog_verified
    topic.bot.send_message.assert_not_awaited()
    topic.bot.pin_chat_message.side_effect = None
    await topic.ensure_quick_response_topic()
    assert topic.bot.pin_chat_message.await_count == 2
    assert await service.list_publication_candidates() == []


async def test_legacy_warning_too_old_to_delete_is_tombstoned(catalog_runtime):
    topic, service, _, _, _, reply = catalog_runtime
    async with service.database.session() as session:
        saved = await session.get(QuickResponse, int(reply["id"]))
        saved.warning_message_id = 700
        await session.commit()
    topic.bot.delete_message.side_effect = TelegramBadRequest(
        method=DeleteMessage(chat_id=-100123, message_id=700), message="message can't be deleted"
    )
    await topic.ensure_quick_response_topic()
    saved = await service.get(int(reply["id"]))
    assert saved.warning_message_id is None
    assert await service.list_publication_candidates() == []
    assert topic.bot.edit_message_text.await_args.kwargs["message_id"] == 700
