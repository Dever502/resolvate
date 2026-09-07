from __future__ import annotations

import asyncio
import logging

from aiogram import Bot
from aiogram.exceptions import (
    TelegramAPIError,
    TelegramBadRequest,
    TelegramForbiddenError,
    TelegramRetryAfter,
)
from aiogram.types import LinkPreviewOptions

from resolvate.operational_notices import OperationalNoticeRepository
from resolvate.runtime_supervision import wait_for_event
from resolvate.telegram_limits import TelegramRateLimiter

logger = logging.getLogger(__name__)


class GeneralNoticeWorker:
    def __init__(
        self,
        repository: OperationalNoticeRepository,
        bot: Bot,
        support_group_id: int,
        limiter: TelegramRateLimiter,
    ) -> None:
        self.repository = repository
        self.bot = bot
        self.support_group_id = support_group_id
        self.limiter = limiter
        self._stopped = asyncio.Event()
        self._lock = asyncio.Lock()

    def stop(self) -> None:
        self._stopped.set()

    async def run(self) -> None:
        while not self._stopped.is_set():
            try:
                await self.tick()
            except Exception as error:
                # No recursive notice about the notice transport, and no exception bodies.
                logger.warning(
                    "General notification delivery deferred",
                    extra={
                        "event": "general_notice_failed",
                        "exception_type": type(error).__name__,
                    },
                )
            await wait_for_event(self._stopped, 5)

    async def tick(self) -> None:
        async with self._lock:
            delivery = await self.repository.claim()
            if delivery is None:
                return
            try:
                await self.limiter.wait()
                # No thread/reply target: Telegram routes this message to General.
                await self.bot.send_message(
                    chat_id=self.support_group_id,
                    text=delivery.text(),
                    parse_mode=None,
                    link_preview_options=LinkPreviewOptions(is_disabled=True),
                    request_timeout=30,
                )
            except TelegramRetryAfter as error:
                await self.limiter.defer(error.retry_after)
                await self.repository.retry(delivery, max(60, error.retry_after))
            except (TelegramBadRequest, TelegramForbiddenError):
                # Do not unhide/reopen General or change group permissions automatically.
                logger.warning(
                    "General notification rejected; retry scheduled",
                    extra={"event": "general_notice_rejected"},
                )
                await self.repository.retry(delivery, 300)
            except (TelegramAPIError, OSError, TimeoutError):
                # Unknown outcome: preserve the pre-send one-hour cooldown.
                logger.warning(
                    "General notification outcome unknown",
                    extra={"event": "general_notice_uncertain"},
                )
            else:
                await self.repository.delivered(delivery)
