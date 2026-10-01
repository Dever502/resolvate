from __future__ import annotations

import asyncio
from datetime import timedelta
from unittest.mock import AsyncMock, Mock

import pytest
from aiogram import Bot, Dispatcher
from aiogram.methods import GetUpdates
from aiogram.types import Update, User

from resolvate.models import utcnow
from resolvate.telegram_ingress import DurableTelegramIngressMiddleware
from resolvate.telegram_limits import TelegramRateLimiter
from resolvate.telegram_poll_progress import TelegramPollProgress
from resolvate.user_message_limits import UserMessageRateLimitDecision


@pytest.mark.parametrize("rate_limited", [False, True])
@pytest.mark.parametrize("cancel_during_outage", [False, True])
@pytest.mark.parametrize("failures", [1, 6])
async def test_polling_does_not_ack_failed_admission(
    monkeypatch: pytest.MonkeyPatch, rate_limited: bool, cancel_during_outage: bool, failures: int
) -> None:
    """Exercise aiogram's real poll/exception/offset path without a Telegram connection."""
    update = Update.model_validate(
        {
            "update_id": 101,
            "message": {
                "message_id": 1,
                "date": 0,
                "chat": {"id": 42, "type": "private"},
                "from": {"id": 42, "is_bot": False, "first_name": "Customer"},
                "text": "accepted once",
            },
        }
    )
    progress = TelegramPollProgress()
    before = utcnow() - timedelta(seconds=1)
    repository = AsyncMock()
    # False models a commit that succeeded but lost its acknowledgement: replay is a no-op.
    repository.enqueue_inbound_update.side_effect = [OSError("database unavailable")] * failures + [
        False
    ]
    limiter = AsyncMock()
    limiter.consume.return_value = UserMessageRateLimitDecision(
        allowed=not rate_limited, notify_operators=rate_limited
    )
    wake = Mock()
    bot = Bot("123456:TEST_TOKEN")
    dispatcher = Dispatcher()
    dispatcher.update.outer_middleware(
        DurableTelegramIngressMiddleware(
            repository,
            wake,
            bot=bot,
            inbound_limiter=limiter,
            outbound_limiter=TelegramRateLimiter(0.001),
            poll_progress=progress,
        )
    )
    monkeypatch.setattr(
        bot,
        "me",
        AsyncMock(
            return_value=User(id=123456, is_bot=True, first_name="Test", username="test_bot")
        ),
    )
    retry_wait = asyncio.Event()
    release_retry = asyncio.Event()
    acknowledged = asyncio.Event()
    offsets: list[int | None] = []
    delays: list[float] = []

    async def retry_sleep(delay: float) -> None:
        assert 0 < delay <= 5
        delays.append(delay)
        retry_wait.set()
        await release_retry.wait()

    monkeypatch.setattr("resolvate.telegram_ingress.asyncio.sleep", retry_sleep)

    async def request(_bot: Bot, method: GetUpdates, **kwargs: object) -> list[Update]:
        offsets.append(method.offset)
        if len(offsets) == 1:
            return await progress(AsyncMock(return_value=[update]), bot, method)
        acknowledged.set()
        await asyncio.Event().wait()
        return []  # pragma: no cover

    monkeypatch.setattr(bot, "session", AsyncMock(side_effect=request, timeout=30))
    task = asyncio.create_task(dispatcher._polling(bot, handle_as_tasks=False))
    try:
        async with asyncio.timeout(2):
            await retry_wait.wait()
        assert offsets == [None]
        assert not progress.ready_to_delete(before)
        wake.assert_not_called()
        if cancel_during_outage:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert offsets == [None]
            assert repository.enqueue_inbound_update.await_count == 1
            assert not progress.ready_to_delete(before)
        else:
            release_retry.set()
            async with asyncio.timeout(2):
                await acknowledged.wait()
            assert offsets == [None, 102]
            calls = repository.enqueue_inbound_update.await_args_list
            assert len(calls) == failures + 1 and all(call == calls[0] for call in calls)
            assert delays == [1, 2, 4, 5, 5, 5][:failures]
            payload = calls[1].args[1]
            if rate_limited:
                assert payload == {"resolvate_event": "rate_limit", "telegram_user_id": 42}
            else:
                assert payload["message"]["text"] == "accepted once"
            assert progress.ready_to_delete(before)
            wake.assert_called_once_with()
        limiter.consume.assert_awaited_once_with("telegram:42")
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await dispatcher.storage.close()
