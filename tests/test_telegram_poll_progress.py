from datetime import timedelta
from unittest.mock import AsyncMock

import pytest
from aiogram import Bot
from aiogram.exceptions import TelegramNetworkError
from aiogram.methods import GetUpdates
from aiogram.types import Update

from resolvate.models import utcnow
from resolvate.telegram_poll_progress import TelegramPollProgress


async def test_entire_poll_batch_must_be_durable_before_deletion() -> None:
    progress = TelegramPollProgress()
    before = utcnow() - timedelta(seconds=1)
    assert not progress.ready_to_delete(before)
    request = GetUpdates()
    bot = Bot("123456:TEST_TOKEN")
    try:
        await progress(
            AsyncMock(return_value=[Update(update_id=1), Update(update_id=2)]), bot, request
        )
        assert not progress.ready_to_delete(before)
        progress.admitted(1)
        assert not progress.ready_to_delete(before)
        progress.admitted(2)
        assert progress.ready_to_delete(before)
        assert not progress.ready_to_delete(utcnow())
    finally:
        await bot.session.close()


async def test_failed_poll_or_stale_checkpoint_blocks_deletion() -> None:
    progress = TelegramPollProgress()
    before = utcnow() - timedelta(seconds=1)
    bot = Bot("123456:TEST_TOKEN")
    request = GetUpdates()
    try:
        await progress(AsyncMock(return_value=[]), bot, request)
        assert progress.ready_to_delete(before)
        with pytest.raises(TelegramNetworkError):
            await progress(
                AsyncMock(side_effect=TelegramNetworkError(method=request, message="unavailable")),
                bot,
                request,
            )
        assert not progress.ready_to_delete(before)
        await progress(AsyncMock(return_value=[]), bot, request)
        progress._drained_at = utcnow() - timedelta(minutes=2)
        assert not progress.ready_to_delete(utcnow() - timedelta(minutes=3))
    finally:
        await bot.session.close()
