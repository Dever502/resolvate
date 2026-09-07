from __future__ import annotations

from datetime import datetime, timedelta

from aiogram import Bot
from aiogram.client.session.middlewares.base import BaseRequestMiddleware, NextRequestMiddlewareType
from aiogram.methods import Response, TelegramMethod
from aiogram.methods.base import TelegramType

from resolvate.models import utcnow


class TelegramPollProgress(BaseRequestMiddleware):
    """Deletion requires a post-cutover poll batch durably admitted in its entirety."""

    def __init__(self) -> None:
        self._pending: set[int] = set()
        self._batch_started_at: datetime | None = None
        self._drained_at: datetime | None = None
        self._healthy = False

    async def __call__(
        self,
        make_request: NextRequestMiddlewareType[TelegramType],
        bot: Bot,
        method: TelegramMethod[TelegramType],
    ) -> Response[TelegramType]:
        if method.__api_method__ != "getUpdates":
            return await make_request(bot, method)
        started = utcnow()
        try:
            result = await make_request(bot, method)
        except BaseException:
            self._healthy = False
            raise
        if not isinstance(result, list):
            self._healthy = False
            return result
        self._batch_started_at = started
        self._pending = {update.update_id for update in result}
        self._healthy = True
        if not self._pending:
            self._drained_at = started
        return result

    def admitted(self, update_id: int) -> None:
        self._pending.discard(update_id)
        if not self._pending:
            self._drained_at = self._batch_started_at

    def ready_to_delete(self, since: datetime | None) -> bool:
        return bool(
            since is not None
            and self._healthy
            and not self._pending
            and self._drained_at is not None
            and self._drained_at >= since
            and self._drained_at >= utcnow() - timedelta(seconds=60)
        )
