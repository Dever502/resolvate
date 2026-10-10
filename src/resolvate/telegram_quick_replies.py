"""Read-only Telegram projection of the shared, Web-managed quick response catalog."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

from aiogram import Bot
from aiogram.exceptions import TelegramAPIError, TelegramBadRequest, TelegramRetryAfter
from aiogram.types import CallbackQuery, Message, MessageEntity

from resolvate.authorization import AuthorizationService
from resolvate.config import Settings
from resolvate.quick_replies import QuickReplyService, QuickResponseView, utf16_code_units
from resolvate.telegram_errors import is_missing_topic_error
from resolvate.telegram_limits import TelegramRateLimiter

logger = logging.getLogger(__name__)
QUICK_RESPONSE_TOPIC_REFRESH_INTERVAL_SECONDS = 15.0
# Acknowledge obsolete keyboards without allowing them to mutate the catalog.
QUICK_RESPONSE_DELETE_CALLBACK_PREFIX = "quick_response_delete"
QUICK_RESPONSE_DELETED_TEXT = "🗑 Ответ удалён"
QUICK_RESPONSE_INSTRUCTION_TEXT = (
    "⚡ Готовые ответы\n\n"
    "Найдите группу (например, /оплата) или текст через лупу Telegram. "
    "Скопируйте текст из блока ответа и вставьте клиенту.\n\n"
    "Создание, изменение и удаление ответов — в веб-панели проекта. "
    "Этот топик обновляется автоматически. Новые ответы появляются в конце."
)


def publication(response: QuickResponseView) -> tuple[str, list[MessageEntity]]:
    heading = f"/{response.group_name}\n\n"
    # Entities preserve literal HTML, backticks and emoji without parsing user content.
    return heading + response.text, [
        MessageEntity(
            type="pre", offset=utf16_code_units(heading), length=utf16_code_units(response.text)
        )
    ]


class TelegramQuickReplyHandlers:
    bot: Bot
    authorization: AuthorizationService
    limiter: TelegramRateLimiter
    settings: Settings
    quick_reply_service: QuickReplyService | None
    quick_replies_topic_id: int | None = None
    recover_quick_replies_topic: Callable[[int], Awaitable[int]] | None
    _quick_response_topic_lock: asyncio.Lock
    _quick_response_catalog_verified: bool

    def initialize_quick_reply_runtime(self) -> None:
        self._quick_response_topic_lock = asyncio.Lock()
        self._quick_response_catalog_verified = False

    async def _edit_bot_message(
        self, message_id: int, text: str, entities: list[MessageEntity] | None = None
    ) -> bool:
        try:
            await self.limiter.wait()
            await self.bot.edit_message_text(
                chat_id=self.settings.support_group_id,
                message_id=message_id,
                text=text,
                entities=entities,
                parse_mode=None,
                reply_markup=None,
            )
        except TelegramBadRequest as error:
            detail = str(error).casefold()
            if "message is not modified" in detail:
                return True
            if "message to edit not found" in detail or "message_id_invalid" in detail:
                return False
            raise
        return True

    async def _delete_message(self, message_id: int, *, tombstone: bool = False) -> bool:
        try:
            await self.limiter.wait()
            await self.bot.delete_message(
                chat_id=self.settings.support_group_id, message_id=message_id
            )
        except TelegramRetryAfter:
            raise
        except TelegramBadRequest as error:
            detail = str(error).casefold()
            if "message to delete not found" in detail or "message_id_invalid" in detail:
                return True
            if tombstone and (
                "message can't be deleted" in detail or "message cannot be deleted" in detail
            ):
                await self._edit_bot_message(message_id, QUICK_RESPONSE_DELETED_TEXT)
                return True
            return False
        except TelegramAPIError:
            return False
        return True

    async def _publish_valid_response(self, response: QuickResponseView) -> None:
        assert self.quick_reply_service is not None
        rendered, entities = publication(response)
        message_id = response.published_message_id
        if message_id == response.source_message_id:
            message_id = None
        if message_id is not None and not await self._edit_bot_message(
            message_id, rendered, entities
        ):
            message_id = None
        if message_id is None:
            await self.limiter.wait()
            sent = await self.bot.send_message(
                chat_id=self.settings.support_group_id,
                message_thread_id=self.quick_replies_topic_id,
                text=rendered,
                entities=entities,
                parse_mode=None,
                disable_notification=True,
            )
            message_id = sent.message_id
            await self.quick_reply_service.record_publication(response.id, message_id)
        if response.warning_message_id is not None:
            if not await self._delete_message(response.warning_message_id, tombstone=True):
                return
            await self.quick_reply_service.clear_warning(response.id, response.warning_message_id)
        await self.quick_reply_service.complete_publication(
            response.id, message_id, revision=response.revision
        )

    async def _restore_valid_responses(self, *, verify_existing: bool = False) -> None:
        assert self.quick_reply_service is not None
        after_id = 0
        while candidates := await self.quick_reply_service.list_publication_candidates(
            after_id=after_id, include_complete=verify_existing
        ):
            for candidate in candidates:
                response = await self.quick_reply_service.get(candidate.id)
                if response is not None and response.state == "valid":
                    await self._publish_valid_response(response)
            after_id = candidates[-1].id

    async def _cleanup_deleted_publications(self) -> None:
        assert self.quick_reply_service is not None
        after_id = 0
        while candidates := await self.quick_reply_service.list_deleted_with_publication(
            after_id=after_id
        ):
            for response in candidates:
                message_id = response.published_message_id
                if message_id is not None and await self._delete_message(
                    message_id, tombstone=True
                ):
                    await self.quick_reply_service.clear_deleted_publication(
                        response.id, published_message_id=message_id
                    )
            after_id = candidates[-1].id

    async def _send_instruction(self) -> int:
        assert self.quick_reply_service is not None
        assert self.quick_replies_topic_id is not None
        await self.limiter.wait()
        sent = await self.bot.send_message(
            chat_id=self.settings.support_group_id,
            message_thread_id=self.quick_replies_topic_id,
            text=QUICK_RESPONSE_INSTRUCTION_TEXT,
            parse_mode=None,
            disable_notification=True,
        )
        await self.quick_reply_service.save_instruction_message_id(
            self.settings.support_group_id, sent.message_id, self.quick_replies_topic_id
        )
        return sent.message_id

    async def ensure_quick_response_topic(self) -> None:
        if self.quick_reply_service is None or self.quick_replies_topic_id is None:
            return
        async with self._quick_response_topic_lock:
            try:
                try:
                    await self._sync_catalog()
                except TelegramBadRequest as error:
                    if (
                        not is_missing_topic_error(error)
                        or self.recover_quick_replies_topic is None
                    ):
                        raise
                    self.quick_replies_topic_id = await self.recover_quick_replies_topic(
                        self.quick_replies_topic_id
                    )
                    await self._sync_catalog()
            except TelegramRetryAfter as error:
                await self.limiter.defer(error.retry_after)
                logger.info(
                    "Quick response sync deferred by Telegram",
                    extra={"event": "quick_response_sync_deferred"},
                )
            except TelegramAPIError as error:
                logger.warning(
                    "Quick response sync will retry",
                    extra={
                        "event": "quick_response_sync_failed",
                        "exception_type": type(error).__name__,
                    },
                )

    async def _sync_catalog(self) -> None:
        assert self.quick_reply_service is not None
        service = self.quick_reply_service
        old_topic = await service.instruction_topic_id(self.settings.support_group_id)
        replaced = old_topic is not None and old_topic != self.quick_replies_topic_id
        instruction = await service.instruction_message_id(self.settings.support_group_id)
        # Invalidate old message IDs before saving the new topic, making retries safe.
        if replaced:
            await service.reset_publications()
        if (
            replaced
            or instruction is None
            or not await self._edit_bot_message(instruction, QUICK_RESPONSE_INSTRUCTION_TEXT)
        ):
            instruction = await self._send_instruction()
            self._quick_response_catalog_verified = False
        if not self._quick_response_catalog_verified:
            await self.limiter.wait()
            await self.bot.pin_chat_message(
                chat_id=self.settings.support_group_id,
                message_id=instruction,
                disable_notification=True,
            )
        for message_id in await service.legacy_message_ids(self.settings.support_group_id):
            if message_id != instruction and not await self._delete_message(
                message_id, tombstone=True
            ):
                break
        else:
            await service.finish_legacy_cleanup(self.settings.support_group_id)
        await self._cleanup_deleted_publications()
        await self._restore_valid_responses(
            verify_existing=not self._quick_response_catalog_verified
        )
        self._quick_response_catalog_verified = True

    async def handle_quick_reply_topic_message(self, message: Message, command: str = "") -> bool:
        del command
        if (
            self.quick_replies_topic_id is None
            or message.message_thread_id != self.quick_replies_topic_id
        ):
            return False
        if message.text and message.from_user and not message.from_user.is_bot:
            await self.limiter.wait()
            await message.reply(
                "Готовые ответы теперь создаются и изменяются в веб-панели проекта. "
                "Этот топик — копия каталога для поиска и копирования.",
                parse_mode=None,
            )
        return True

    async def handle_quick_response_delete_callback(self, callback: CallbackQuery) -> None:
        await callback.answer(
            "Управление готовыми ответами перенесено в веб-панель проекта.", show_alert=True
        )

    async def restore_pending_quick_response_expirations(self) -> None:
        # Old invalid drafts remain in the DB, but are no longer deleted by a timer.
        return

    async def shutdown_quick_reply_runtime(self) -> None:
        return


class QuickResponseTopicRefreshWorker:
    def __init__(
        self,
        topic: TelegramQuickReplyHandlers,
        *,
        interval_seconds: float = QUICK_RESPONSE_TOPIC_REFRESH_INTERVAL_SECONDS,
    ) -> None:
        self.topic = topic
        self.interval_seconds = interval_seconds
        self._stopping = asyncio.Event()

    def stop(self) -> None:
        self._stopping.set()

    async def run(self) -> None:
        while not self._stopping.is_set():
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=self.interval_seconds)
            except TimeoutError:
                try:
                    await self.topic.ensure_quick_response_topic()
                except Exception:
                    logger.exception(
                        "Unable to refresh quick response topic",
                        extra={"event": "quick_response_topic_refresh_failed"},
                    )
