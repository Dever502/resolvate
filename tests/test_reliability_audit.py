from __future__ import annotations

import asyncio
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from aiogram.exceptions import TelegramBadRequest, TelegramRetryAfter
from aiogram.methods import AnswerCallbackQuery, CreateForumTopic, SendMessage
from fastapi import HTTPException
from sqlalchemy.exc import OperationalError
from test_console import PASSWORD
from test_console import console as console
from test_delivery_claims import enqueue_and_claim, load_delivery
from test_delivery_claims import ticket_service as ticket_service
from test_topic_recovery import RecoveryBot, recovery_adapter, recovery_settings

from resolvate.delivery import DeliveryWorker
from resolvate.installation import ProjectManager
from resolvate.models import DeliveryOutbox, DeliveryStatus, Ticket, utcnow
from resolvate.services import TicketService


async def test_one_login_client_cannot_exhaust_installation_budget(console: Any) -> None:
    auth = console[3]
    for index in range(65):
        with pytest.raises(HTTPException) as error:
            await auth.login(f"missing{index}", "wrong-password", "abusive-client")
        assert error.value.status_code in {401, 429}
    account, _ = await auth.login("admin", PASSWORD, "independent-client")
    assert account.login == "admin"


@pytest.mark.parametrize("flood", [False, True])
async def test_definite_topic_refusal_releases_claim(
    ticket_service: TicketService, tmp_path: Path, flood: bool
) -> None:
    ticket = await ticket_service.open_or_reopen(
        telegram_user_id=1234, display_name="Client", username=None
    )
    bot = RecoveryBot(replacement_topic_id=321)
    adapter = recovery_adapter(
        service=ticket_service, bot=bot, settings=recovery_settings(tmp_path)
    )
    method = CreateForumTopic(chat_id=-100123, name="topic")
    refusal = (
        TelegramRetryAfter(method=method, message="flood", retry_after=1)
        if flood
        else TelegramBadRequest(method=method, message="not enough rights")
    )
    original = bot.create_forum_topic
    bot.create_forum_topic = AsyncMock(side_effect=refusal)
    with pytest.raises(type(refusal)):
        await adapter._ensure_topic(ticket)
    async with ticket_service.database.session() as session:
        row = await session.get(Ticket, ticket.id)
        assert row.topic_provisioning_token is None
    bot.create_forum_topic = original
    assert (await adapter._ensure_topic(ticket)).topic_id == 321


async def test_flood_control_never_exhausts_delivery_attempts(
    ticket_service: TicketService, tmp_path: Path
) -> None:
    job = await enqueue_and_claim(ticket_service, telegram_user_id=1234, key="flood")
    bot = SimpleNamespace(
        send_message=AsyncMock(
            side_effect=TelegramRetryAfter(
                method=SendMessage(chat_id=1234, text="hello"), message="flood", retry_after=30
            )
        )
    )
    worker = DeliveryWorker(
        bot=bot,
        ticket_service=ticket_service,
        outbox=ticket_service.outbox,
        settings=recovery_settings(tmp_path),
        limiter=SimpleNamespace(wait=AsyncMock(), defer=AsyncMock()),
        heartbeat_path=tmp_path / "heartbeat",
        recover_missing_topic=AsyncMock(),
    )
    for _ in range(10):
        await worker._deliver(job)
        row = await load_delivery(ticket_service, job.id)
        assert row.status == DeliveryStatus.PENDING
        assert row.payload and row.attempt_count == 0
        assert row.next_attempt_at > utcnow() + timedelta(seconds=20)
        async with ticket_service.database.session() as session:
            stored = await session.get(DeliveryOutbox, job.id)
            stored.next_attempt_at = utcnow() - timedelta(seconds=1)
            await session.commit()
        job = (await ticket_service.outbox.claim_due_deliveries())[0]
    bot.send_message.side_effect = None
    bot.send_message.return_value = SimpleNamespace(message_id=555)
    await worker._deliver(job)
    assert (await load_delivery(ticket_service, job.id)).status == DeliveryStatus.DELIVERED


async def test_expired_rating_ack_does_not_retry_committed_rating(
    ticket_service: TicketService, tmp_path: Path
) -> None:
    ticket = await ticket_service.open_or_reopen(
        telegram_user_id=1234, display_name="Client", username=None
    )
    await ticket_service.close(ticket_id=ticket.id, operator_telegram_id=1)
    adapter = recovery_adapter(
        service=ticket_service,
        bot=RecoveryBot(replacement_topic_id=321),
        settings=recovery_settings(tmp_path),
    )
    callback = SimpleNamespace(
        data=f"rating:{ticket.id}:1:5",
        from_user=SimpleNamespace(id=1234),
        message=None,
        answer=AsyncMock(
            side_effect=TelegramBadRequest(
                method=AnswerCallbackQuery(callback_query_id="old"), message="query is too old"
            )
        ),
    )
    await adapter.handle_rating_callback(callback)
    callback.answer.assert_awaited_once()


async def test_flood_deferral_rejects_stale_claim_and_preserves_previous_failures(
    ticket_service: TicketService,
) -> None:
    job = await enqueue_and_claim(ticket_service, telegram_user_id=1234, key="stale-flood")
    async with ticket_service.database.session() as session:
        stored = await session.get(DeliveryOutbox, job.id)
        stored.attempt_count = 4
        await session.commit()
    assert not await ticket_service.outbox.defer_delivery(
        job.id, claim_token="old-claim", retry_after_seconds=30
    )
    stored = await load_delivery(ticket_service, job.id)
    assert stored.status == DeliveryStatus.PROCESSING and stored.attempt_count == 4
    assert await ticket_service.outbox.defer_delivery(
        job.id, claim_token=job.claim_token, retry_after_seconds=30
    )
    stored = await load_delivery(ticket_service, job.id)
    assert stored.status == DeliveryStatus.PENDING and stored.attempt_count == 3


async def test_manager_survives_transient_database_poll_failure(
    console: Any, caplog: pytest.LogCaptureFixture
) -> None:
    database = console[1]
    manager = ProjectManager(database, recovery_settings(Path("unused")))
    attempts = 0

    async def reconcile() -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise OperationalError("poll", {}, RuntimeError("private connection details"))
        manager.stopping.set()

    manager.reconcile = reconcile
    await asyncio.wait_for(manager.run(), 5)
    assert attempts == 2
    assert "private connection details" not in caplog.text
    assert any(
        getattr(record, "exception_type", None) == "OperationalError" for record in caplog.records
    )
