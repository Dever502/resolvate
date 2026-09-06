from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, call

import pytest
from aiogram.enums import ChatType, MessageEntityType
from aiogram.exceptions import TelegramBadRequest, TelegramNetworkError
from aiogram.methods import DeleteMessage, EditMessageText
from aiogram.types import Chat, Message, MessageEntity, User
from pydantic import SecretStr
from sqlalchemy import event

from resolvate.authorization import AuthorizationService
from resolvate.config import Settings
from resolvate.database import Database
from resolvate.models import QuickResponse
from resolvate.quick_replies import (
    QUICK_RESPONSE_DELETED,
    QUICK_RESPONSE_PENDING_DELETION,
    QUICK_RESPONSE_PUBLICATION_FORMAT_VERSION,
    QUICK_RESPONSE_TEXT_MAX_LENGTH,
    QUICK_RESPONSE_VALID,
    QuickReplyService,
    render_quick_response,
)
from resolvate.telegram_quick_replies import (
    QUICK_RESPONSE_DELETE_CALLBACK_PREFIX,
    QUICK_RESPONSE_DELETED_TEXT,
    QUICK_RESPONSE_INSTRUCTION_TEXT,
    QUICK_RESPONSE_LENGTH_WARNING_TEXT,
    QUICK_RESPONSE_WARNING_TEXT,
    QuickResponseTopicRefreshWorker,
    TelegramQuickReplyHandlers,
    quick_response_delete_keyboard,
)


@pytest.mark.parametrize(
    "text", ["а" * 4090, "а" * 4096, "😀" * 2045], ids=["long", "maximum", "emoji"]
)
async def test_long_reply_warns_preserves_deadline_and_accepts_correction(
    postgres_database_url: str, text: str
) -> None:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    service = QuickReplyService(database)
    bot = _bot()
    harness = _harness(service, bot)
    try:
        message = _message(text=text)
        assert await harness.handle_quick_reply_topic_message(message)
        message.reply.assert_awaited_once_with(QUICK_RESPONSE_LENGTH_WARNING_TEXT, parse_mode=None)
        bot.send_message.assert_not_awaited()
        pending = await service.get_by_source(source_chat_id=-100123, source_message_id=301)
        assert pending is not None and pending.state == QUICK_RESPONSE_PENDING_DELETION
        assert pending.text == text
        deadline = pending.invalid_until

        # Further invalid edits, including a change of reason, keep the original deadline.
        message.text = "а" * 4091
        await harness.handle_quick_reply_topic_message(message)
        message.text = "Ответ #1 #2 #3 #4 #5 #6"
        await harness.handle_quick_reply_topic_message(message)
        current = await service.get(pending.id)
        assert current is not None and current.invalid_until == deadline
        bot.edit_message_text.assert_awaited_with(
            chat_id=-100123,
            message_id=901,
            text=QUICK_RESPONSE_WARNING_TEXT,
            parse_mode=None,
            reply_markup=None,
        )

        message.text = "😀" * 2044
        await harness.handle_quick_reply_topic_message(message)
        saved = await service.get(pending.id)
        assert saved is not None and saved.state == QUICK_RESPONSE_VALID
        assert saved.invalid_until is None and saved.warning_message_id is None
        assert saved.id not in harness._quick_response_tasks
        assert bot.send_message.await_args.kwargs["text"] == render_quick_response(message.text)
    finally:
        await harness.shutdown_quick_reply_runtime()
        await database.dispose()


async def test_maximum_length_reply_is_published(postgres_database_url: str) -> None:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    harness = _harness(QuickReplyService(database), _bot())
    try:
        message = _message(text="а" * QUICK_RESPONSE_TEXT_MAX_LENGTH)
        await harness.handle_quick_reply_topic_message(message)
        message.reply.assert_not_awaited()
        assert len(harness.bot.send_message.await_args.kwargs["text"]) == 4096
    finally:
        await harness.shutdown_quick_reply_runtime()
        await database.dispose()


@pytest.mark.parametrize(
    "edit_error",
    [None, "message is not modified", "message to edit not found", "temporary failure"],
)
async def test_old_deleted_reply_is_replaced_or_retried(
    postgres_database_url: str, edit_error: str | None
) -> None:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    service = QuickReplyService(database)
    bot = _bot()
    harness = _harness(service, bot)
    try:
        await harness.handle_quick_reply_topic_message(_message(text="Старый ответ #VPN"))
        saved = await service.get_by_source(source_chat_id=-100123, source_message_id=301)
        assert saved is not None
        bot.delete_message.reset_mock()
        bot.delete_message.side_effect = TelegramBadRequest(
            method=DeleteMessage(chat_id=-100123, message_id=501),
            message="Bad Request: message can't be deleted",
        )
        if edit_error is not None:
            error_class = (
                TelegramNetworkError if edit_error == "temporary failure" else TelegramBadRequest
            )
            bot.edit_message_text.side_effect = error_class(
                method=EditMessageText(chat_id=-100123, message_id=501, text="deleted"),
                message=edit_error,
            )
        callback = SimpleNamespace(
            data=f"{QUICK_RESPONSE_DELETE_CALLBACK_PREFIX}:{saved.id}",
            from_user=User(id=7, is_bot=False, first_name="Operator"),
            message=Message(
                message_id=501,
                date=datetime(2020, 1, 1, tzinfo=UTC),
                chat=Chat(id=-100123, type=ChatType.SUPERGROUP),
                message_thread_id=777,
                text=render_quick_response(saved.text),
            ),
            answer=AsyncMock(),
        )
        await harness.handle_quick_response_delete_callback(callback)
        bot.edit_message_text.assert_awaited_once_with(
            chat_id=-100123,
            message_id=501,
            text=QUICK_RESPONSE_DELETED_TEXT,
            parse_mode=None,
            reply_markup=None,
        )
        deleted = await service.get(saved.id)
        assert deleted is not None and deleted.state == QUICK_RESPONSE_DELETED
        if edit_error == "temporary failure":
            assert deleted.published_message_id == 501
            assert callback.answer.await_args.kwargs["show_alert"] is True
            bot.edit_message_text.side_effect = None
            await harness._cleanup_deleted_publications()
        else:
            assert deleted.published_message_id is None
            callback.answer.assert_awaited_once_with("Быстрый ответ удалён.", show_alert=False)
        assert await service.list_deleted_with_publication() == []
        attempts = bot.delete_message.await_count
        await harness._cleanup_deleted_publications()
        await harness._restore_valid_responses(all_responses=True)
        assert bot.delete_message.await_count == attempts
        assert bot.send_message.await_count == 1  # Only the original publication.
    finally:
        await harness.shutdown_quick_reply_runtime()
        await database.dispose()


async def test_idle_catalogue_uses_one_query_and_full_scan_is_paginated(
    postgres_database_url: str,
) -> None:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    service = QuickReplyService(database)
    harness = _harness(service, _bot())
    try:
        async with database.session() as session:
            session.add_all(
                QuickResponse(
                    text=f"Ответ {i}",
                    tags=[],
                    created_by_telegram_id=7,
                    source_chat_id=-100123,
                    source_message_id=1000 + i,
                    published_message_id=2000 + i,
                    publication_format_version=QUICK_RESPONSE_PUBLICATION_FORMAT_VERSION,
                    state=QUICK_RESPONSE_VALID,
                )
                for i in range(205)
            )
            await session.commit()
        queries: list[str] = []

        def capture(connection, cursor, statement, parameters, context, executemany):
            queries.append(statement)

        event.listen(database.engine.sync_engine, "before_cursor_execute", capture)
        try:
            await harness._restore_valid_responses(all_responses=False)
        finally:
            event.remove(database.engine.sync_engine, "before_cursor_execute", capture)
        assert len(queries) == 1
        harness.bot.send_message.assert_not_awaited()
        harness._publish_valid_response = AsyncMock()
        await harness._restore_valid_responses(all_responses=False, verify_existing=True)
        published_ids = [
            item.args[0].id for item in harness._publish_valid_response.await_args_list
        ]
        assert len(published_ids) == 205 and len(set(published_ids)) == 205

        # A selected record deleted before its lock is acquired must not be republished.
        candidate = (await service.list_valid())[0]
        original_query = service.list_publication_candidates

        async def delete_after_selection(**kwargs):
            batch = await original_query(**kwargs)
            if kwargs["after_id"] == 0:
                await service.soft_delete_valid(
                    candidate.id,
                    published_message_id=candidate.published_message_id,
                    operator_telegram_id=7,
                )
            return batch

        service.list_publication_candidates = delete_after_selection
        harness._publish_valid_response.reset_mock()
        await harness._restore_valid_responses(all_responses=True)
        assert candidate.id not in [
            item.args[0].id for item in harness._publish_valid_response.await_args_list
        ]
    finally:
        await harness.shutdown_quick_reply_runtime()
        await database.dispose()


class FakeLimiter:
    def __init__(self) -> None:
        self.wait_count = 0

    async def wait(self) -> None:
        self.wait_count += 1


class QuickReplyHarness(TelegramQuickReplyHandlers):
    pass


def _settings() -> Settings:
    return Settings(
        support_bot_token=SecretStr("test-token"),
        support_group_id=-100123,
        admin_telegram_ids={7},
    )


def _hashtags(text: str) -> list[MessageEntity]:
    entities: list[MessageEntity] = []
    cursor = 0
    for part in text.split():
        offset = text.index(part, cursor)
        cursor = offset + len(part)
        if part.startswith("#"):
            entities.append(
                MessageEntity(
                    type=MessageEntityType.HASHTAG,
                    offset=offset,
                    length=len(part),
                )
            )
    return entities


def _message(
    *,
    text: str,
    message_id: int = 301,
    topic_id: int = 777,
    warning_message_id: int = 901,
) -> AsyncMock:
    message = AsyncMock(spec=Message)
    message.message_id = message_id
    message.message_thread_id = topic_id
    message.chat = SimpleNamespace(id=-100123)
    message.from_user = SimpleNamespace(
        id=7,
        is_bot=False,
        full_name="Operator",
        username="operator",
    )
    message.text = text
    message.entities = _hashtags(text)
    message.reply = AsyncMock(return_value=SimpleNamespace(message_id=warning_message_id))
    return message


def _bot() -> SimpleNamespace:
    return SimpleNamespace(
        delete_message=AsyncMock(),
        send_message=AsyncMock(return_value=SimpleNamespace(message_id=501)),
        edit_message_text=AsyncMock(),
        pin_chat_message=AsyncMock(),
    )


def _harness(service: QuickReplyService, bot: SimpleNamespace) -> QuickReplyHarness:
    harness = QuickReplyHarness()
    harness.bot = bot
    harness.settings = _settings()
    harness.authorization = AuthorizationService(harness.settings)
    harness.limiter = FakeLimiter()  # type: ignore[assignment]
    harness.quick_reply_service = service
    harness.quick_replies_topic_id = 777
    harness.recover_quick_replies_topic = None
    harness.initialize_quick_reply_runtime()
    return harness


async def test_valid_quick_response_is_saved_unchanged(
    postgres_database_url: str,
) -> None:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    harness = QuickReplyHarness()
    try:
        service = QuickReplyService(database)
        bot = _bot()
        harness = _harness(service, bot)
        message = _message(
            text="Переустановите TikTok #TikTok #Android #VPN #Инструкция #Поддержка"
        )

        assert await harness.handle_quick_reply_topic_message(message) is True

        saved = await service.get_by_source(
            source_chat_id=-100123,
            source_message_id=301,
        )
        assert saved is not None
        assert saved.state == QUICK_RESPONSE_VALID
        assert saved.text == message.text
        assert saved.tags == ("#TikTok", "#Android", "#VPN", "#Инструкция", "#Поддержка")
        assert saved.published_message_id == 501
        assert saved.publication_format_version == QUICK_RESPONSE_PUBLICATION_FORMAT_VERSION
        assert saved.warning_message_id is None
        bot.send_message.assert_awaited_once_with(
            chat_id=-100123,
            message_thread_id=777,
            text=render_quick_response(message.text),
            parse_mode=None,
            reply_markup=quick_response_delete_keyboard(saved.id),
        )
        bot.delete_message.assert_awaited_once_with(chat_id=-100123, message_id=301)
        message.reply.assert_not_awaited()
    finally:
        await harness.shutdown_quick_reply_runtime()
        await database.dispose()


async def test_numeric_hashtags_are_valid_without_telegram_entities(
    postgres_database_url: str,
) -> None:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    harness = QuickReplyHarness()
    try:
        service = QuickReplyService(database)
        bot = _bot()
        harness = _harness(service, bot)
        message = _message(text="Ответ #1 #2 #3 #4 #Билайн")
        message.entities = []

        assert await harness.handle_quick_reply_topic_message(message) is True

        saved = await service.get_by_source(
            source_chat_id=-100123,
            source_message_id=301,
        )
        assert saved is not None
        assert saved.state == QUICK_RESPONSE_VALID
        assert saved.tags == ("#1", "#2", "#3", "#4", "#Билайн")
        message.reply.assert_not_awaited()
    finally:
        await harness.shutdown_quick_reply_runtime()
        await database.dispose()


async def test_existing_separate_save_reply_is_replaced_by_one_canonical_message(
    postgres_database_url: str,
) -> None:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    harness = QuickReplyHarness()
    try:
        service = QuickReplyService(database)
        pending = await service.save_pending_deletion(
            text="Старый ответ #VPN",
            tags=["#VPN"],
            operator_telegram_id=7,
            operator_display_name="Operator",
            operator_username="operator",
            source_chat_id=-100123,
            source_message_id=301,
            invalid_until=datetime.now(UTC),
        )
        assert await service.attach_warning(pending.id, 901) is True
        saved = await service.save_valid(
            text="Старый ответ #VPN",
            tags=["#VPN"],
            operator_telegram_id=7,
            operator_display_name="Operator",
            operator_username="operator",
            source_chat_id=-100123,
            source_message_id=301,
        )
        await service.record_publication(saved.id, 301)

        bot = _bot()
        harness = _harness(service, bot)
        await harness._restore_valid_responses(all_responses=False)

        converted = await service.get_by_source(
            source_chat_id=-100123,
            source_message_id=301,
        )
        assert converted is not None
        assert converted.published_message_id == 501
        assert converted.publication_format_version == QUICK_RESPONSE_PUBLICATION_FORMAT_VERSION
        assert converted.warning_message_id is None
        bot.send_message.assert_awaited_once_with(
            chat_id=-100123,
            message_thread_id=777,
            text=render_quick_response("Старый ответ #VPN"),
            parse_mode=None,
            reply_markup=quick_response_delete_keyboard(saved.id),
        )
        assert bot.delete_message.await_args_list == [
            call(chat_id=-100123, message_id=301),
            call(chat_id=-100123, message_id=901),
        ]
    finally:
        await harness.shutdown_quick_reply_runtime()
        await database.dispose()


async def test_invalid_response_gets_exact_warning_and_edit_makes_it_valid(
    postgres_database_url: str,
) -> None:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    harness = QuickReplyHarness()
    try:
        service = QuickReplyService(database)
        bot = _bot()
        harness = _harness(service, bot)
        message = _message(text="Текст #1 #2 #3 #4 #5 #6")

        await harness.handle_quick_reply_topic_message(message)

        pending = await service.get_by_source(
            source_chat_id=-100123,
            source_message_id=301,
        )
        assert pending is not None
        assert pending.state == QUICK_RESPONSE_PENDING_DELETION
        assert pending.warning_message_id == 901
        message.reply.assert_awaited_once_with(
            QUICK_RESPONSE_WARNING_TEXT,
            parse_mode=None,
        )

        message.text = "Исправленный текст #1 #2 #3 #4 #5"
        message.entities = _hashtags(message.text)
        await harness.handle_quick_reply_topic_message(message)

        corrected = await service.get_by_source(
            source_chat_id=-100123,
            source_message_id=301,
        )
        assert corrected is not None
        assert corrected.state == QUICK_RESPONSE_VALID
        assert corrected.published_message_id == 501
        assert corrected.publication_format_version == QUICK_RESPONSE_PUBLICATION_FORMAT_VERSION
        assert corrected.warning_message_id is None
        bot.send_message.assert_awaited_once_with(
            chat_id=-100123,
            message_thread_id=777,
            text=render_quick_response(message.text),
            parse_mode=None,
            reply_markup=quick_response_delete_keyboard(corrected.id),
        )
        assert bot.delete_message.await_args_list == [
            call(chat_id=-100123, message_id=301),
            call(chat_id=-100123, message_id=901),
        ]
        assert message.reply.await_count == 1
    finally:
        await harness.shutdown_quick_reply_runtime()
        await database.dispose()


@pytest.mark.parametrize(
    "text",
    [
        "Ответ # Fuck",
        "Ответ #",
        "Ответ #-VPN",
        "Ответ ##VPN",
        "Ответ #___",
    ],
)
async def test_malformed_hashtag_is_rejected(
    text: str,
    postgres_database_url: str,
) -> None:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    harness = QuickReplyHarness()
    try:
        service = QuickReplyService(database)
        bot = _bot()
        harness = _harness(service, bot)
        message = _message(text=text)

        await harness.handle_quick_reply_topic_message(message)

        pending = await service.get_by_source(
            source_chat_id=-100123,
            source_message_id=301,
        )
        assert pending is not None
        assert pending.state == QUICK_RESPONSE_PENDING_DELETION
        assert pending.warning_message_id == 901
        message.reply.assert_awaited_once_with(
            QUICK_RESPONSE_WARNING_TEXT,
            parse_mode=None,
        )
        bot.send_message.assert_not_awaited()
    finally:
        await harness.shutdown_quick_reply_runtime()
        await database.dispose()


async def test_invalid_response_and_warning_are_deleted_after_deadline(
    postgres_database_url: str,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "resolvate.telegram_quick_replies.QUICK_RESPONSE_DELETE_DELAY_SECONDS",
        0,
    )
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    harness = QuickReplyHarness()
    try:
        service = QuickReplyService(database)
        bot = _bot()
        harness = _harness(service, bot)
        message = _message(text="Текст #1 #2 #3 #4 #5 #6")

        await harness.handle_quick_reply_topic_message(message)
        await asyncio.sleep(0.05)

        assert (
            await service.get_by_source(
                source_chat_id=-100123,
                source_message_id=301,
            )
            is None
        )
        assert bot.delete_message.await_args_list == [
            call(chat_id=-100123, message_id=301),
            call(chat_id=-100123, message_id=901),
        ]
    finally:
        await harness.shutdown_quick_reply_runtime()
        await database.dispose()


async def test_message_outside_quick_response_topic_is_not_consumed(
    postgres_database_url: str,
) -> None:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    harness = QuickReplyHarness()
    try:
        service = QuickReplyService(database)
        harness = _harness(service, _bot())

        assert (
            await harness.handle_quick_reply_topic_message(
                _message(text="Обычный ответ", topic_id=778)
            )
            is False
        )
        assert await service.list_valid() == []
    finally:
        await harness.shutdown_quick_reply_runtime()
        await database.dispose()


async def test_delete_button_soft_deletes_response_without_confirmation(
    postgres_database_url: str,
) -> None:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    harness = QuickReplyHarness()
    try:
        service = QuickReplyService(database)
        saved = await service.save_valid(
            text="Неправильный ответ #VPN",
            tags=["#VPN"],
            operator_telegram_id=7,
            operator_display_name="Operator",
            operator_username="operator",
            source_chat_id=-100123,
            source_message_id=301,
        )
        await service.record_publication(saved.id, 501)
        assert await service.complete_publication(saved.id, 501) is True
        bot = _bot()
        harness = _harness(service, bot)
        callback = SimpleNamespace(
            data=f"{QUICK_RESPONSE_DELETE_CALLBACK_PREFIX}:{saved.id}",
            from_user=User(id=7, is_bot=False, first_name="Operator"),
            message=Message(
                message_id=501,
                date=datetime.now(UTC),
                chat=Chat(id=-100123, type=ChatType.SUPERGROUP),
                from_user=User(id=42, is_bot=True, first_name="Bot"),
                message_thread_id=777,
                text=render_quick_response(saved.text),
            ),
            answer=AsyncMock(),
        )

        await harness.handle_quick_response_delete_callback(callback)  # type: ignore[arg-type]

        deleted = await service.get_by_source(
            source_chat_id=-100123,
            source_message_id=301,
        )
        assert deleted is not None
        assert deleted.state == QUICK_RESPONSE_DELETED
        assert deleted.deleted_by_telegram_id == 7
        assert deleted.deleted_at is not None
        assert deleted.published_message_id is None
        assert await service.list_valid() == []
        callback.answer.assert_awaited_once_with(
            "Быстрый ответ удалён.",
            show_alert=False,
        )
        bot.delete_message.assert_awaited_once_with(chat_id=-100123, message_id=501)
        bot.send_message.assert_not_awaited()
    finally:
        await harness.shutdown_quick_reply_runtime()
        await database.dispose()


async def test_failed_telegram_delete_is_retried_from_tombstone(
    postgres_database_url: str,
) -> None:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    harness = QuickReplyHarness()
    try:
        service = QuickReplyService(database)
        saved = await service.save_valid(
            text="Ответ для удаления #VPN",
            tags=["#VPN"],
            operator_telegram_id=7,
            operator_display_name="Operator",
            operator_username="operator",
            source_chat_id=-100123,
            source_message_id=301,
        )
        await service.record_publication(saved.id, 501)
        assert await service.complete_publication(saved.id, 501) is True
        rejected_delete = TelegramNetworkError(
            method=DeleteMessage(chat_id=-100123, message_id=501),
            message="Connection timed out",
        )
        bot = _bot()
        bot.delete_message = AsyncMock(side_effect=rejected_delete)
        harness = _harness(service, bot)
        callback = SimpleNamespace(
            data=f"{QUICK_RESPONSE_DELETE_CALLBACK_PREFIX}:{saved.id}",
            from_user=User(id=7, is_bot=False, first_name="Operator"),
            message=Message(
                message_id=501,
                date=datetime.now(UTC),
                chat=Chat(id=-100123, type=ChatType.SUPERGROUP),
                from_user=User(id=42, is_bot=True, first_name="Bot"),
                message_thread_id=777,
                text=render_quick_response(saved.text),
            ),
            answer=AsyncMock(),
        )

        await harness.handle_quick_response_delete_callback(callback)  # type: ignore[arg-type]

        tombstone = await service.get(saved.id)
        assert tombstone is not None
        assert tombstone.state == QUICK_RESPONSE_DELETED
        assert tombstone.published_message_id == 501
        callback.answer.assert_awaited_once_with(
            "Ответ исключён из каталога. Очистка сообщения будет повторена.", show_alert=True
        )
        bot.edit_message_text.assert_not_awaited()

        bot.delete_message = AsyncMock()
        await harness._cleanup_deleted_publications()

        cleaned = await service.get(saved.id)
        assert cleaned is not None
        assert cleaned.published_message_id is None
        bot.delete_message.assert_awaited_once_with(chat_id=-100123, message_id=501)
    finally:
        await harness.shutdown_quick_reply_runtime()
        await database.dispose()


async def test_unauthorized_operator_cannot_delete_quick_response(
    postgres_database_url: str,
) -> None:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    harness = QuickReplyHarness()
    try:
        service = QuickReplyService(database)
        saved = await service.save_valid(
            text="Ответ #VPN",
            tags=["#VPN"],
            operator_telegram_id=7,
            operator_display_name="Operator",
            operator_username="operator",
            source_chat_id=-100123,
            source_message_id=301,
        )
        await service.record_publication(saved.id, 501)
        bot = _bot()
        harness = _harness(service, bot)
        callback = SimpleNamespace(
            data=f"{QUICK_RESPONSE_DELETE_CALLBACK_PREFIX}:{saved.id}",
            from_user=User(id=8, is_bot=False, first_name="Other"),
            message=None,
            answer=AsyncMock(),
        )

        await harness.handle_quick_response_delete_callback(callback)  # type: ignore[arg-type]

        active = await service.get_by_source(
            source_chat_id=-100123,
            source_message_id=301,
        )
        assert active is not None
        assert active.state == QUICK_RESPONSE_VALID
        callback.answer.assert_awaited_once_with("Недостаточно прав.", show_alert=True)
        bot.delete_message.assert_not_awaited()
    finally:
        await harness.shutdown_quick_reply_runtime()
        await database.dispose()


async def test_instruction_is_plain_pinned_message_without_buttons(
    postgres_database_url: str,
) -> None:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    harness = QuickReplyHarness()
    try:
        service = QuickReplyService(database)
        bot = _bot()
        harness = _harness(service, bot)

        await harness.ensure_quick_response_topic()

        bot.send_message.assert_awaited_once_with(
            chat_id=-100123,
            message_thread_id=777,
            text=QUICK_RESPONSE_INSTRUCTION_TEXT,
            parse_mode=None,
        )
        bot.pin_chat_message.assert_awaited_once_with(
            chat_id=-100123,
            message_id=501,
            disable_notification=True,
        )
        assert await service.instruction_message_id(-100123) == 501
    finally:
        await harness.shutdown_quick_reply_runtime()
        await database.dispose()


async def test_deleted_topic_is_recreated_and_valid_responses_are_restored(
    postgres_database_url: str,
) -> None:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    harness = QuickReplyHarness()
    try:
        service = QuickReplyService(database)
        saved = await service.save_valid(
            text="Сохранённый ответ #VPN",
            tags=["#VPN"],
            operator_telegram_id=7,
            operator_display_name="Operator",
            operator_username="operator",
            source_chat_id=-100123,
            source_message_id=401,
        )
        await service.save_instruction_message_id(-100123, 500, 777)
        missing_topic = TelegramBadRequest(
            method=EditMessageText(
                chat_id=-100123,
                message_id=500,
                text=QUICK_RESPONSE_INSTRUCTION_TEXT,
            ),
            message="Bad Request: message thread not found",
        )
        bot = _bot()
        bot.edit_message_text = AsyncMock(side_effect=missing_topic)
        bot.send_message = AsyncMock(
            side_effect=[
                SimpleNamespace(message_id=501),
                SimpleNamespace(message_id=502),
            ]
        )
        harness = _harness(service, bot)
        recover = AsyncMock(return_value=888)
        harness.recover_quick_replies_topic = recover

        await harness.ensure_quick_response_topic()

        recover.assert_awaited_once_with(777)
        assert harness.quick_replies_topic_id == 888
        assert [item.kwargs["message_thread_id"] for item in bot.send_message.await_args_list] == [
            888,
            888,
        ]
        assert bot.send_message.await_args_list[1].kwargs["text"] == render_quick_response(
            "Сохранённый ответ #VPN"
        )
        assert bot.send_message.await_args_list[1].kwargs[
            "reply_markup"
        ] == quick_response_delete_keyboard(saved.id)
        restored = await service.get_by_source(
            source_chat_id=-100123,
            source_message_id=401,
        )
        assert restored is not None
        assert restored.id == saved.id
        assert restored.published_message_id == 502
        assert restored.publication_format_version == QUICK_RESPONSE_PUBLICATION_FORMAT_VERSION
        assert restored.warning_message_id is None
        assert await service.instruction_message_id(-100123) == 501
    finally:
        await harness.shutdown_quick_reply_runtime()
        await database.dispose()


async def test_topic_recovered_before_adapter_start_restores_responses(
    postgres_database_url: str,
) -> None:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    harness = QuickReplyHarness()
    try:
        service = QuickReplyService(database)
        await service.save_valid(
            text="Ответ переживёт рестарт #VPN",
            tags=["#VPN"],
            operator_telegram_id=7,
            operator_display_name="Operator",
            operator_username="operator",
            source_chat_id=-100123,
            source_message_id=401,
        )
        await service.save_instruction_message_id(-100123, 500, 777)
        bot = _bot()
        bot.send_message = AsyncMock(
            side_effect=[
                SimpleNamespace(message_id=501),
                SimpleNamespace(message_id=502),
            ]
        )
        harness = _harness(service, bot)
        harness.quick_replies_topic_id = 888

        await harness.ensure_quick_response_topic()

        bot.edit_message_text.assert_not_awaited()
        assert [item.kwargs["message_thread_id"] for item in bot.send_message.await_args_list] == [
            888,
            888,
        ]
        assert bot.send_message.await_args_list[1].kwargs["text"] == (
            render_quick_response("Ответ переживёт рестарт #VPN")
        )
        assert await service.instruction_topic_id(-100123) == 888
    finally:
        await harness.shutdown_quick_reply_runtime()
        await database.dispose()


async def test_manually_deleted_active_response_is_restored_after_restart(
    postgres_database_url: str,
) -> None:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    harness = QuickReplyHarness()
    try:
        service = QuickReplyService(database)
        saved = await service.save_valid(
            text="Надёжный ответ #VPN",
            tags=["#VPN"],
            operator_telegram_id=7,
            operator_display_name="Operator",
            operator_username="operator",
            source_chat_id=-100123,
            source_message_id=301,
        )
        await service.record_publication(saved.id, 501)
        assert await service.complete_publication(saved.id, 501) is True
        missing_message = TelegramBadRequest(
            method=EditMessageText(
                chat_id=-100123,
                message_id=501,
                text=render_quick_response(saved.text),
            ),
            message="Bad Request: message to edit not found",
        )
        bot = _bot()
        bot.edit_message_text = AsyncMock(side_effect=missing_message)
        bot.send_message = AsyncMock(
            side_effect=[
                SimpleNamespace(message_id=600),
                SimpleNamespace(message_id=502),
            ]
        )
        harness = _harness(service, bot)

        await harness.ensure_quick_response_topic()

        restored = await service.get_by_source(
            source_chat_id=-100123,
            source_message_id=301,
        )
        assert restored is not None
        assert restored.state == QUICK_RESPONSE_VALID
        assert restored.published_message_id == 502
        assert bot.send_message.await_args_list[1].kwargs[
            "reply_markup"
        ] == quick_response_delete_keyboard(saved.id)
    finally:
        await harness.shutdown_quick_reply_runtime()
        await database.dispose()


async def test_pending_expirations_are_restored_after_restart(
    postgres_database_url: str,
) -> None:
    database = Database(postgres_database_url)
    await database.create_schema_for_tests()
    harness = QuickReplyHarness()
    try:
        service = QuickReplyService(database)
        await service.save_pending_deletion(
            text="Текст #1 #2 #3 #4 #5 #6",
            tags=["#1", "#2", "#3", "#4", "#5", "#6"],
            operator_telegram_id=7,
            operator_display_name="Operator",
            operator_username="operator",
            source_chat_id=-100123,
            source_message_id=301,
            invalid_until=datetime.now(UTC),
        )
        bot = _bot()
        harness = _harness(service, bot)

        await harness.restore_pending_quick_response_expirations()
        await asyncio.sleep(0.05)

        bot.delete_message.assert_awaited_with(chat_id=-100123, message_id=301)
    finally:
        await harness.shutdown_quick_reply_runtime()
        await database.dispose()


async def test_quick_response_topic_worker_refreshes_and_stops() -> None:
    refreshed = asyncio.Event()

    async def ensure_topic() -> None:
        refreshed.set()

    topic = SimpleNamespace(ensure_quick_response_topic=ensure_topic)
    worker = QuickResponseTopicRefreshWorker(
        topic,  # type: ignore[arg-type]
        interval_seconds=0.01,
    )
    task = asyncio.create_task(worker.run())

    await asyncio.wait_for(refreshed.wait(), timeout=1)
    worker.stop()
    await asyncio.wait_for(task, timeout=1)
