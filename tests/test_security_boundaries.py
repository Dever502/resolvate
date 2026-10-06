from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from aiogram import Bot, Dispatcher
from aiogram.methods import SendMessage
from aiogram.types import Message, Update
from httpx import ASGITransport, AsyncClient
from project_support import ADMIN_ID, PROJECT_ID, ProjectDatabase
from sqlalchemy import select

from resolvate.api import MAX_API_JSON_REQUEST_BYTES, create_app
from resolvate.config import Settings
from resolvate.database import Database
from resolvate.delivery import DeliveryWorker
from resolvate.models import (
    ConsoleAccount,
    DeliveryOutbox,
    Direction,
    ProjectMember,
    TicketMessage,
    utcnow,
)
from resolvate.projects import ProjectService
from resolvate.runtime_defaults import API_AUTH_FAILURE_LIMIT
from resolvate.service_types import TicketNotFoundError
from resolvate.services import DeliveryJob, TicketService
from resolvate.telegram_adapter import TelegramSupportAdapter
from resolvate.telegram_limits import TelegramRateLimiter
from resolvate.telegram_message_utils import operator_reply_snapshot, reply_presentation
from resolvate.telegram_transcript import TranscriptIngressMiddleware
from resolvate.topic_archive import TopicArchiveRepository

TOKEN = "0123456789abcdef0123456789abcdef"
WEB_TOKEN = "abcdef0123456789abcdef0123456789"
TICKET_ID = "00000000-0000-4000-8000-000000000005"


@pytest.mark.parametrize("revoked,edited", [(True, True), (True, False), (False, True)])
async def test_queued_reply_uses_authorized_revision_not_live_source_or_transcript(
    postgres_database_url: str, tmp_path: Path, revoked: bool, edited: bool
) -> None:
    database = ProjectDatabase(postgres_database_url)
    await database.create_schema_for_tests()
    settings = Settings(
        _env_file=None,
        database_url=postgres_database_url,
        support_bot_token="123456:TEST_TOKEN",
        support_group_id=-100123,
        data_dir=tmp_path,
    )
    service = TicketService(database)
    projects = ProjectService(database, settings)
    archives = TopicArchiveRepository(database, settings)
    async with database.session() as session:
        admin = await session.get(ConsoleAccount, ADMIN_ID)
        assert admin is not None
        operator = ConsoleAccount(
            login="operator",
            display_name="Test",
            password_hash="not-a-login-password",
            role="operator",
            active=True,
            telegram_id=42,
        )
        session.add(operator)
        await session.flush()
        session.add(ProjectMember(project_id=PROJECT_ID, account_id=operator.id))
        await session.commit()
    ticket = await service.open_or_reopen(
        telegram_user_id=2001, display_name="Dummy customer", username=None
    )
    token = await service.claim_topic_provisioning(ticket.id)
    assert token is not None
    ticket = await service.attach_topic(ticket.id, 10, token=token)
    await archives.register_topic(ticket_id=ticket.id, topic_id=10, complete=True)
    bot = Bot("123456:TEST_TOKEN")
    actual_session = bot.session
    sent: list[SendMessage] = []

    async def capture(_bot: Bot, method: Any, **kwargs: Any) -> Message:
        # Any live copy (whether the source exists or is deleted) fails this test.
        assert isinstance(method, SendMessage)
        sent.append(method)
        return Message.model_validate(
            {
                "message_id": 900,
                "date": 1790850100,
                "chat": {"id": 2001, "type": "private"},
                "text": method.text,
            }
        )

    bot.session = AsyncMock(side_effect=capture)
    adapter = TelegramSupportAdapter(
        bot=bot, ticket_service=service, settings=settings, limiter=TelegramRateLimiter(0)
    )
    adapter.topic_archive = archives
    dispatcher = Dispatcher()
    adapter.router.message.outer_middleware(TranscriptIngressMiddleware(archives))
    adapter.router.edited_message.outer_middleware(TranscriptIngressMiddleware(archives))
    dispatcher.include_router(adapter.router)
    original = {
        "message_id": 101,
        "date": 1790850000,
        "chat": {"id": -100123, "type": "supergroup", "is_forum": True},
        "message_thread_id": 10,
        "is_topic_message": True,
        "from": {"id": 42, "is_bot": False, "first_name": "Dummy operator"},
        "text": "Original",
        "entities": [{"type": "bold", "offset": 0, "length": 8}],
    }
    try:
        assert await adapter.authorization.can_operate(42)
        await dispatcher.feed_update(
            bot, Update.model_validate({"update_id": 1, "message": original})
        )
        if revoked:
            await projects.change_member(admin, PROJECT_ID, "operator", remove=True)
            assert not await adapter.authorization.can_operate(42)
        if edited:
            change = {**original, "text": "Replaced", "entities": [], "edit_date": 1790850060}
            await dispatcher.feed_update(
                bot, Update.model_validate({"update_id": 2, "edited_message": change})
            )
        if revoked:
            new = {**original, "message_id": 102, "text": "Unauthorized new reply"}
            await dispatcher.feed_update(
                bot, Update.model_validate({"update_id": 3, "message": new})
            )
            async with database.session() as session:
                assert (
                    await session.scalar(
                        select(TicketMessage.id).where(TicketMessage.source_message_id == 102)
                    )
                    is None
                )
        accepted = "Replaced" if edited and not revoked else "Original"
        async with database.session() as session:
            assert (
                await session.scalar(
                    select(TicketMessage.content).where(TicketMessage.ticket_id == ticket.id)
                )
                == accepted
            )
        transcript = await archives.source_message(-100123, 101)
        assert transcript is not None and transcript["text"] == (
            "Replaced" if edited else "Original"
        )
        jobs = await service.outbox.claim_due_deliveries()
        assert len(jobs) == 1
        source = AsyncMock(side_effect=AssertionError("Must not read mutable transcript"))
        worker = DeliveryWorker(
            bot=bot,
            ticket_service=service,
            outbox=service.outbox,
            settings=settings,
            limiter=TelegramRateLimiter(0),
            heartbeat_path=tmp_path / "heartbeat",
            recover_missing_topic=AsyncMock(),
            source_snapshot=source,
        )
        await worker._deliver(jobs[0])
        assert len(sent) == 1 and sent[0].text == accepted and sent[0].chat_id == 2001
        assert sent[0].parse_mode is None
        assert bool(sent[0].entities) == (accepted == "Original")
        source.assert_not_called()
        async with database.session() as session:
            assert (
                await session.scalar(
                    select(DeliveryOutbox.status).where(DeliveryOutbox.id == jobs[0].id)
                )
                == "delivered"
            )
        with pytest.raises(TicketNotFoundError):
            await service.get_operator_reply(TICKET_ID, -100123, 101)
    finally:
        await adapter.shutdown_quick_reply_runtime()
        await dispatcher.storage.close()
        await actual_session.close()
        await database.dispose()


@pytest.mark.parametrize("kind", ["text", "photo", "video", "document", "voice"])
@pytest.mark.parametrize("legacy", [False, True])
async def test_accepted_reply_preserves_media_and_formatting(kind: str, legacy: bool) -> None:
    from resolvate.telegram_message_utils import media_metadata

    raw: dict[str, Any] = {
        "message_id": 1,
        "date": 1,
        "chat": {"id": -100123, "type": "supergroup"},
    }
    entity = [{"type": "bold", "offset": 0, "length": 5}]
    if kind == "text":
        raw.update(text="Hello", entities=entity)
    else:
        file = {
            "file_id": "accepted-file",
            "file_unique_id": "unique",
            "width": 10,
            "height": 10,
            "duration": 2,
        }
        raw[kind] = [file] if kind == "photo" else file
        raw.update(caption="Hello", caption_entities=entity, has_media_spoiler=True)
    message = Message.model_validate(raw)
    metadata = media_metadata(message) or {}
    if not legacy:
        metadata.update(reply_presentation(message))
    accepted = TicketMessage(
        source_chat_id=-100123,
        source_message_id=1,
        created_at=utcnow(),
        content="Hello",
        media=metadata,
    )
    bot = Bot("123456:TEST_TOKEN")
    original_session = bot.session
    bot.session = AsyncMock(return_value=SimpleNamespace(message_id=10))
    worker = DeliveryWorker(
        bot=bot,
        ticket_service=AsyncMock(),
        outbox=AsyncMock(),
        settings=Settings(_env_file=None),
        limiter=TelegramRateLimiter(0),
        heartbeat_path=Path("unused"),
        recover_missing_topic=AsyncMock(),
    )
    try:
        await worker._send_snapshot(
            {"target_chat_id": 2001, "snapshot": operator_reply_snapshot(accepted)}, None
        )
        method = bot.session.await_args.args[1]
        assert method.__api_method__ == ("sendMessage" if kind == "text" else "send" + kind.title())
        assert (method.text if kind == "text" else method.caption) == "Hello"
        assert bool(method.entities if kind == "text" else method.caption_entities) == (not legacy)
        assert method.parse_mode is None
        if kind != "text":
            assert getattr(method, kind) == "accepted-file"
        if kind in {"photo", "video"}:
            assert method.has_spoiler == (not legacy)
    finally:
        await original_session.close()


@pytest.mark.parametrize("missing", ["record", "text", "file"])
async def test_missing_accepted_content_never_falls_back_to_mutable_source(
    tmp_path: Path, missing: str
) -> None:
    service = AsyncMock(spec=TicketService)
    service.is_blocked.return_value = False
    if missing == "record":
        service.get_operator_reply.side_effect = TicketNotFoundError(TICKET_ID)
    else:
        service.get_operator_reply.return_value = TicketMessage(
            source_chat_id=-100123,
            source_message_id=1,
            created_at=utcnow(),
            content=None,
            media={"telegram_content_type": "photo"} if missing == "file" else {},
        )
    bot, outbox, source = AsyncMock(), AsyncMock(), AsyncMock()
    worker = DeliveryWorker(
        bot=bot,
        ticket_service=service,
        outbox=outbox,
        settings=Settings(_env_file=None),
        limiter=TelegramRateLimiter(0),
        heartbeat_path=tmp_path / "heartbeat",
        recover_missing_topic=AsyncMock(),
        source_snapshot=source,
    )
    await worker._deliver(
        DeliveryJob(
            id="job",
            ticket_id=TICKET_ID,
            claim_token="claim",
            attempt_count=1,
            direction=Direction.OPERATOR_TO_USER,
            payload={
                "kind": "copy",
                "source_chat_id": -100123,
                "source_message_id": 1,
                "target_chat_id": 2001,
            },
        )
    )
    source.assert_not_called()
    bot.assert_not_called()
    bot.copy_message.assert_not_called()
    outbox.mark_delivery_delivered.assert_not_called()
    outbox.mark_delivery_retry.assert_awaited_once()


def api_app(tmp_path: Path, **options: Any) -> Any:
    settings = Settings(
        _env_file=None,
        support_bot_token="test-token",
        support_group_id=-100123,
        data_dir=tmp_path,
        api_enabled=True,
        api_admin_token=TOKEN,
        web_api_enabled=True,
        web_api_token=WEB_TOKEN,
        **options,
    )
    service = AsyncMock(spec=TicketService)
    service.send_operator_message.return_value = SimpleNamespace(changed=True)
    return create_app(database=AsyncMock(spec=Database), ticket_service=service, settings=settings)


@pytest.mark.parametrize(
    "route",
    [
        f"/api/v1/tickets/{TICKET_ID}/messages",
        f"/api/v1/tickets/{TICKET_ID}/close",
        f"/api/v1/web/conversations/{TICKET_ID}/block",
        f"/api/v1/web/conversations/{TICKET_ID}/rating",
        "/api/v1/web/messages",
    ],
)
@pytest.mark.parametrize("credential", [None, "wrong-token", "wrong-realm"])
async def test_api_rejects_unauthenticated_json_without_reading_body(
    tmp_path: Path, route: str, credential: str | None
) -> None:
    async def unread_body() -> AsyncIterator[bytes]:
        raise AssertionError("Unauthorized body was read")
        yield b""  # pragma: no cover

    app = api_app(tmp_path)
    headers = {"Content-Type": "application/json", "X-Idempotency-Key": "dummy-key"}
    if credential is not None:
        headers["X-API-Token"] = (
            (TOKEN if "/web/" in route else WEB_TOKEN)
            if credential == "wrong-realm"
            else credential
        )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        responses = [
            await client.post(route, headers=headers, content=unread_body())
            for _ in range(API_AUTH_FAILURE_LIMIT + 1)
        ]
    assert [r.status_code for r in responses] == [401] * API_AUTH_FAILURE_LIMIT + [429]
    assert responses[-1].headers["Retry-After"]
    assert responses[-1].json()["error"]["trace_id"] == responses[-1].headers["X-Trace-ID"]


@pytest.mark.parametrize("declared", [None, "1", str(MAX_API_JSON_REQUEST_BYTES + 1)])
async def test_api_limits_actual_body_before_json_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, declared: str | None
) -> None:
    import starlette.requests

    def no_decode(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("Oversized JSON reached decoder")

    monkeypatch.setattr(starlette.requests.json, "loads", no_decode)
    reads = 0

    async def body() -> AsyncIterator[bytes]:
        nonlocal reads
        for part in (b" " * MAX_API_JSON_REQUEST_BYTES, b"{}", b"must not read"):
            reads += 1
            yield part

    headers = {
        "Content-Type": "application/json",
        "X-API-Token": TOKEN,
        "X-Idempotency-Key": "dummy-key",
    }
    if declared is not None:
        headers["Content-Length"] = declared
    async with AsyncClient(
        transport=ASGITransport(app=api_app(tmp_path)), base_url="http://test"
    ) as client:
        response = await client.post(
            f"/api/v1/tickets/{TICKET_ID}/messages", content=body(), headers=headers
        )
    assert response.status_code == 413
    assert reads == (0 if declared == str(MAX_API_JSON_REQUEST_BYTES + 1) else 2)


async def test_valid_json_at_limit_and_auth_quota_counted_once(tmp_path: Path) -> None:
    body = b'{"text":"Hello"}'
    body = b" " * (MAX_API_JSON_REQUEST_BYTES - len(body)) + body
    app = api_app(tmp_path, api_requests_per_minute=2)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        responses = [
            await client.post(
                f"/api/v1/tickets/{TICKET_ID}/messages",
                content=body,
                headers={
                    "Content-Type": "application/json",
                    "X-API-Token": TOKEN,
                    "X-Idempotency-Key": "dummy-key",
                },
            )
            for _ in range(3)
        ]
    assert [r.status_code for r in responses] == [200, 200, 429]


async def test_authenticated_malformed_json_consumes_quota(tmp_path: Path) -> None:
    reads = 0

    async def body() -> AsyncIterator[bytes]:
        nonlocal reads
        reads += 1
        yield b'{"text":!}'

    app = api_app(tmp_path, api_requests_per_minute=2)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        responses = [
            await client.post(
                f"/api/v1/tickets/{TICKET_ID}/messages",
                content=body(),
                headers={
                    "Content-Type": "application/json",
                    "X-API-Token": TOKEN,
                    "X-Idempotency-Key": "dummy-key",
                },
            )
            for _ in range(3)
        ]
    assert [r.status_code for r in responses] == [422, 422, 429]
    assert reads == 2
