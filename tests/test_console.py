from __future__ import annotations

import asyncio
import io
import uuid
from collections.abc import AsyncIterator
from datetime import timedelta
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from aiogram.types import Message
from fastapi import HTTPException
from PIL import Image
from project_support import ProjectDatabase as Database
from pypdf import PdfWriter
from sqlalchemy import func, select
from starlette.datastructures import Headers, UploadFile

from resolvate.api import create_app
from resolvate.config import Settings
from resolvate.console_auth import ConsoleAuth, digest, password_hash, verify_password
from resolvate.media_storage import LocalMediaStorage, MediaValidationError
from resolvate.models import (
    ConsoleSend,
    ConsoleSession,
    DeliveryOutbox,
    DeliveryStatus,
    Direction,
    ProjectMember,
    TicketMessage,
    utcnow,
)
from resolvate.services import TicketService
from resolvate.telegram_attachments import record_edit, save_attachment
from resolvate.web_models import MediaAsset

PASSWORD = "console-test-password-only"
ORIGIN = "http://localhost:8080"


@pytest.fixture
async def console(migrated_postgres_database_url: str, tmp_path: Path) -> AsyncIterator[Any]:
    settings = Settings(
        _env_file=None,
        database_url=migrated_postgres_database_url,
        support_bot_token="123456:TEST",
        support_group_id=-100123456,
        console_origin=ORIGIN,
        data_dir=tmp_path,
        admin_telegram_ids=frozenset({1}),
    )
    database = Database(migrated_postgres_database_url)
    tickets = TicketService(database)
    storage = LocalMediaStorage(tmp_path)
    app = create_app(
        database=database, ticket_service=tickets, settings=settings, media_storage=storage
    )
    auth = ConsoleAuth(database, ORIGIN)
    admin = await auth.create_account(
        login="admin", name="Администратор", password=PASSWORD, role="admin", bootstrap=True
    )
    async with database.session() as session:
        session.add(ProjectMember(project_id=database.project_id, account_id=admin.id))
        await session.commit()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as client:
        response = await client.post(
            "/console/login", json={"login": "admin", "password": PASSWORD}
        )
        assert response.status_code == 200, response.text
        client.headers["X-CSRF-Token"] = response.json()["csrf"]
        yield client, database, tickets, auth, admin, storage
    await database.dispose()


def image_bytes() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (20, 20), "blue").save(output, "PNG")
    return output.getvalue()


def upload(content: bytes, mime: str, name: str = "file") -> UploadFile:
    return UploadFile(io.BytesIO(content), filename=name, headers=Headers({"content-type": mime}))


def test_password_hashing() -> None:
    encoded = password_hash(PASSWORD)
    assert PASSWORD not in encoded and verify_password(PASSWORD, encoded)
    assert not verify_password("different-password", encoded)
    assert password_hash(PASSWORD) != encoded
    assert not verify_password(PASSWORD, "broken")


async def test_auth_boundaries(console: Any) -> None:
    client, database, _, auth, admin, _ = console
    assert (await client.get("/console/me")).status_code == 200
    # Static build delivery is covered separately; API tests need no Node build.
    assert (await client.get("/console/assets/app.js")).status_code == 404
    assert (await client.get("/console/assets/theme.js")).status_code == 404
    assert (await client.get("/console/assets/secret")).status_code == 404
    assert (await client.get("/api/v1/tickets")).status_code == 404
    for headers in ({"Origin": "https://foreign.example"}, {"X-CSRF-Token": "wrong"}):
        assert (
            await client.post("/console/tickets/sync", json={}, headers=headers)
        ).status_code == 403
    with pytest.raises(HTTPException) as error:
        await auth.create_account(
            login="another", name="Test", password=PASSWORD, role="admin", bootstrap=True
        )
    assert error.value.status_code == 409
    with pytest.raises(HTTPException) as error:
        await auth.set_active(admin.id, False)
    assert error.value.status_code == 409
    async with database.session() as session:
        rows = (await session.scalars(select(ConsoleSession))).all()
        assert rows and rows[0].token_hash == digest(client.cookies.get("resolvate_session"))
    assert (await client.post("/console/logout")).status_code == 200
    assert (await client.get("/console/me")).status_code == 401


async def test_account_permissions_and_revocation(console: Any) -> None:
    client, database, _, auth, _, _ = console
    created = await client.post(
        "/console/accounts",
        json={"login": "operator", "name": "Оператор", "password": PASSWORD, "role": "operator"},
    )
    assert created.status_code == 200
    login = await client.post("/console/login", json={"login": "operator", "password": PASSWORD})
    client.headers["X-CSRF-Token"] = login.json()["csrf"]
    assert (await client.get("/console/accounts")).status_code == 403
    assert (await client.post("/console/tickets/sync", json={})).status_code == 403
    async with database.session() as session:
        session.add(ProjectMember(project_id=database.project_id, account_id=created.json()["id"]))
        await session.commit()
    assert (await client.post("/console/tickets/sync", json={})).status_code == 200
    await auth.set_active(created.json()["id"], False)
    assert (await client.get("/console/me")).status_code == 401


async def test_change_password_revokes_all_sessions_and_preserves_role(console: Any) -> None:
    client, database, _, auth, admin, _ = console
    _, other_token = await auth.login("admin", PASSWORD, "other-device")
    new_password = "changed-test-password-only"
    payload = {"current_password": PASSWORD, "new_password": new_password}
    assert (
        await client.post("/console/password", json=payload, headers={"X-CSRF-Token": "bad"})
    ).status_code == 403
    assert (
        await client.post("/console/password", json={**payload, "current_password": "wrong"})
    ).status_code == 403
    assert (await client.post("/console/password", json=payload)).status_code == 200
    assert (await client.get("/console/me")).status_code == 401
    async with database.session() as session:
        assert await session.scalar(select(func.count()).select_from(ConsoleSession)) == 0
        assert await session.get(ConsoleSession, digest(other_token)) is None
    assert (
        await client.post("/console/login", json={"login": "admin", "password": PASSWORD})
    ).status_code == 401
    response = await client.post(
        "/console/login", json={"login": "admin", "password": new_password}
    )
    assert response.status_code == 200
    assert response.json()["account"]["id"] == admin.id
    assert response.json()["account"]["role"] == "admin"


async def test_owner_resets_employee_password_without_transferring_ownership(console: Any) -> None:
    from resolvate.models import AccessAudit, ConsoleAccount

    client, database, _, auth, admin, _ = console
    employee = await auth.create_account(
        login="employee", name="Employee", password=PASSWORD, role="operator"
    )
    await auth.login("employee", PASSWORD, "employee-device")
    path = f"/console/accounts/{employee.id}/password"
    payload = {"current_password": PASSWORD, "new_password": "employee-new-password-only"}
    assert (await client.post(path, json=payload)).status_code == 200
    assert (await client.get("/console/me")).status_code == 200
    async with database.session() as session:
        assert (
            await session.scalar(
                select(func.count())
                .select_from(ConsoleSession)
                .where(ConsoleSession.account_id == employee.id)
            )
            == 0
        )
        changed = await session.get(ConsoleAccount, employee.id)
        assert changed and changed.role == "operator" and changed.active
        owner = await session.get(ConsoleAccount, admin.id)
        assert owner and owner.role == "admin"
        audit = await session.scalar(
            select(AccessAudit).where(AccessAudit.action == "password_reset")
        )
        assert audit and audit.actor_id == admin.id and audit.target_id == employee.id
    login = await client.post(
        "/console/login", json={"login": "employee", "password": payload["new_password"]}
    )
    assert login.status_code == 200
    client.headers["X-CSRF-Token"] = login.json()["csrf"]
    assert (
        await client.post(f"/console/accounts/{admin.id}/password", json=payload)
    ).status_code == 403


async def test_password_change_rechecks_revoked_session(console: Any) -> None:
    client, database, _, auth, admin, _ = console
    token = client.cookies.get("resolvate_session")
    assert (await client.post("/console/logout")).status_code == 200
    with pytest.raises(HTTPException) as error:
        await auth.change_password(
            admin, token=token, current_password=PASSWORD, new_password="different-test-password"
        )
    assert error.value.status_code == 401


async def customer(tickets: TicketService) -> str:
    result = await tickets.accept_customer_message(
        telegram_user_id=10001,
        display_name="Клиент",
        username="customer",
        source_chat_id=10001,
        source_message_id=1,
        target_chat_id=-100123456,
        content="Нужна помощь",
        media=None,
    )
    assert result.ticket
    token = await tickets.claim_topic_provisioning(result.ticket.id)
    assert token
    await tickets.attach_topic(result.ticket.id, 100, token=token, archive_chat_id=-100123456)
    return result.ticket.id


async def test_send_sync_idempotency_lifecycle(console: Any) -> None:
    client, database, tickets, _, _, _ = console
    ticket_id = await customer(tickets)
    listed = (await client.post("/console/tickets/sync", json={})).json()
    assert listed["items"][0]["unread"] == 1
    key = str(uuid.uuid4())
    path = f"/console/tickets/{ticket_id}/send"
    for _ in range(2):
        result = await client.post(
            path, data={"text": "Поможем <script>"}, headers={"X-Idempotency-Key": key}
        )
        assert result.status_code == 200, result.text
    assert (
        await client.post(path, data={"text": "Другой ответ"}, headers={"X-Idempotency-Key": key})
    ).status_code == 409
    async with database.session() as session:
        assert await session.scalar(select(func.count()).select_from(ConsoleSend)) == 1
        jobs = (
            await session.scalars(
                select(DeliveryOutbox).where(
                    DeliveryOutbox.idempotency_key.like(f"console:{key}:%")
                )
            )
        ).all()
        assert len(jobs) == 2
        assert {job.payload["target_chat_id"] for job in jobs} == {10001, -100123456}
        client_job = next(job for job in jobs if job.payload["target_chat_id"] == 10001)
        mirror = next(job for job in jobs if job.payload["target_chat_id"] == -100123456)
        assert client_job.payload["text"] == "Поможем <script>"
        assert "parse_mode" not in client_job.payload
        assert mirror.payload["parse_mode"] == "HTML"
        assert mirror.payload["text"] == (
            "<b>👤 ПОДДЕРЖКА · Администратор</b>\n\nПоможем &lt;script&gt;"
        )
    page = (await client.post(f"/console/tickets/{ticket_id}/sync", json={})).json()
    assert len(page["items"]) == 2 and page["items"][-1]["author"] == "Администратор"
    unchanged = (
        await client.post(
            f"/console/tickets/{ticket_id}/sync",
            json={"known": {item["id"]: item["revision"] for item in page["items"]}},
        )
    ).json()
    assert unchanged["items"] == []
    await client.post(f"/console/tickets/{ticket_id}/read/{page['items'][-1]['id']}")
    assert (await client.post("/console/tickets/sync", json={})).json()["items"][0]["unread"] == 0
    assert (await client.post(f"/console/tickets/{ticket_id}/close")).status_code == 200
    assert not (await client.post("/console/tickets/sync", json={})).json()["order"]
    assert (await client.post("/console/tickets/sync", json={"archived": True})).json()["order"]
    assert (await client.post(f"/console/tickets/{ticket_id}/reopen")).status_code == 200


async def test_web_close_notifies_telegram_customer_once_with_matching_rating_cycle(
    console: Any,
) -> None:
    from resolvate.telegram_constants import TICKET_CLOSED_TEXT
    from resolvate.telegram_message_utils import rating_keyboard

    client, database, tickets, _, _, _ = console
    ticket_id = await customer(tickets)
    results = await asyncio.gather(
        *(client.post(f"/console/tickets/{ticket_id}/close") for _ in range(2))
    )
    assert all(result.status_code == 200 for result in results)
    assert sorted(result.json()["changed"] for result in results) == [False, True]
    ticket = await tickets.get_ticket(ticket_id)
    assert ticket.close_cycle == 1
    async with database.session() as session:
        notifications = (
            await session.scalars(
                select(DeliveryOutbox).where(DeliveryOutbox.direction == Direction.OPERATOR_TO_USER)
            )
        ).all()
        messages = (
            await session.scalars(select(TicketMessage).where(TicketMessage.channel == "system"))
        ).all()
        assert len(notifications) == len(messages) == 1
        payload = notifications[0].payload
        assert payload["text"] == TICKET_CLOSED_TEXT
        assert payload["target_chat_id"] == 10001
        assert payload["parse_mode"] == "HTML"
        assert payload["reply_markup"] == rating_keyboard(ticket_id, 1).model_dump(
            mode="json", exclude_none=True
        )
        assert payload["canonical_message_id"] == messages[0].id
        assert "<b>" not in messages[0].content
    page = (await client.post(f"/console/tickets/{ticket_id}/sync", json={})).json()
    event = next(item for item in page["items"] if item["channel"] == "system")
    assert event["system"] and event["author"] == "Система"
    assert event["text"] == "✅ Обращение закрыто"
    assert "ниже" not in event["text"]


async def test_legacy_system_markup_and_user_text_are_not_confused(console: Any) -> None:
    from resolvate.telegram_constants import TICKET_CLOSED_TEXT

    client, database, tickets, _, _, _ = console
    ticket_id = await customer(tickets)
    async with database.session() as session:
        session.add_all(
            [
                TicketMessage(
                    ticket_id=ticket_id,
                    direction=Direction.OPERATOR_TO_USER,
                    channel="system",
                    content=TICKET_CLOSED_TEXT,
                ),
                TicketMessage(
                    ticket_id=ticket_id,
                    direction=Direction.OPERATOR_TO_USER,
                    channel="telegram",
                    content="<b>Текст оператора</b>",
                ),
                TicketMessage(
                    ticket_id=ticket_id,
                    direction=Direction.USER_TO_OPERATOR,
                    channel="telegram",
                    content=TICKET_CLOSED_TEXT,
                ),
            ]
        )
        await session.commit()
    items = (await client.post(f"/console/tickets/{ticket_id}/sync", json={})).json()["items"]
    event = next(item for item in items if item["channel"] == "system")
    assert event["author"] == "Система" and event["text"] == "✅ Обращение закрыто"
    operator = next(item for item in items if item["text"] == "<b>Текст оператора</b>")
    assert not operator["system"] and operator["author"] == "Оператор (Telegram)"
    assert any(item["text"] == TICKET_CLOSED_TEXT and not item["system"] for item in items)


async def test_web_close_respects_customer_block(console: Any) -> None:
    client, database, tickets, _, _, _ = console
    ticket_id = await customer(tickets)
    await tickets.block_ticket(ticket_id=ticket_id, operator_telegram_id=1)
    assert (await client.post(f"/console/tickets/{ticket_id}/close")).status_code == 200
    async with database.session() as session:
        assert not (
            await session.scalars(
                select(DeliveryOutbox).where(DeliveryOutbox.direction == Direction.OPERATOR_TO_USER)
            )
        ).all()
        assert not (
            await session.scalars(select(TicketMessage).where(TicketMessage.channel == "system"))
        ).all()


async def test_web_close_for_api_customer_stores_plain_client_notification(console: Any) -> None:
    from resolvate.api_idempotency import api_idempotency_command

    client, database, tickets, _, _, _ = console
    result = await tickets.accept_message(
        identity_mode="external_id",
        external_user_id="web-customer",
        email="customer@example.com",
        display_name="Web customer",
        remnawave_user_uuid=None,
        content="Help",
        media=None,
        target_chat_id=-100123456,
        command=api_idempotency_command(
            operation="web-message", resource="web-customer", key="create", payload={"text": "Help"}
        ),
    )
    assert (await client.post(f"/console/tickets/{result.ticket.id}/close")).status_code == 200
    page = await tickets.list_messages(result.ticket.id, after=None, limit=50)
    notification = next(message for message in page.items if message.channel == "system")
    assert "Обращение закрыто" in notification.content
    assert "Спасибо за обращение" in notification.content
    assert "<b>" not in notification.content and "ниже" not in notification.content
    async with database.session() as session:
        assert not (
            await session.scalars(
                select(DeliveryOutbox).where(DeliveryOutbox.direction == Direction.OPERATOR_TO_USER)
            )
        ).all()


async def test_rating_card_has_canonical_score_and_client_snapshot(console: Any) -> None:
    from resolvate.models import User
    from resolvate.telegram_message_utils import rating_report

    client, database, tickets, _, _, _ = console
    ticket_id = await customer(tickets)
    await client.post(f"/console/tickets/{ticket_id}/close")
    ticket = await tickets.get_ticket(ticket_id)
    for score, expected in ((3, True), (5, False)):
        assert (
            await tickets.enqueue_rating(
                ticket_id=ticket_id,
                source_chat_id=10001,
                score=score,
                close_cycle=1,
                target_chat_id=-100123456,
                text=rating_report(ticket, score, support_group_id=-100123456),
                idempotency_key=f"rating:{score}",
                parse_mode="HTML",
            )
            is expected
        )
    async with database.session() as session:
        user = await session.scalar(select(User))
        user.display_name = "Новое имя"
        await session.commit()
        reports = (await session.scalars(select(DeliveryOutbox))).all()
    items = (await client.post(f"/console/tickets/{ticket_id}/sync", json={})).json()["items"]
    card = next(item for item in items if item["channel"] == "rating")
    assert card["system"] and card["author"] == "Система"
    assert card["rating"]["score"] == 3 and card["rating"]["ticket_id"] == ticket_id
    assert "Оценка: ⭐⭐⭐ 3/5" in card["text"]
    assert "Клиент · @customer" in card["text"]
    assert "Telegram ID: 10001" in card["text"]
    assert "Новое имя" not in card["text"] and "<b>" not in card["text"]
    report = next(
        job.payload for job in reports if job.payload.get("target_system_topic") == "ratings"
    )
    assert "⭐⭐⭐ <b>3/5</b>" in report["text"] and "t.me/c/123456/100" in report["text"]


async def test_legacy_rating_card_falls_back_to_current_client(console: Any) -> None:
    client, database, tickets, _, _, _ = console
    ticket_id = await customer(tickets)
    async with database.session() as session:
        session.add(
            TicketMessage(
                ticket_id=ticket_id,
                direction=Direction.USER_TO_OPERATOR,
                channel="rating",
                content="4/5",
                media={"rating": 4},
            )
        )
        await session.commit()
    items = (await client.post(f"/console/tickets/{ticket_id}/sync", json={})).json()["items"]
    card = next(item for item in items if item["channel"] == "rating")
    assert card["rating"]["score"] == 4 and "⭐⭐⭐⭐ 4/5" in card["text"]
    assert "@customer" in card["text"] and card["author"] == "Система"


async def test_spam_notice_is_one_system_event_and_operator_only_delivery(console: Any) -> None:
    client, database, tickets, _, _, _ = console
    ticket_id = await customer(tickets)
    for _ in range(2):
        await tickets.record_rate_limit_notice(
            provider="telegram",
            identity="10001",
            key="rate-limit:telegram:2",
            target_chat_id=-100123456,
        )
    async with database.session() as session:
        jobs = list(
            (
                await session.scalars(
                    select(DeliveryOutbox).where(
                        DeliveryOutbox.idempotency_key == "rate-limit:telegram:2"
                    )
                )
            ).all()
        )
        assert len(jobs) == 1 and jobs[0].payload["target_chat_id"] == -100123456
        assert jobs[0].payload["target_thread_id"] == 100
        message = await session.get(TicketMessage, jobs[0].payload["canonical_message_id"])
        assert message and message.channel == "internal_note"
        customer_job = await session.scalar(
            select(DeliveryOutbox).where(
                DeliveryOutbox.idempotency_key == "copy:user_to_operator:10001:1"
            )
        )
        assert customer_job and customer_job.payload["canonical_message_id"]
    page = (await client.post(f"/console/tickets/{ticket_id}/sync", json={})).json()
    assert len(page["items"]) == 2
    assert page["items"][-1]["author"] == "Система"
    assert "защита от спама" in page["items"][-1]["text"]


async def test_media_dedup_and_validation(tmp_path: Path) -> None:
    storage = LocalMediaStorage(tmp_path)
    one = await storage.save_upload(upload(image_bytes(), "image/png", "one.png"))
    two = await storage.save_upload(upload(image_bytes(), "image/png", "two.png"))
    assert one.id != two.id and one.storage_path == two.storage_path
    await storage.delete(two)
    assert await storage.resolve_file(one.storage_path)
    for data, mime in [
        (b"PK\x03\x04bad zip", "image/jpeg"),
        (image_bytes() + b"RAR", "image/png"),
        (b"%PDF-1.4\ninvalid\n%%EOF", "application/pdf"),
    ]:
        with pytest.raises(MediaValidationError):
            await storage.save_upload(upload(data, mime))
    pdf = PdfWriter()
    pdf.add_blank_page(width=100, height=100)
    output = io.BytesIO()
    pdf.write(output)
    saved = await storage.save_upload(upload(output.getvalue(), "application/pdf", "test.pdf"))
    assert saved.mime_type == "application/pdf" and saved.delivery_kind == "send_document"


async def test_photo_send_and_safe_retry(console: Any) -> None:
    client, database, tickets, _, _, _ = console
    ticket_id = await customer(tickets)
    key = str(uuid.uuid4())
    result = await client.post(
        f"/console/tickets/{ticket_id}/send",
        data={"text": "Фото"},
        files={"file": ("photo.png", image_bytes(), "image/png")},
        headers={"X-Idempotency-Key": key},
    )
    assert result.status_code == 200, result.text
    async with database.session() as session:
        command = await session.get(ConsoleSend, key)
        assert command
        ident = next(iter(command.deliveries))
        job = await session.get(DeliveryOutbox, ident)
        assert job
        job.status = DeliveryStatus.FAILED
        job.last_error = "definite refusal"
        job.payload = {}
        await session.commit()
        assert await session.scalar(select(func.count()).select_from(MediaAsset)) == 1
    assert (await client.post(f"/console/retry/{key}/{ident}")).status_code == 200
    async with database.session() as session:
        job = await session.get(DeliveryOutbox, ident)
        assert job and job.status == DeliveryStatus.PENDING and job.payload["storage_path"]
        job.status = DeliveryStatus.PROCESSING
        job.claimed_at = utcnow() - timedelta(hours=1)
        await session.commit()
    await tickets.outbox.release_stale_deliveries()
    assert (await client.post(f"/console/retry/{key}/{ident}")).status_code == 409


async def test_poll_catches_burst_without_a_history_gap(console: Any) -> None:
    client, database, tickets, _, _, _ = console
    ticket_id = await customer(tickets)
    path = f"/console/tickets/{ticket_id}/sync"
    first = (await client.post(path, json={})).json()
    async with database.session() as session:
        for index in range(110):
            session.add(
                TicketMessage(
                    ticket_id=ticket_id,
                    direction=Direction.USER_TO_OPERATOR,
                    channel="telegram",
                    content=str(index),
                )
            )
        await session.commit()
    updated = (
        await client.post(
            path, json={"known": {item["id"]: item["revision"] for item in first["items"]}}
        )
    ).json()
    assert len(updated["order"]) == 111 and len(updated["items"]) == 110
    assert not updated["reset"]
    initial = (await client.post(path, json={})).json()
    assert len(initial["items"]) == 50 and initial["has_older"]
    previous = (await client.post(path, json={"before": initial["before"]})).json()
    assert len(previous["items"]) == 50
    assert not set(initial["order"]) & set(previous["order"])


async def test_telegram_edit_is_visible_without_new_message(console: Any) -> None:
    client, database, tickets, _, _, storage = console
    ticket_id = await customer(tickets)
    edit = Message.model_validate(
        {
            "message_id": 1,
            "date": 100,
            "edit_date": 200,
            "chat": {"id": 10001, "type": "private"},
            "from": {"id": 10001, "is_bot": False, "first_name": "Клиент"},
            "text": "Уточнение вопроса",
        }
    )
    bot = AsyncMock()
    await record_edit(edit, bot, storage, database)
    stale = edit.model_copy(update={"edit_date": 150, "text": "Устаревший текст"})
    await record_edit(stale, bot, storage, database)
    page = (await client.post(f"/console/tickets/{ticket_id}/sync", json={})).json()
    assert len(page["items"]) == 1 and page["items"][0]["text"] == "Уточнение вопроса"
    bot.download.assert_not_called()


@pytest.mark.parametrize(
    "name,mime,size",
    [
        ("archive.zip", "application/zip", 100),
        ("archive.rar", "image/jpeg", 100),
        ("text.txt", "text/plain", 100),
        ("video.mp4", "video/mp4", 20 * 1024 * 1024 + 1),
    ],
)
async def test_known_forbidden_telegram_attachments_are_not_downloaded(
    tmp_path: Path, name: str, mime: str, size: int
) -> None:
    message = Message.model_validate(
        {
            "message_id": 1,
            "date": 100,
            "chat": {"id": 10001, "type": "private"},
            "document": {
                "file_id": "file",
                "file_unique_id": "unique",
                "file_name": name,
                "mime_type": mime,
                "file_size": size,
            },
        }
    )
    bot = AsyncMock()
    with pytest.raises(MediaValidationError):
        await save_attachment(message, bot, LocalMediaStorage(tmp_path))
    bot.download.assert_not_called()


async def test_unread_is_per_operator_and_sessions_expire(console: Any) -> None:
    client, database, tickets, auth, _, _ = console
    ticket_id = await customer(tickets)
    page = (await client.post(f"/console/tickets/{ticket_id}/sync", json={})).json()
    await client.post(f"/console/tickets/{ticket_id}/read/{page['items'][-1]['id']}")
    second = await auth.create_account(
        login="second", name="Second", password=PASSWORD, role="operator"
    )
    async with database.session() as session:
        session.add(ProjectMember(project_id=database.project_id, account_id=second.id))
        await session.commit()
    result = await client.post("/console/login", json={"login": "second", "password": PASSWORD})
    client.headers["X-CSRF-Token"] = result.json()["csrf"]
    assert (await client.post("/console/tickets/sync", json={})).json()["items"][0]["unread"] == 1
    async with database.session() as session:
        stored = await session.get(ConsoleSession, digest(client.cookies.get("resolvate_session")))
        stored.expires_at = utcnow() - timedelta(seconds=1)
        await session.commit()
    assert (await client.get("/console/me")).status_code == 401
