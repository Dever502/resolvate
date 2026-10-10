from __future__ import annotations

import asyncio
import uuid

import httpx
import pytest
from alembic import command
from fastapi import HTTPException
from project_support import ProjectDatabase, seed_project
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from test_console import console as console_fixture
from test_projects import installation as installation_fixture

from resolvate.migrations import build_alembic_config, upgrade_database
from resolvate.models import QuickResponse, QuickResponseGroup
from resolvate.quick_replies import QuickReplyService
from resolvate.quick_reply_catalog import QuickReplyCatalog, group_name

console = console_fixture
installation = installation_fixture


@pytest.mark.parametrize(
    "value,expected", [("/ОПЛАТА", "оплата"), ("VPN", "vpn"), ("refund_1", "refund_1")]
)
def test_group_names(value, expected):
    assert group_name(value) == expected


@pytest.mark.parametrize("value", ["", "/", "a b", "a/b", "__", "a\nB", "a" * 49, "x\u200b", "😀"])
def test_invalid_group_names(value):
    with pytest.raises(HTTPException):
        group_name(value)


async def test_catalog_api_crud_and_conflicts(console):
    client, _, _, _, _, _ = console
    result = await client.post("/console/reply-groups", json={"name": "/Оплата"})
    assert result.status_code == 200, result.text
    group = result.json()
    assert group["name"] == "оплата"
    assert (await client.post("/console/reply-groups", json={"name": "ОПЛАТА"})).status_code == 409
    created = await client.post(
        "/console/replies", json={"group_id": group["id"], "text": "Чистый ответ"}
    )
    assert created.status_code == 200, created.text
    reply = created.json()
    assert reply["text"] == "Чистый ответ"
    assert (await client.get("/console/replies", params={"group_id": group["id"]})).json() == [
        reply
    ]
    assert (await client.get("/console/reply-groups", params={"q": "/ОПЛ"})).json() == [group]
    assert (
        await client.post(f"/console/reply-groups/{group['id']}/delete", json={"revision": 0})
    ).status_code == 409
    path = f"/console/replies/{reply['id']}/edit"
    responses = await asyncio.gather(
        *[
            client.post(path, json={"group_id": group["id"], "text": value, "revision": 0})
            for value in ["Первый", "Второй"]
        ]
    )
    assert sorted(r.status_code for r in responses) == [200, 409]
    assert (
        await client.post(f"/console/replies/{reply['id']}/delete", json={"revision": 0})
    ).status_code == 409
    assert (
        await client.post(f"/console/replies/{reply['id']}/delete", json={"revision": 1})
    ).status_code == 200
    assert (await client.get("/console/replies")).json() == []
    assert (
        await client.post(f"/console/reply-groups/{group['id']}/delete", json={"revision": 0})
    ).status_code == 200
    assert (await client.get("/console/reply-groups")).json() == []


async def test_move_reply_group_rename_and_bounded_search(console):
    client, _, _, _, _, _ = console
    a = (await client.post("/console/reply-groups", json={"name": "a"})).json()
    b = (await client.post("/console/reply-groups", json={"name": "b"})).json()
    reply = (
        await client.post("/console/replies", json={"group_id": a["id"], "text": "100% <literal>"})
    ).json()
    assert (
        await client.post(
            f"/console/replies/{reply['id']}/edit",
            json={"group_id": b["id"], "text": reply["text"], "revision": 0},
        )
    ).status_code == 200
    assert (await client.get("/console/replies", params={"group_id": a["id"]})).json() == []
    assert (
        len((await client.get("/console/replies", params={"group_id": b["id"], "q": "%"})).json())
        == 1
    )
    assert (await client.get("/console/replies", params={"offset": 1})).json() == []
    assert (await client.get("/console/replies", params={"q": "x" * 101})).status_code == 422
    assert (
        await client.post(
            f"/console/reply-groups/{b['id']}/rename", json={"name": "Оплата", "revision": 0}
        )
    ).status_code == 200
    assert (
        await client.post(f"/console/replies/{reply['id']}/delete", json={"revision": 1})
    ).status_code == 409


@pytest.mark.parametrize("content", [" ", "😀" * 1951, "a\x00b"])
async def test_invalid_reply_text(console, content):
    client, _, _, _, _, _ = console
    group = (await client.post("/console/reply-groups", json={"name": "a"})).json()
    assert (
        await client.post("/console/replies", json={"group_id": group["id"], "text": content})
    ).status_code == 422


async def test_catalog_csrf_and_auth(console):
    client, _, _, _, _, _ = console
    client.headers.pop("X-CSRF-Token")
    assert (await client.post("/console/reply-groups", json={"name": "a"})).status_code == 403
    client.cookies.clear()
    assert (await client.get("/console/reply-groups")).status_code == 401


async def test_project_rls_and_cross_project_reference(installation):
    database, _, _, _, alice, bob, first, second, _ = installation
    a = database.for_project(first.id)
    b = database.for_project(second.id)
    catalog_a, catalog_b = QuickReplyCatalog(a), QuickReplyCatalog(b)
    group = await catalog_a.create_group(alice, "оплата")
    # Same names in different projects are independent.
    await catalog_b.create_group(bob, "оплата")
    reply = await catalog_a.save(alice, group["id"], "Only A")
    assert await catalog_b.replies(None) == []
    with pytest.raises(HTTPException) as error:
        await catalog_b.save(bob, group["id"], "Forbidden")
    assert error.value.status_code == 404
    with pytest.raises(HTTPException):
        await catalog_b.delete(bob, int(reply["id"]), 0)
    async with b.session() as session:
        assert (
            await session.scalar(select(QuickResponse).where(QuickResponse.id == int(reply["id"])))
            is None
        )
        assert await session.get(QuickResponseGroup, group["id"]) is None
        with pytest.raises(DBAPIError, match="Invalid project reference"):
            await session.execute(
                text("""
                INSERT INTO quick_responses (project_id, text, tags, created_by_telegram_id,
                  group_id, state, publication_format_version, revision, created_at, updated_at)
                VALUES (:project, 'bad', '[]', 0, :group, 'valid', 0, 0, now(), now())
            """),
                {"project": second.id, "group": group["id"]},
            )
        await session.rollback()
    async with database.session() as session:
        assert (await session.execute(text("SELECT id FROM quick_response_groups"))).all() == []
    assert (await catalog_a.groups())[0]["id"] == group["id"]


async def test_unknown_group_and_reply(console):
    client, _, _, _, _, _ = console
    assert (
        await client.get("/console/replies", params={"group_id": str(uuid.uuid4())})
    ).status_code == 404
    assert (
        await client.post("/console/replies/999999999999999999/delete", json={"revision": 0})
    ).status_code == 422
    assert (
        await client.post("/console/replies/2147483647/delete", json={"revision": 0})
    ).status_code == 404


async def test_catalog_migration_preserves_existing_answers(postgres_database_url):
    config = build_alembic_config(postgres_database_url)
    await asyncio.to_thread(command.upgrade, config, "0009_console_read_paths")
    database = ProjectDatabase(postgres_database_url)
    try:
        await seed_project(database)
        async with database.session() as session:
            await session.execute(
                text("""
                INSERT INTO quick_responses
                  (text, tags, created_by_telegram_id, source_chat_id, source_message_id,
                   published_message_id, state, created_at, updated_at)
                VALUES ('Старый ответ #VPN', '["#VPN"]', 7, -100123, 300, 501,
                        'valid', now(), now())
            """)
            )
            await session.commit()
        await upgrade_database(postgres_database_url)
        catalog = QuickReplyCatalog(database)
        groups = await catalog.groups()
        assert len(groups) == 1 and groups[0]["name"] == "общее"
        rows = await catalog.replies(groups[0]["id"])
        assert rows[0]["text"] == "Старый ответ #VPN"
        pending = await QuickReplyService(database).list_publication_candidates()
        assert len(pending) == 1 and pending[0].published_message_id == 501
        assert pending[0].group_name == "общее"
    finally:
        await database.dispose()


async def test_catalog_pagination_and_legacy_length_guard(console):
    _, database, _, _, actor, _ = console
    catalog = QuickReplyCatalog(database)
    group = await catalog.create_group(actor, "общее")
    async with database.session() as session:
        session.add_all(
            [
                QuickResponse(text=f"Reply {i}", group_id=group["id"], created_by_telegram_id=0)
                for i in range(51)
            ]
        )
        await session.commit()
    assert len(await catalog.replies(group["id"])) == 50
    assert len(await catalog.replies(group["id"], offset=50)) == 1
    assert await catalog.replies(group["id"], q="%") == []
    async with database.session() as session:
        row = await session.scalar(select(QuickResponse).limit(1))
        row.text = "a" * 4088
        await session.commit()
    with pytest.raises(HTTPException) as error:
        await catalog.change_group(actor, group["id"], 0, "очень_длинная_группа")
    assert error.value.status_code == 409
    assert (await catalog.groups())[0]["name"] == "общее"


async def test_catalog_routes_require_project_membership(installation, tmp_path):
    from resolvate.api import create_app
    from resolvate.installation import ProjectManager, ProjectRuntime, create_installation
    from resolvate.services import TicketService

    database, settings, _, _, _, _, first, second, _ = installation
    manager = ProjectManager(database, settings)
    for project in (first, second):
        scoped = database.for_project(project.id)
        stop = asyncio.Event()
        manager.runtimes[project.id] = ProjectRuntime(
            project.revision,
            stop,
            asyncio.create_task(stop.wait()),
            create_app(
                database=scoped,
                ticket_service=TicketService(scoped),
                settings=settings.model_copy(update={"data_dir": tmp_path / project.id}),
            ),
        )
    app = create_installation(database, settings, manager)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://localhost:8080",
            headers={"Origin": "http://localhost:8080"},
        ) as client:
            login = await client.post(
                "/console/login", json={"login": "alice", "password": "project-test-password-only"}
            )
            client.headers["X-CSRF-Token"] = login.json()["csrf"]
            own, other = f"/console/projects/{first.id}", f"/console/projects/{second.id}"
            group = await client.post(f"{own}/reply-groups", json={"name": "оплата"})
            assert group.status_code == 200, group.text
            assert (await client.get(f"{other}/reply-groups")).status_code == 403
            assert (
                await client.post(f"{other}/reply-groups", json={"name": "vpn"})
            ).status_code == 403
            reply = await client.post(
                f"{own}/replies", json={"group_id": group.json()["id"], "text": "Answer"}
            )
            assert reply.status_code == 200
            assert (
                await client.post(
                    f"{own}/replies/{reply.json()['id']}/edit",
                    json={"group_id": group.json()["id"], "text": "New", "revision": 0},
                )
            ).status_code == 200
            assert (await client.get(f"{own}/replies")).json()[0]["text"] == "New"
    finally:
        for runtime in manager.runtimes.values():
            runtime.stop.set()
        await asyncio.gather(*(runtime.task for runtime in manager.runtimes.values()))


async def test_legacy_invalid_draft_does_not_block_empty_group_deletion(console):
    _, database, _, _, actor, _ = console
    catalog = QuickReplyCatalog(database)
    group = await catalog.create_group(actor, "общее")
    async with database.session() as session:
        draft = QuickResponse(
            text="Unpublished legacy draft",
            group_id=group["id"],
            created_by_telegram_id=0,
            state="pending_deletion",
        )
        session.add(draft)
        await session.commit()
        draft_id = draft.id
    await catalog.change_group(actor, group["id"], 0)
    assert await catalog.groups() == []
    async with database.session() as session:
        retained = await session.get(QuickResponse, draft_id)
        assert retained.text == "Unpublished legacy draft"
        assert retained.group_id is None


async def test_catalog_rejects_invalid_unicode_before_database_access(console):
    _, database, _, _, actor, _ = console
    catalog = QuickReplyCatalog(database)
    group = await catalog.create_group(actor, "оплата")
    for value in ("a\x00b", "\ud800"):
        for operation in (
            catalog.groups(value),
            catalog.replies(group["id"], value),
            catalog.save(actor, group["id"], value),
        ):
            with pytest.raises(HTTPException) as error:
                await operation
            assert error.value.status_code == 422
