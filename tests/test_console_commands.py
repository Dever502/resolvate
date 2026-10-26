import asyncio
import uuid
from unittest.mock import AsyncMock

import httpx
import pytest
import test_console
from fastapi import FastAPI, HTTPException
from sqlalchemy import select

from resolvate.action_permissions import TELEGRAM_ACTIONS
from resolvate.console_commands import COMMANDS, plain, register_commands, validate_arguments
from resolvate.models import OperatorAction, ReconciliationOutbox, WorkStatus
from resolvate.panel import PanelActionResult, PanelService

console = test_console.console
customer = test_console.customer


def test_commands_match_telegram_and_validate_arguments():
    assert {"/" + name for name in COMMANDS} == set(TELEGRAM_ACTIONS)
    for value in ("0", "-1", "10000", "1.5", "30 x", ""):
        with pytest.raises(HTTPException):
            validate_arguments("gift", value)
    assert validate_arguments("gift", " 30 ") == "30"
    assert plain("<b>Title</b> &lt;script&gt;") == "Title <script>"
    for value in ("", "bad applied", f"{uuid.uuid4()} bad"):
        with pytest.raises(HTTPException):
            validate_arguments("resolvepanel", value)
    assert validate_arguments("resolvepanel", f"{uuid.uuid4()} applied")
    with pytest.raises(HTTPException):
        validate_arguments("unknown", "")


async def test_command_note_is_internal_and_replay_is_bound_to_payload(console):
    client, database, tickets, _, actor, _ = console
    ticket = await customer(tickets)
    available = await client.get("/console/commands")
    assert available.status_code == 200, available.text
    assert "note" in {item["name"] for item in available.json()}
    assert "gift" not in {item["name"] for item in available.json()}
    headers = {"X-Idempotency-Key": str(uuid.uuid4())}
    path = f"/console/tickets/{ticket}/commands/note"
    first, second = await asyncio.gather(
        *[client.post(path, json={"arguments": "private note"}, headers=headers) for _ in range(2)]
    )
    assert first.status_code == second.status_code == 200
    replay = await client.post(path, json={"arguments": "private note"}, headers=headers)
    assert replay.json()["status"] == "completed"
    assert len(await tickets.list_internal_notes(ticket)) == 1
    added = await client.post(
        path,
        json={"arguments": "second note"},
        headers={
            "X-Idempotency-Key": str(uuid.uuid4()),
        },
    )
    assert added.status_code == 200, added.text
    assert len(await tickets.list_internal_notes(ticket)) == 2
    assert (
        await client.post(path, json={"arguments": "changed"}, headers=headers)
    ).status_code == 409
    async with database.session() as session:
        receipt = await session.scalar(
            select(OperatorAction).where(OperatorAction.action == "console_command")
        )
        assert receipt.payload["request"]["account_id"] == actor.id
    # A stale frontend cannot send commands to a customer through the message API.
    sent = await client.post(
        f"/console/tickets/{ticket}/send", data={"text": "/gift 30"}, headers=headers
    )
    assert sent.status_code == 422


async def test_command_guards_and_unknown_do_not_repeat(console, monkeypatch):
    client, _, tickets, _, _, _ = console
    ticket = await customer(tickets)
    path = f"/console/tickets/{ticket}/commands/block"
    headers = {"X-Idempotency-Key": str(uuid.uuid4())}
    assert (
        await client.post(path, json={}, headers={**headers, "X-CSRF-Token": "bad"})
    ).status_code == 403
    assert (
        await client.post(path, json={"arguments": "extra"}, headers=headers)
    ).status_code == 422
    broken = AsyncMock(side_effect=RuntimeError("lost result"))
    monkeypatch.setattr(tickets, "block_ticket", broken)
    with pytest.raises(RuntimeError, match="lost result"):
        await client.post(path, json={}, headers=headers)
    replay = await client.post(path, json={}, headers=headers)
    assert replay.status_code == 200
    assert replay.json()["status"] == "unknown"
    assert broken.await_count == 1


@pytest.mark.parametrize(
    "command,method,argument",
    [
        ("gift", "extend_subscription_for_ticket", "30"),
        ("resetkey", "reset_key_for_ticket", ""),
        ("revokelink", "revoke_subscription_link_for_ticket", ""),
        ("resetdevices", "reset_devices_for_ticket", ""),
    ],
)
async def test_panel_commands_use_existing_services_once(console, command, method, argument):
    client, _, tickets, auth, _, _ = console
    ticket = await customer(tickets)
    panel = AsyncMock(spec=PanelService)
    getattr(panel, method).return_value = PanelActionResult(
        action=command,
        status="completed",
        changed=True,
        identity_provider="telegram",
        identity_value="123",
    )
    root, app = FastAPI(), FastAPI()
    register_commands(app, auth, tickets, panel)
    root.mount("/console", app)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=root),
        base_url=test_console.ORIGIN,
        cookies=client.cookies,
        headers=client.headers,
    ) as browser:
        catalog = (await browser.get("/console/commands")).json()
        assert any(item["name"] == command and item["mutation"] for item in catalog)
        headers = {"X-Idempotency-Key": str(uuid.uuid4())}
        for _ in range(2):
            response = await browser.post(
                f"/console/tickets/{ticket}/commands/{command}",
                json={"arguments": argument},
                headers=headers,
            )
            assert response.status_code == 200, response.text
        operation = getattr(panel, method)
        operation.assert_awaited_once()
        assert operation.await_args.kwargs["ticket"].id == ticket
        if command == "gift":
            assert operation.await_args.kwargs["extend_days"] == 30


async def test_command_rechecks_membership_and_session(console):
    from sqlalchemy import delete

    from resolvate.models import ProjectMember

    client, database, tickets, _, actor, _ = console
    ticket = await customer(tickets)
    assert (await client.get("/console/commands")).status_code == 200
    async with database.session() as session:
        await session.execute(delete(ProjectMember).where(ProjectMember.account_id == actor.id))
        await session.commit()
    denied = await client.post(
        f"/console/tickets/{ticket}/commands/note",
        json={"arguments": "forbidden"},
        headers={"X-Idempotency-Key": str(uuid.uuid4())},
    )
    assert denied.status_code == 403
    assert await tickets.list_internal_notes(ticket) == []


@pytest.mark.parametrize(
    "command,method,value",
    [
        ("stop", "close_with_notification", None),
        ("hidestop", "close", None),
        ("block", "block_ticket", None),
        ("unblock", "unblock_ticket", None),
        ("closeall", "close_all", []),
    ],
)
async def test_ticket_commands_dispatch_once(console, monkeypatch, command, method, value):
    client, _, tickets, _, _, _ = console
    ticket = await customer(tickets)
    operation = AsyncMock(return_value=value)
    monkeypatch.setattr(tickets, method, operation)
    headers = {"X-Idempotency-Key": str(uuid.uuid4())}
    for _ in range(2):
        response = await client.post(
            f"/console/tickets/{ticket}/commands/{command}", json={}, headers=headers
        )
        assert response.status_code == 200, response.text
    operation.assert_awaited_once()


async def test_synctopics_is_neither_listed_nor_executable(console, monkeypatch):
    client, _, tickets, _, _, _ = console
    ticket = await customer(tickets)
    operation = AsyncMock(return_value=1)
    monkeypatch.setattr(tickets, "queue_all_topic_reconciliations", operation)
    available = await client.get("/console/commands")
    assert available.status_code == 200, available.text
    assert "synctopics" not in {item["name"] for item in available.json()}
    # A hand-made request is refused by the action policy, before any receipt or work.
    denied = await client.post(
        f"/console/tickets/{ticket}/commands/synctopics",
        json={},
        headers={"X-Idempotency-Key": str(uuid.uuid4())},
    )
    assert denied.status_code == 403, denied.text
    operation.assert_not_awaited()


async def test_internal_topic_synchronisation_still_requeues_topics(console):
    _, database, tickets, _, _, _ = console
    ticket = await customer(tickets)
    assert await tickets.queue_all_topic_reconciliations() >= 1
    async with database.session() as session:
        job = await session.scalar(
            select(ReconciliationOutbox).where(
                ReconciliationOutbox.ticket_id == ticket,
                ReconciliationOutbox.kind == "telegram_topic",
            )
        )
    assert job is not None
    assert job.status == WorkStatus.PENDING
    assert job.payload == {"reason": "bulk_sync"}


async def test_panel_reconciliation_requires_admin_and_read_commands_need_no_receipt(console):
    from resolvate.models import ProjectMember

    client, database, tickets, auth, _, _ = console
    ticket = await customer(tickets)
    panel = AsyncMock(spec=PanelService)
    panel.resolve_inconclusive_action.return_value = True
    root, app = FastAPI(), FastAPI()
    register_commands(app, auth, tickets, panel)
    root.mount("/console", app)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=root),
        base_url=test_console.ORIGIN,
        cookies=client.cookies,
        headers=client.headers,
    ) as browser:
        response = await browser.post(
            f"/console/tickets/{ticket}/commands/resolvepanel",
            json={"arguments": f"{uuid.uuid4()} applied"},
            headers={"X-Idempotency-Key": str(uuid.uuid4())},
        )
        assert response.status_code == 200, response.text
        panel.resolve_inconclusive_action.assert_awaited_once()
    operator = await auth.create_account(
        login="operator", name="Operator", password=test_console.PASSWORD, role="operator"
    )
    async with database.session() as session:
        session.add(ProjectMember(project_id=database.project_id, account_id=operator.id))
        await session.commit()
    logged = await client.post(
        "/console/login", json={"login": "operator", "password": test_console.PASSWORD}
    )
    client.headers["X-CSRF-Token"] = logged.json()["csrf"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=root),
        base_url=test_console.ORIGIN,
        cookies=client.cookies,
        headers=client.headers,
    ) as browser:
        catalog = (await browser.get("/console/commands")).json()
        assert "resolvepanel" not in {item["name"] for item in catalog}
        denied = await browser.post(
            f"/console/tickets/{ticket}/commands/resolvepanel",
            json={"arguments": f"{uuid.uuid4()} applied"},
            headers={"X-Idempotency-Key": str(uuid.uuid4())},
        )
        assert denied.status_code == 403
        panel.resolve_inconclusive_action.assert_awaited_once()
        for command in ("info", "notes"):
            response = await browser.post(
                f"/console/tickets/{ticket}/commands/{command}",
                json={},
                headers={"X-Idempotency-Key": str(uuid.uuid4())},
            )
            assert response.status_code == 200, response.text
