from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from aiogram import Bot
from aiogram.exceptions import TelegramBadRequest, TelegramNetworkError
from aiogram.methods import CopyMessage, SendMessage
from aiogram.types import Chat, Message, MessageId, User

from resolvate.telegram_transcript import (
    TranscriptIngressMiddleware,
    TranscriptRequestMiddleware,
    rotation_setup_context,
)
from resolvate.topic_archive import TopicArchiveRepository


def message(message_id: int = 8, text: str = "Example") -> Message:
    return Message(
        message_id=message_id,
        date=datetime(2026, 1, 1, tzinfo=UTC),
        chat=Chat(id=-100123, type="supergroup"),
        message_thread_id=10,
        from_user=User(id=42, is_bot=False, first_name="Operator"),
        text=text,
    )


def repository() -> AsyncMock:
    repo = AsyncMock(spec=TopicArchiveRepository)
    repo.settings = type("Settings", (), {"support_group_id": -100123})()
    repo.begin_write.return_value = "archive-test"
    repo.publication_topic.side_effect = lambda topic_id: topic_id
    return repo


async def test_ingress_records_commands_before_handler() -> None:
    repo = repository()
    handler = AsyncMock(return_value="handled")
    result = await TranscriptIngressMiddleware(repo)(handler, message(text="/stop"), {})
    assert result == "handled"
    assert repo.observe.await_args.kwargs["payload"]["text"] == "/stop"
    handler.assert_awaited_once()


async def test_outbound_bot_card_is_counted_and_write_reservation_released() -> None:
    repo = repository()
    request = SendMessage(chat_id=-100123, message_thread_id=10, text="Example")
    response = AsyncMock(return_value=message())
    bot = Bot("123456:TEST_TOKEN")
    try:
        await TranscriptRequestMiddleware(repo)(response, bot, request)
    finally:
        await bot.session.close()
    repo.begin_write.assert_awaited_once_with(10)
    repo.observe.assert_awaited_once()
    repo.finish_write.assert_awaited_once_with("archive-test", complete=True)


async def test_copy_response_preserves_source_content_and_author() -> None:
    repo = repository()
    source = message().model_dump(mode="json", exclude_none=True)
    source["chat"] = {"id": 777, "type": "private"}
    repo.source_message.return_value = source
    response = AsyncMock(return_value=MessageId(message_id=99))
    request = CopyMessage(chat_id=-100123, message_thread_id=10, from_chat_id=777, message_id=8)
    bot = Bot("123456:TEST_TOKEN")
    try:
        await TranscriptRequestMiddleware(repo)(response, bot, request)
    finally:
        await bot.session.close()
    recorded = repo.observe.await_args.kwargs
    assert recorded["message_id"] == 99
    assert recorded["payload"]["text"] == "Example"
    assert recorded["payload"]["from"]["id"] == 42
    assert recorded["payload"]["source_chat_id"] == 777


@pytest.mark.parametrize("uncertain", [False, True])
async def test_uncertain_telegram_outcome_keeps_durable_write_reservation(uncertain: bool) -> None:
    repo = repository()
    request = SendMessage(chat_id=-100123, message_thread_id=10, text="Example")
    exception = TelegramNetworkError if uncertain else TelegramBadRequest
    response = AsyncMock(side_effect=exception(method=request, message="failed"))
    bot = Bot("123456:TEST_TOKEN")
    try:
        with pytest.raises(exception):
            await TranscriptRequestMiddleware(repo)(response, bot, request)
    finally:
        await bot.session.close()
    if uncertain:
        repo.finish_write.assert_not_awaited()
    else:
        repo.finish_write.assert_awaited_once_with("archive-test")


async def test_missing_copy_source_marks_archive_incomplete() -> None:
    repo = repository()
    repo.source_message.return_value = None
    request = CopyMessage(chat_id=-100123, message_thread_id=10, from_chat_id=777, message_id=8)
    bot = Bot("123456:TEST_TOKEN")
    try:
        await TranscriptRequestMiddleware(repo)(
            AsyncMock(return_value=MessageId(message_id=99)), bot, request
        )
    finally:
        await bot.session.close()
    repo.finish_write.assert_awaited_once_with("archive-test", complete=False)


async def test_late_bot_reply_is_routed_to_current_topic_without_old_reply_reference() -> None:
    from aiogram.types import ReplyParameters

    repo = repository()
    repo.publication_topic.side_effect = None
    repo.publication_topic.return_value = 20
    request = SendMessage(
        chat_id=-100123,
        message_thread_id=10,
        text="Reply",
        reply_parameters=ReplyParameters(message_id=5),
    )
    response = AsyncMock(return_value=message().model_copy(update={"message_thread_id": 20}))
    bot = Bot("123456:TEST_TOKEN")
    try:
        await TranscriptRequestMiddleware(repo)(response, bot, request)
    finally:
        await bot.session.close()
    actual = response.await_args.args[1]
    assert actual.message_thread_id == 20
    assert actual.reply_parameters is None
    assert request.message_thread_id == 10
    repo.begin_write.assert_awaited_once_with(20)


async def test_setup_checkpoint_is_journal_metadata_not_an_extra_telegram_parameter() -> None:
    repo = repository()
    request = SendMessage(chat_id=-100123, message_thread_id=10, text="Card")
    response = AsyncMock(return_value=message(text="Card"))
    bot = Bot("123456:TEST_TOKEN")
    token = rotation_setup_context.set("archive-test")
    try:
        await TranscriptRequestMiddleware(repo)(response, bot, request)
    finally:
        rotation_setup_context.reset(token)
        await bot.session.close()
    assert repo.observe.await_args.kwargs["payload"]["rotation_setup_id"] == "archive-test"
    assert "rotation_setup_id" not in response.await_args.args[1].model_dump()
    assert rotation_setup_context.get() is None
