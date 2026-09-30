from __future__ import annotations

import asyncio
from typing import Any

import pytest
import test_console
from fastapi import HTTPException
from sqlalchemy import func, select
from test_console import PASSWORD, customer

from resolvate.console_folders import folder_name
from resolvate.models import AccessAudit, ProjectMember, Ticket, TicketMessage, TicketStatus

console = test_console.console


@pytest.mark.parametrize("name", ["", "  ", "x" * 81, "hidden\u200bname", "bad\x00name"])
def test_folder_name_rejects_invalid_input(name: str) -> None:
    with pytest.raises(HTTPException) as error:
        folder_name(name)
    assert error.value.status_code == 422


def test_folder_names_have_canonical_keys() -> None:
    assert folder_name("  Оплата   подписки ") == ("Оплата подписки", "оплата подписки")
    assert folder_name("Ｆｏｌｄｅｒ") == ("Folder", "folder")


async def new_folder(client: Any, name: str = "Оплата") -> dict[str, Any]:
    result = await client.post("/console/folders", json={"name": name})
    assert result.status_code == 200, result.text
    return result.json()


async def test_folders_are_shared_and_manageable_by_operators(console: Any) -> None:
    client, database, tickets, auth, _, _ = console
    ticket = await customer(tickets)
    folder = await new_folder(client)
    operator = await auth.create_account(
        login="worker", name="Worker", password=PASSWORD, role="operator"
    )
    async with database.session() as session:
        session.add(ProjectMember(project_id=database.project_id, account_id=operator.id))
        await session.commit()
    response = await client.post("/console/login", json={"login": "worker", "password": PASSWORD})
    client.headers["X-CSRF-Token"] = response.json()["csrf"]
    assert (await client.get("/console/folders")).json() == [folder]
    await new_folder(client, "Проверить")
    moved = await client.post(
        f"/console/tickets/{ticket}/folder", json={"folder_id": folder["id"], "revision": 0}
    )
    assert moved.status_code == 200, moved.text
    assert moved.json() == {"folder_id": folder["id"], "folder_revision": 1}
    for query, expected in [
        ({}, [ticket]),
        ({"folder_id": folder["id"]}, [ticket]),
        ({"unfiled": True}, []),
    ]:
        result = (await client.post("/console/tickets/sync", json=query)).json()
        assert result["order"] == expected
    result = await client.post(
        f"/console/folders/{folder['id']}/rename", json={"name": "Платежи", "revision": 0}
    )
    assert result.status_code == 200
    async with database.session() as session:
        row = await session.get(Ticket, ticket)
        activity = row.last_activity_at
        count = await session.scalar(select(func.count()).select_from(TicketMessage))
        row.status = TicketStatus.CLOSED
        await session.commit()
    archived = await client.post(
        "/console/tickets/sync", json={"folder_id": folder["id"], "archived": True}
    )
    assert archived.json()["order"] == [ticket]
    result = await client.post(f"/console/folders/{folder['id']}/delete", json={"revision": 1})
    assert result.status_code == 200, result.text
    detail = (await client.get(f"/console/tickets/{ticket}")).json()
    assert detail["folder_id"] is None and detail["folder_revision"] == 2
    async with database.session() as session:
        row = await session.get(Ticket, ticket)
        assert row.status == TicketStatus.CLOSED and row.last_activity_at == activity
        assert await session.scalar(select(func.count()).select_from(TicketMessage)) == count
        assert await session.scalar(
            select(AccessAudit.id).where(AccessAudit.action == "folder_deleted")
        )


async def test_folder_concurrent_creates_and_renames(console: Any) -> None:
    client = console[0]
    results = await asyncio.gather(
        *[client.post("/console/folders", json={"name": name}) for name in ["Оплата", " оплата "]]
    )
    assert sorted(r.status_code for r in results) == [200, 409]
    folder = next(r.json() for r in results if r.status_code == 200)
    results = await asyncio.gather(
        *[
            client.post(
                f"/console/folders/{folder['id']}/rename", json={"name": name, "revision": 0}
            )
            for name in ["Первое имя", "Второе имя"]
        ]
    )
    assert sorted(r.status_code for r in results) == [200, 409]
    # An outdated delete must not silently remove a folder renamed by someone else.
    assert (
        await client.post(f"/console/folders/{folder['id']}/delete", json={"revision": 0})
    ).status_code == 409
    other = await new_folder(client, "Другое")
    assert (
        await client.post(
            f"/console/folders/{folder['id']}/rename", json={"name": other["name"], "revision": 1}
        )
    ).status_code == 409


async def test_concurrent_moves_never_silently_overwrite(console: Any) -> None:
    client, _, tickets, _, _, _ = console
    ticket = await customer(tickets)
    first, second = await new_folder(client), await new_folder(client, "Другое")
    path = f"/console/tickets/{ticket}/folder"
    results = await asyncio.gather(
        *[
            client.post(path, json={"folder_id": folder["id"], "revision": 0})
            for folder in [first, second]
        ]
    )
    assert sorted(r.status_code for r in results) == [200, 409]
    detail = (await client.get(f"/console/tickets/{ticket}")).json()
    assert detail["folder_revision"] == 1
    assert detail["folder_id"] == next(
        r.json()["folder_id"] for r in results if r.status_code == 200
    )
    # Moving out and back is still a new revision (ABA protection).
    assert (await client.post(path, json={"folder_id": None, "revision": 1})).status_code == 200
    assert (
        await client.post(path, json={"folder_id": first["id"], "revision": 2})
    ).status_code == 200
    assert (
        await client.post(path, json={"folder_id": second["id"], "revision": 1})
    ).status_code == 409


async def test_delete_racing_with_move_keeps_conversation(console: Any) -> None:
    client, database, tickets, _, _, _ = console
    ticket = await customer(tickets)
    folder = await new_folder(client)
    move, remove = await asyncio.gather(
        client.post(
            f"/console/tickets/{ticket}/folder", json={"folder_id": folder["id"], "revision": 0}
        ),
        client.post(f"/console/folders/{folder['id']}/delete", json={"revision": 0}),
    )
    assert remove.status_code == 200
    assert move.status_code in {200, 404}
    detail = (await client.get(f"/console/tickets/{ticket}")).json()
    assert detail["folder_id"] is None
    assert (await client.get("/console/folders")).json() == []
    async with database.session() as session:
        assert await session.scalar(select(func.count()).select_from(TicketMessage)) == 1


async def test_folder_endpoints_require_membership_csrf_and_valid_payload(console: Any) -> None:
    client, database, tickets, _, actor, _ = console
    ticket = await customer(tickets)
    folder = await new_folder(client)
    assert (
        await client.post(
            "/console/folders", json={"name": "No CSRF"}, headers={"X-CSRF-Token": "wrong"}
        )
    ).status_code == 403
    assert (await client.post("/console/folders", json={"name": "  "})).status_code == 422
    assert (
        await client.post(
            f"/console/tickets/{ticket}/folder", json={"folder_id": "invalid", "revision": 0}
        )
    ).status_code == 422
    assert (
        await client.post(f"/console/tickets/{ticket}/folder", json={"folder_id": folder["id"]})
    ).status_code == 422
    assert (
        await client.post(
            "/console/tickets/sync", json={"folder_id": folder["id"], "unfiled": True}
        )
    ).status_code == 422
    async with database.session() as session:
        member = await session.get(ProjectMember, (database.project_id, actor.id))
        await session.delete(member)
        await session.commit()
    assert (await client.get("/console/folders")).status_code == 403
    assert (
        await client.post(f"/console/folders/{folder['id']}/delete", json={"revision": 0})
    ).status_code == 403
