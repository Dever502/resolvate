from __future__ import annotations

from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import Any

from aiogram import BaseMiddleware, Bot
from aiogram.client.session.middlewares.base import BaseRequestMiddleware, NextRequestMiddlewareType
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError, TelegramRetryAfter
from aiogram.methods import CopyMessage, Response, TelegramMethod
from aiogram.methods.base import TelegramType
from aiogram.types import Message, MessageId, TelegramObject

from resolvate.telegram_message_utils import media_metadata
from resolvate.topic_archive import TopicArchiveRepository

rotation_setup_context: ContextVar[str | None] = ContextVar("rotation_setup_context", default=None)


def message_snapshot(message: Message) -> dict[str, Any]:
    payload = message.model_dump(
        mode="json", by_alias=True, exclude_none=True, exclude={"reply_to_message"}
    )
    if message.reply_to_message is not None:
        payload["reply_to_message_id"] = message.reply_to_message.message_id
    return payload


class TranscriptIngressMiddleware(BaseMiddleware):
    def __init__(self, repository: TopicArchiveRepository) -> None:
        self.repository = repository

    async def __call__(
        self,
        handler: Callable[[TelegramObject, dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: dict[str, Any],
    ) -> Any:
        if (
            isinstance(event, Message)
            and event.chat.id == self.repository.settings.support_group_id
        ):
            topic_id = event.message_thread_id
            if topic_id is not None:
                await self.repository.observe(
                    topic_id=topic_id,
                    message_id=event.message_id,
                    payload=message_snapshot(event),
                    attachment=media_metadata(event),
                )
        return await handler(event, data)


class TranscriptRequestMiddleware(BaseRequestMiddleware):
    """Journal bot publications, including copyMessage which returns no message content.

    An uncertain HTTP outcome keeps its reservation: a topic cannot be automatically
    deleted when an outbound message may be missing from the independent transcript.
    """

    def __init__(self, repository: TopicArchiveRepository) -> None:
        self.repository = repository

    async def __call__(
        self,
        make_request: NextRequestMiddlewareType[TelegramType],
        bot: Bot,
        method: TelegramMethod[TelegramType],
    ) -> Response[TelegramType]:
        chat_id = getattr(method, "chat_id", None)
        topic_id = getattr(method, "message_thread_id", None)
        is_publication = method.__api_method__.startswith(("send", "copy", "forward"))
        if (
            chat_id != self.repository.settings.support_group_id
            or not isinstance(topic_id, int)
            or not is_publication
        ):
            return await make_request(bot, method)
        destination = await self.repository.publication_topic(topic_id)
        if destination != topic_id:
            topic_id = destination
            method = method.model_copy(
                update={
                    "message_thread_id": destination,
                    "reply_parameters": None,
                    "reply_to_message_id": None,
                }
            )
        reservation = await self.repository.begin_write(topic_id)
        if reservation is None:
            return await make_request(bot, method)
        source = None
        if isinstance(method, CopyMessage) and isinstance(method.from_chat_id, int):
            source = await self.repository.source_message(method.from_chat_id, method.message_id)
        try:
            result = await make_request(bot, method)
        except (TelegramBadRequest, TelegramForbiddenError, TelegramRetryAfter):
            # These explicit rejections prove no new message was created.
            await self.repository.finish_write(reservation)
            raise
        # Network/DB failures deliberately leave the reservation unresolved.
        items: list[Any] = list(result) if isinstance(result, list) else [result]
        complete = True
        for item in items:
            if isinstance(item, Message):
                message = item
            elif isinstance(item, MessageId) and source is not None:
                assert isinstance(method, CopyMessage)
                payload = {
                    **source,
                    "message_id": item.message_id,
                    "chat": {"id": chat_id, "type": "supergroup"},
                    "message_thread_id": topic_id,
                }
                # Preserve the original author, timestamp and source as transcript metadata.
                payload["source_chat_id"] = method.from_chat_id
                payload["source_message_id"] = method.message_id
                message = Message.model_validate(payload)
            else:
                complete = False
                continue
            snapshot = message_snapshot(message)
            if setup_id := rotation_setup_context.get():
                snapshot["rotation_setup_id"] = setup_id
            await self.repository.observe(
                topic_id=topic_id,
                message_id=message.message_id,
                payload=snapshot,
                attachment=media_metadata(message),
            )
        await self.repository.finish_write(reservation, complete=complete)
        return result
