from __future__ import annotations

import asyncio
import io
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import HTTPException
from PIL import Image
from pydantic import SecretStr
from sqlalchemy import make_url, select, text
from sqlalchemy.exc import DBAPIError

from resolvate.api import create_app
from resolvate.authorization import AuthorizationService
from resolvate.config import Settings
from resolvate.console_admin import recover
from resolvate.console_auth import ConsoleAuth
from resolvate.database import Database
from resolvate.installation import (
    ProjectManager,
    ProjectRuntime,
    create_installation,
    validate_project_database,
)
from resolvate.models import (
    ConsoleAccount,
    ConsoleSession,
    InboundUpdate,
    Project,
    User,
    UserIdentity,
)
from resolvate.projects import ProjectService, membership, runtime_settings
from resolvate.services import TicketService
from resolvate.web_models import MediaAsset, SystemSetting

PASSWORD = "project-test-password-only"
ORIGIN = "http://localhost:8080"


@pytest.fixture
async def installation(migrated_postgres_database_url: str) -> AsyncIterator[Any]:
    provisioner = Database(migrated_postgres_database_url)
    role = "project_test_" + uuid.uuid4().hex
    async with provisioner.engine.begin() as connection:
        await connection.execute(
            text(
                f"CREATE ROLE {role} LOGIN PASSWORD 'project-test-only-password' "
                "NOSUPERUSER NOBYPASSRLS"
            )
        )
        await connection.execute(text(f"GRANT USAGE ON SCHEMA public TO {role}"))
        await connection.execute(
            text(f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {role}")
        )
        await connection.execute(
            text(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {role}")
        )
    url = (
        make_url(migrated_postgres_database_url)
        .set(username=role, password="project-test-only-password")
        .render_as_string(hide_password=False)
    )
    database = Database(url)
    settings = Settings(database_url=url, console_origin=ORIGIN, _env_file=None)
    auth = ConsoleAuth(database, ORIGIN)
    owner = await auth.create_account(
        login="owner", name="Owner", password=PASSWORD, role="admin", bootstrap=True
    )
    alice = await auth.create_account(
        login="alice", name="Alice", password=PASSWORD, role="operator", telegram_id=111
    )
    bob = await auth.create_account(
        login="bob", name="Bob", password=PASSWORD, role="operator", telegram_id=222
    )
    service = ProjectService(database, settings)
    first = await service.create(owner, "First", "alice")
    second = await service.create(owner, "Second", "bob")
    async with database.session() as session:
        for project in (first, second):
            row = await session.get(Project, project.id)
            row.active = True
        await session.commit()
    try:
        yield database, settings, auth, owner, alice, bob, first, second, service
    finally:
        await database.dispose()
        async with provisioner.engine.begin() as connection:
            await connection.execute(text(f"DROP OWNED BY {role}"))
            await connection.execute(text(f"DROP ROLE {role}"))
        await provisioner.dispose()


async def test_database_boundary_and_pool_reuse(installation: Any) -> None:
    database, _, _, _, _, _, first, second, _ = installation
    await validate_project_database(database)
    a, b = database.for_project(first.id), database.for_project(second.id)
    for db, name in ((a, "first"), (b, "second")):
        async with db.session() as session:
            session.add(SystemSetting(key="same-key", value=name))
            session.add(User(display_name=name))
            await session.commit()
    for _ in range(3):
        for db, expected in ((a, "first"), (b, "second")):
            async with db.session() as session:
                assert (await session.get(SystemSetting, "same-key")).value == expected
                assert (
                    await session.execute(text("SELECT display_name FROM users"))
                ).scalars().all() == [expected]
                assert (await session.scalars(select(User.display_name))).all() == [expected]
        async with database.session() as session:
            assert (await session.execute(text("SELECT * FROM users"))).all() == []
    async with a.session() as session:
        user_id = await session.scalar(select(User.id))
    async with b.session() as session:
        session.add(UserIdentity(user_id=user_id, provider="telegram", external_id="111"))
        with pytest.raises(DBAPIError):
            await session.commit()
    async with b.session() as session:
        with pytest.raises(DBAPIError):
            await session.execute(
                text(
                    "INSERT INTO users (project_id, created_at, updated_at) "
                    "VALUES (:other, now(), now())"
                ),
                {"other": first.id},
            )


async def test_explicit_memberships_roles_and_revocation(installation: Any) -> None:
    database, settings, auth, owner, alice, bob, first, second, service = installation
    assert [row["id"] for row in await service.list_projects(alice)] == [first.id]
    with pytest.raises(HTTPException):
        await membership(database.for_project(first.id), owner)
    with pytest.raises(HTTPException):
        await membership(database.for_project(first.id), bob)
    await service.change_member(alice, first.id, "bob")
    await membership(database.for_project(first.id), bob)
    assert await AuthorizationService(settings, database.for_project(first.id)).can_operate(222)
    await service.change_member(alice, first.id, "bob", remove=True)
    assert not await AuthorizationService(settings, database.for_project(first.id)).can_operate(222)
    await membership(database.for_project(second.id), bob)
    with pytest.raises(HTTPException):
        await service.transfer(alice, "bob", first.id)
    await service.transfer(owner, "bob", first.id)
    with pytest.raises(HTTPException):
        await membership(database.for_project(first.id), alice)
    with pytest.raises(HTTPException):
        await auth.set_active(bob.id, False)
    with pytest.raises(HTTPException):
        await auth.create_account(login="another", name="Another", password=PASSWORD, role="admin")


async def test_project_configuration_has_no_ambient_secrets(
    installation: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, settings, _, owner, alice, _, first, second, service = installation
    monkeypatch.setenv("REMNAWAVE_ENABLED", "true")
    monkeypatch.setenv("SUPPORT_BOT_TOKEN", "999999:ambient-secret-value-never-inherit")
    assert not runtime_settings(settings, first).remnawave_enabled
    assert runtime_settings(settings, first).support_bot_token.get_secret_value() == ""
    token = "123456:" + "a" * 32
    await service.configure(
        alice, first.id, {"support_bot_token": token, "support_group_id": -100123}
    )
    values = await service.configuration(alice, first.id)
    assert values["support_bot_token"] is True
    assert token not in str(values)
    with pytest.raises(HTTPException):
        await service.configuration(owner, first.id)
    with pytest.raises(HTTPException):
        await service.configure(alice, second.id, {})


@pytest.mark.parametrize("first_field", ["support_bot_token", "support_group_id"])
async def test_telegram_configuration_can_be_completed_in_either_order(
    installation: Any, first_field: str
) -> None:
    database, _, _, owner, alice, _, _, _, service = installation
    project = await service.create(owner, "New project", "alice")
    token = "123456:" + "a" * 32
    values = {"support_bot_token": token, "support_group_id": -100123}
    await service.configure(alice, project.id, {first_field: values[first_field]})
    with pytest.raises(HTTPException) as error:
        await service.set_active(owner, project.id, True)
    assert error.value.status_code == 409

    remaining = {key: value for key, value in values.items() if key != first_field}
    await service.configure(alice, project.id, remaining)
    async with database.session() as session:
        configured = await session.get(Project, project.id)
        assert (configured.bot_id, configured.group_id, configured.active) == (
            123456,
            -100123,
            False,
        )
        assert all(configured.settings[key] == value for key, value in values.items())

    # Completing setup must not permit replacing or clearing either destination.
    for invalid in (
        {"support_bot_token": "654321:" + "b" * 32},
        {"support_bot_token": ""},
        {"support_group_id": -100456},
        {"support_group_id": 0},
    ):
        with pytest.raises(HTTPException) as error:
            await service.configure(alice, project.id, invalid)
        assert error.value.status_code == 409

    # Rotating the secret for the same bot is still supported.
    rotated_token = "123456:" + "c" * 32
    await service.configure(alice, project.id, {"support_bot_token": rotated_token})
    await service.set_active(owner, project.id, True)
    async with database.session() as session:
        configured = await session.get(Project, project.id)
        assert configured.active
        assert configured.bot_id == 123456
        assert configured.group_id == -100123
        assert configured.settings["support_bot_token"] == rotated_token
        assert configured.settings["support_group_id"] == -100123


@pytest.mark.parametrize(
    ("field", "original", "replacement", "empty"),
    [
        ("support_bot_token", "123456:" + "a" * 32, "654321:" + "b" * 32, ""),
        ("support_group_id", -100123, -100456, 0),
    ],
)
async def test_partial_telegram_configuration_keeps_existing_binding(
    installation: Any, field: str, original: str | int, replacement: str | int, empty: str | int
) -> None:
    database, _, _, owner, alice, _, _, _, service = installation
    project = await service.create(owner, "Partial setup", "alice")
    await service.configure(alice, project.id, {field: original})
    async with database.session() as session:
        configured = await session.get(Project, project.id)
        expected_settings = dict(configured.settings)
        expected_revision = configured.revision
    for value in (replacement, empty):
        with pytest.raises(HTTPException) as error:
            await service.configure(alice, project.id, {field: value})
        assert error.value.status_code == 409
        async with database.session() as session:
            configured = await session.get(Project, project.id)
            assert configured.settings == expected_settings
            assert configured.revision == expected_revision


async def test_installation_http_does_not_grant_owner_conversations(installation: Any) -> None:
    database, settings, _, _, _, _, first, _, _ = installation
    app = create_installation(database, settings, ProjectManager(database, settings))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as client:
        response = await client.post(
            "/console/login", json={"login": "owner", "password": PASSWORD}
        )
        assert response.status_code == 200
        client.headers["X-CSRF-Token"] = response.json()["csrf"]
        assert (await client.post("/console/tickets/sync", json={})).status_code == 403
        assert (await client.get("/console/projects")).status_code == 200
        assert (await client.get(f"/console/projects/{first.id}/settings")).status_code == 403


async def test_cross_project_http_and_api_tokens(installation: Any, tmp_path: Path) -> None:
    database, settings, _, owner, alice, bob, first, second, service = installation
    manager = ProjectManager(database, settings)
    tokens = {first.id: "a" * 40, second.id: "b" * 40}
    ticket_ids = {}
    for project in (first, second):
        scoped = database.for_project(project.id)
        tickets = TicketService(scoped)
        ticket = await tickets.open_or_reopen(
            telegram_user_id=555, display_name=project.name, username=None
        )
        ticket_ids[project.id] = ticket.id
        config = settings.model_copy(
            update={
                "api_enabled": True,
                "api_admin_token": SecretStr(tokens[project.id]),
                "data_dir": tmp_path / project.id,
            }
        )
        stop = asyncio.Event()
        manager.runtimes[project.id] = ProjectRuntime(
            project.revision,
            stop,
            asyncio.create_task(stop.wait()),
            create_app(database=scoped, ticket_service=tickets, settings=config),
        )
    app = create_installation(database, settings, manager)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}
        ) as client:
            response = await client.post(
                "/console/login", json={"login": "alice", "password": PASSWORD}
            )
            client.headers["X-CSRF-Token"] = response.json()["csrf"]
            own = f"/console/projects/{first.id}"
            other = f"/console/projects/{second.id}"
            assert (await client.get(f"{own}/tickets/{ticket_ids[first.id]}")).status_code == 200
            assert (await client.get(f"{other}/tickets/{ticket_ids[second.id]}")).status_code == 403
            assert (await client.get(f"{own}/tickets/{ticket_ids[second.id]}")).status_code == 404
            assert (
                await client.post(f"{own}/tickets/{ticket_ids[second.id]}/close")
            ).status_code == 404
            assert (await client.get("/console/accounts")).status_code == 403
            assert (
                await client.post(
                    "/console/projects", json={"name": "Forbidden", "admin_login": "alice"}
                )
            ).status_code == 403
            path = f"/projects/{second.id}/api/v1/tickets/{ticket_ids[second.id]}"
            assert (
                await client.get(path, headers={"X-API-Token": tokens[first.id]})
            ).status_code == 401
            assert (
                await client.get(path, headers={"X-API-Token": tokens[second.id]})
            ).status_code == 200
            foreign = f"/projects/{first.id}/api/v1/tickets/{ticket_ids[second.id]}"
            assert (
                await client.get(foreign, headers={"X-API-Token": tokens[first.id]})
            ).status_code == 404
            for route in ("health", "ready", "metrics", "docs", "openapi.json"):
                url = f"/projects/{first.id}/{route}"
                assert (await client.get(url)).status_code == 401
                response = await client.get(url, headers={"X-API-Token": tokens[first.id]})
                assert response.status_code == 200
                if route == "openapi.json":
                    assert response.json()["servers"] == [{"url": f"/projects/{first.id}"}]
                if route == "docs":
                    assert f"/projects/{first.id}/openapi.json" in response.text
            await service.change_member(bob, second.id, "alice")
            assert (await client.get(f"{other}/tickets/{ticket_ids[second.id]}")).status_code == 200
            image = io.BytesIO()
            Image.new("RGB", (3, 3), color="green").save(image, format="PNG")
            command = str(uuid.uuid4())
            media_ids = {}
            for project, prefix in ((first, own), (second, other)):
                sent = await client.post(
                    f"{prefix}/tickets/{ticket_ids[project.id]}/send",
                    files={"file": ("test.png", image.getvalue(), "image/png")},
                    data={"text": project.name},
                    headers={"X-Idempotency-Key": command},
                )
                assert sent.status_code == 200, sent.text
                async with database.for_project(project.id).session() as session:
                    media = await session.scalar(select(MediaAsset))
                    media_ids[project.id] = media.id
                assert (await client.get(f"{prefix}/media/{media.id}")).status_code == 200
            # Even an operator of both projects must use the correct project context.
            assert (await client.get(f"{own}/media/{media_ids[second.id]}")).status_code == 410
            assert (await client.get(f"{other}/media/{media_ids[first.id]}")).status_code == 410
            await service.change_member(bob, second.id, "alice", remove=True)
            assert (await client.get(f"{other}/tickets/{ticket_ids[second.id]}")).status_code == 403
    finally:
        for runtime in manager.runtimes.values():
            runtime.stop.set()
        await asyncio.gather(*(runtime.task for runtime in manager.runtimes.values()))


async def test_owner_transfer_and_cli_recovery_revoke_sessions(installation: Any) -> None:
    database, _, auth, owner, alice, bob, _, _, service = installation
    await auth.login("owner", PASSWORD, "test")
    await service.transfer(owner, "bob")
    async with database.session() as session:
        assert (
            await session.scalars(select(ConsoleAccount.id).where(ConsoleAccount.role == "admin"))
        ).all() == [bob.id]
        assert (await session.scalars(select(ConsoleSession))).all() == []
    with pytest.raises(HTTPException):
        await service.create(owner, "Stale owner", "alice")
    await auth.login("bob", PASSWORD, "test")
    await recover(database, "alice", "new-recovery-password")
    async with database.session() as session:
        assert (
            await session.scalars(select(ConsoleAccount.id).where(ConsoleAccount.role == "admin"))
        ).all() == [alice.id]
        assert (await session.scalars(select(ConsoleSession))).all() == []
    await auth.login("alice", "new-recovery-password", "test")


async def test_project_keys_are_unique_and_disabled_projects_keep_data(installation: Any) -> None:
    database, settings, _, owner, alice, bob, first, second, service = installation
    key = "unique-project-api-credential-value-123"
    await service.configure(alice, first.id, {"api_enabled": True, "api_admin_token": key})
    with pytest.raises(HTTPException) as error:
        await service.configure(bob, second.id, {"api_enabled": True, "api_admin_token": key})
    assert error.value.status_code == 409
    for project in (first, second):
        async with database.for_project(project.id).session() as session:
            session.add(InboundUpdate(telegram_update_id=123, ordering_key="same", payload={}))
            await session.commit()
    await service.set_active(owner, first.id, False)
    with pytest.raises(HTTPException):
        await membership(database.for_project(first.id), alice)
    async with database.for_project(first.id).session() as session:
        assert await session.get(InboundUpdate, 123) is not None
    await membership(database.for_project(second.id), bob)
    with pytest.raises(HTTPException):
        await service.set_telegram_identity(alice, alice.id, 333)
    await service.set_telegram_identity(owner, alice.id, 333)
    assert not await AuthorizationService(settings, database.for_project(second.id)).can_operate(
        333
    )


async def test_manager_restarts_only_changed_project(
    installation: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    database, settings, _, owner, _, _, first, second, _ = installation
    manager = ProjectManager(database, settings)
    starts = []

    async def fake_start(project: Project, stop: asyncio.Event) -> None:
        starts.append(project.id)
        await stop.wait()

    monkeypatch.setattr(manager, "_start", fake_start)
    await manager.reconcile()
    await asyncio.sleep(0)
    unchanged = manager.runtimes[second.id].task
    async with database.session() as session:
        project = await session.get(Project, first.id)
        project.revision += 1
        await session.commit()
    await manager.reconcile()
    await asyncio.sleep(0)
    await manager.reconcile()
    await asyncio.sleep(0)
    assert starts.count(first.id) == 2
    assert manager.runtimes[second.id].task is unchanged
    for runtime in manager.runtimes.values():
        runtime.stop.set()
    await asyncio.gather(*(runtime.task for runtime in manager.runtimes.values()))
