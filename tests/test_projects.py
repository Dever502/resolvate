from __future__ import annotations

import asyncio
import io
import uuid
from collections.abc import AsyncIterator
from datetime import timedelta
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
from resolvate.console_events import ConsoleEvents
from resolvate.console_folders import ConsoleFolders
from resolvate.console_service import ConsoleService
from resolvate.database import Database
from resolvate.installation import (
    ProjectManager,
    ProjectRuntime,
    create_installation,
    validate_project_database,
)
from resolvate.models import (
    ConsoleAccount,
    ConsoleRead,
    ConsoleSession,
    Direction,
    InboundUpdate,
    Project,
    Ticket,
    TicketFolder,
    TicketMessage,
    User,
    UserIdentity,
    utcnow,
)
from resolvate.projects import ProjectService, membership, runtime_settings
from resolvate.service_types import TicketNotFoundError
from resolvate.services import TicketService
from resolvate.web_models import MediaAsset, SystemSetting

PASSWORD = "project-test-password-only"
ORIGIN = "http://localhost:8080"


def logo_bytes(color: str = "blue", *, size: tuple[int, int] = (800, 400)) -> bytes:
    from PIL.PngImagePlugin import PngInfo

    output = io.BytesIO()
    metadata = PngInfo()
    metadata.add_text("Author", "Discard this metadata")
    Image.new("RGBA", size, color).save(output, "PNG", pnginfo=metadata)
    return output.getvalue()


@pytest.fixture
async def installation(migrated_postgres_database_url: str, tmp_path: Path) -> AsyncIterator[Any]:
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
    settings = Settings(database_url=url, console_origin=ORIGIN, data_dir=tmp_path, _env_file=None)
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


@pytest.mark.parametrize(
    ("field", "value"),
    [("support_bot_token", "123456:" + "a" * 35), ("support_group_id", -100123456)],
)
async def test_duplicate_destination_returns_conflict_without_partial_update(
    installation: Any, field: str, value: str | int
) -> None:
    database, _, _, _, alice, bob, first, second, service = installation
    await service.configure(alice, first.id, {field: value})
    async with database.session() as session:
        project = await session.get(Project, second.id)
        previous_settings = dict(project.settings)
        previous_revision = project.revision
    with pytest.raises(HTTPException) as error:
        await service.configure(bob, second.id, {field: value})
    assert error.value.status_code == 409
    async with database.session() as session:
        project = await session.get(Project, second.id)
        assert project.settings == previous_settings
        assert project.revision == previous_revision


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


async def test_console_unread_and_ticket_detail_preserve_project_isolation(
    installation: Any,
) -> None:
    database, settings, _, _, alice, bob, first, second, _ = installation
    boundary = utcnow()
    ids: list[str] = []
    for project, other_operator in ((first, bob), (second, alice)):
        db = database.for_project(project.id)
        tickets = TicketService(db)
        ticket = await tickets.open_or_reopen(
            telegram_user_id=1234, display_name=project.name, username=None
        )
        ids.append(ticket.id)
        async with db.session() as session:
            # Before, at, and after the receipt; only the final incoming row is unread.
            for direction, suppressed, at in (
                (Direction.USER_TO_OPERATOR, False, boundary - timedelta(seconds=1)),
                (Direction.USER_TO_OPERATOR, False, boundary),
                (Direction.USER_TO_OPERATOR, False, boundary + timedelta(seconds=1)),
                (Direction.USER_TO_OPERATOR, True, boundary + timedelta(seconds=2)),
                (Direction.OPERATOR_TO_USER, False, boundary + timedelta(seconds=3)),
            ):
                session.add(
                    TicketMessage(
                        ticket_id=ticket.id,
                        direction=direction,
                        suppressed=suppressed,
                        created_at=at,
                        content="test",
                    )
                )
            session.add(
                ConsoleRead(account_id=other_operator.id, ticket_id=ticket.id, through_at=boundary)
            )
            await session.commit()

    for project, operator, other_operator, ticket_id, foreign_id in (
        (first, alice, bob, ids[0], ids[1]),
        (second, bob, alice, ids[1], ids[0]),
    ):
        db = database.for_project(project.id)
        tickets = TicketService(db)
        service = ConsoleService(db, tickets, settings)
        for account, expected in ((operator, 3), (other_operator, 1)):
            result = await service.list_tickets(
                account, archived=False, query="", limit=50, offset=0
            )
            assert [(item["id"], item["unread"]) for item in result] == [(ticket_id, expected)]
        assert (await tickets.get_ticket(ticket_id)).display_name == project.name
        with pytest.raises(TicketNotFoundError):
            await tickets.get_ticket(foreign_id)


async def test_console_pagination_filters_before_limit_and_keeps_tied_order(
    installation: Any,
) -> None:
    database, settings, _, _, alice, _, first, second, _ = installation
    at = utcnow()
    for project in (first, second):
        db = database.for_project(project.id)
        tickets = TicketService(db)
        for index in range(8):
            ticket = await tickets.open_or_reopen(
                telegram_user_id=2000 + index,
                display_name="Find%_" if index < 6 else "Other",
                username=None,
            )
            async with db.session() as session:
                stored = await session.get(Ticket, ticket.id)
                stored.status = "closed" if index % 2 else "open"
                stored.last_activity_at = at
                session.add(
                    TicketMessage(
                        ticket_id=ticket.id,
                        direction=Direction.USER_TO_OPERATOR,
                        content=f"preview {index}",
                        created_at=at,
                    )
                )
                await session.commit()

    db = database.for_project(first.id)
    service = ConsoleService(db, TicketService(db), settings)
    for archived in (False, True):
        for query, expected_count in (("", 4), ("Find%_", 3)):
            full = await service.list_tickets(
                alice, archived=archived, query=query, limit=50, offset=0
            )
            assert len(full) == expected_count
            assert [item["id"] for item in full] == sorted(
                (item["id"] for item in full), reverse=True
            )
            pages = []
            for offset in (0, 2, 4):
                pages.extend(
                    await service.list_tickets(
                        alice, archived=archived, query=query, limit=2, offset=offset
                    )
                )
            assert pages == full
            assert all(
                item["unread"] == 1 and item["preview"].startswith("preview") for item in full
            )


async def test_project_logo_permissions_replacement_and_lifetime(installation: Any) -> None:
    database, settings, _, _, alice, _, first, second, service = installation
    settings.storage_reserve_bytes = 0
    app = create_installation(database, settings, ProjectManager(database, settings))
    path = f"/console/projects/{first.id}/logo"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as client:

        async def login(name: str) -> None:
            response = await client.post(
                "/console/login", json={"login": name, "password": PASSWORD}
            )
            assert response.status_code == 200
            client.headers["X-CSRF-Token"] = response.json()["csrf"]

        assert (await client.get(path)).status_code == 401
        await login("alice")
        assert (await client.get(path)).status_code == 404
        result = await client.post(path, files={"file": ("logo.png", logo_bytes(), "image/png")})
        assert result.status_code == 200, result.text
        first_digest = result.json()["logo"]
        png = await client.get(path)
        assert png.headers["content-type"] == "image/png"
        with Image.open(io.BytesIO(png.content)) as image:
            assert image.size == (512, 256) and image.format == "PNG"
            assert "Author" not in image.info
        root = settings.data_dir / "projects" / first.id / "branding"
        assert (root / f"{first_digest}.png").is_file()
        # No runtime is running; logo management must remain available without one.
        async with database.session() as session:
            project = await session.get(Project, first.id)
            revision = project.revision
            project.active = False
            await session.commit()
        replacement = await client.post(
            path, files={"file": ("logo.png", logo_bytes("red"), "image/png")}
        )
        digest = replacement.json()["logo"]
        assert digest != first_digest and not (root / f"{first_digest}.png").exists()
        assert len(list(root.glob("*.png"))) == 1
        async with database.session() as session:
            project = await session.get(Project, first.id)
            assert project.logo_sha256 == digest and project.revision == revision
        assert (await client.get(path)).status_code == 200
        assert (await client.get(f"/console/projects/{second.id}/logo")).status_code == 403
        await login("owner")
        assert (await client.get(path)).status_code == 403
        assert (await client.post(path + "/remove")).status_code == 403
        assert (
            next(p for p in (await client.get("/console/projects")).json() if p["id"] == first.id)[
                "logo"
            ]
            is None
        )
        await login("bob")
        assert (await client.get(path)).status_code == 403
        await service.change_member(alice, first.id, "bob")
        assert (await client.get(path)).status_code == 200
        assert (
            await client.post(path, files={"file": ("logo.png", logo_bytes(), "image/png")})
        ).status_code == 403
        assert (await client.post(path + "/remove")).status_code == 403
        await service.change_member(alice, first.id, "bob", remove=True)
        assert (await client.get(path)).status_code == 403
        await login("alice")
        assert (await client.post(path + "/remove")).status_code == 200
        assert (await client.get(path)).status_code == 404
        assert not list(root.glob("*.png"))


async def test_project_logo_rejects_unsafe_uploads_and_requires_csrf(installation: Any) -> None:
    from resolvate.project_branding import MAX_LOGO_BYTES

    database, settings, _, _, _, _, first, _, _ = installation
    app = create_installation(database, settings, ProjectManager(database, settings))
    path = f"/console/projects/{first.id}/logo"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as client:
        response = await client.post(
            "/console/login", json={"login": "alice", "password": PASSWORD}
        )
        file = ("logo.png", logo_bytes(), "image/png")
        assert (await client.post(path, files={"file": file})).status_code == 403
        client.headers["X-CSRF-Token"] = response.json()["csrf"]
        assert (
            await client.post(
                path, files={"file": file}, headers={"Origin": "https://outside.example"}
            )
        ).status_code == 403
        for content, mime in (
            (b"<svg/>", "image/svg+xml"),
            (b"PK\x03\x04archive", "image/png"),
            (logo_bytes() + b"PK\x03\x04archive", "image/png"),
            (b"", "image/png"),
        ):
            result = await client.post(path, files={"file": ("logo", content, mime)})
            assert result.status_code == 422, result.text
        assert (await client.post(path, files=[("file", file), ("file", file)])).status_code == 400
        assert (
            await client.post(
                path, files={"file": ("large", b"x" * (MAX_LOGO_BYTES + 1), "image/png")}
            )
        ).status_code == 422
        assert (
            await client.post(
                path, files={"file": ("large", b"x" * (MAX_LOGO_BYTES + 65536), "image/png")}
            )
        ).status_code == 413
        assert (await client.get(path)).status_code == 404


@pytest.mark.parametrize(
    "format,mime", [("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")]
)
def test_logo_normalizes_supported_formats(format: str, mime: str) -> None:
    from resolvate.project_branding import ProjectBranding

    output = io.BytesIO()
    Image.new("RGB", (20, 40), "green").save(output, format)
    png = ProjectBranding._normalize(output.getvalue())
    with Image.open(io.BytesIO(png)) as image:
        assert image.format == "PNG" and image.size == (20, 40)


async def test_logo_respects_disk_reserve(installation: Any) -> None:
    from starlette.datastructures import Headers, UploadFile

    from resolvate.project_branding import ProjectBranding

    _, settings, _, _, alice, _, first, _, service = installation
    settings.storage_reserve_bytes = 2**63 - 1
    branding = ProjectBranding(service)
    upload = UploadFile(
        io.BytesIO(logo_bytes()),
        filename="logo.png",
        headers=Headers({"content-type": "image/png"}),
    )
    with pytest.raises(HTTPException) as error:
        await branding.upload(alice, first.id, upload)
    assert error.value.status_code == 503
    assert upload.file.closed
    with pytest.raises(HTTPException) as error:
        await branding.read(alice, first.id)
    assert error.value.status_code == 404


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


async def test_member_candidates_are_minimal_authorized_and_filtered(installation: Any) -> None:
    database, settings, auth, owner, alice, bob, first, second, service = installation
    await service.change_member(owner, first.id, "owner")
    candidates = await service.member_candidates(alice, first.id)
    assert candidates == [{"id": bob.id, "login": "bob", "name": "Bob"}]
    assert await service.member_candidates(owner, first.id, " BO ") == candidates
    assert await service.member_candidates(alice, first.id, "%") == []
    assert await service.member_candidates(alice, first.id, "_") == []
    with pytest.raises(HTTPException) as denied:
        await service.member_candidates(bob, first.id)
    assert denied.value.status_code == 403
    with pytest.raises(HTTPException) as denied:
        await service.member_candidates(alice, second.id)
    assert denied.value.status_code == 403

    app = create_installation(database, settings, ProjectManager(database, settings))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as client:
        path = f"/console/projects/{first.id}/member-candidates"
        assert (await client.get(path)).status_code == 401
        response = await client.post(
            "/console/login", json={"login": "alice", "password": PASSWORD}
        )
        client.headers["X-CSRF-Token"] = response.json()["csrf"]
        assert (await client.get(path, params={"q": "bOb"})).json() == candidates
        assert (await client.get(path, params={"q": "x" * 101})).status_code == 422
        assert (await client.get("/console/accounts")).status_code == 403
        assert (
            await client.get(f"/console/projects/{second.id}/member-candidates")
        ).status_code == 403
        # Searching is read-only; selection must be followed by an explicit grant.
        assert len(await service.members(alice, first.id)) == 2
        assert (
            await client.post(f"/console/projects/{first.id}/members", json={"login": "bob"})
        ).status_code == 200
        assert (await client.get(path)).json() == []
        # Membership alone must not grant access to the employee directory.
        await client.post("/console/login", json={"login": "bob", "password": PASSWORD})
        assert (await client.get(path)).status_code == 403
    await service.change_member(alice, first.id, "bob", remove=True)
    async with database.session() as session:
        row = await session.get(ConsoleAccount, bob.id)
        assert row is not None
        row.active = False
        await session.commit()
    assert await service.member_candidates(alice, first.id) == []


async def test_member_candidates_search_names_and_limit_results(installation: Any) -> None:
    database, _, _, owner, alice, _, first, _, service = installation
    async with database.session() as session:
        session.add_all(
            ConsoleAccount(
                login=f"candidate{i:03}",
                display_name=f"Employee {i}",
                password_hash="unused-test-hash",
                role="operator",
                active=True,
            )
            for i in range(55)
        )
        await session.commit()
    candidates = await service.member_candidates(owner, first.id, "candidate")
    assert len(candidates) == 50
    assert [row["login"] for row in candidates] == sorted(row["login"] for row in candidates)
    found = await service.member_candidates(alice, first.id, "eMPLOyee 54")
    assert len(found) == 1 and found[0]["login"] == "candidate054"


async def test_folder_database_boundary_rejects_cross_project_references(installation: Any) -> None:
    database, _, _, _, alice, bob, first, second, _ = installation
    a, b = database.for_project(first.id), database.for_project(second.id)
    folder_a = await ConsoleFolders(a).create(alice, "Папка")
    folder_b = await ConsoleFolders(b).create(bob, "Папка")
    ticket = await TicketService(a).open_or_reopen(
        telegram_user_id=555, display_name="Client", username=None
    )
    async with database.session() as session:
        assert (await session.execute(text("SELECT * FROM ticket_folders"))).all() == []
    async with a.session() as session:
        assert (await session.get(TicketFolder, folder_b["id"])) is None
        assert (await session.execute(text("SELECT id FROM ticket_folders"))).scalars().all() == [
            folder_a["id"]
        ]
        with pytest.raises(DBAPIError):
            await session.execute(
                text("UPDATE tickets SET folder_id = :folder WHERE id = :ticket"),
                {"folder": folder_b["id"], "ticket": ticket.id},
            )
        await session.rollback()
    await ConsoleFolders(a).move(alice, ticket.id, folder_a["id"], 0)
    async with a.session() as session:
        await session.execute(
            text("DELETE FROM ticket_folders WHERE id = :id"), {"id": folder_a["id"]}
        )
        await session.commit()
        assert (await session.get(Ticket, ticket.id)).folder_id is None
    assert len(await ConsoleFolders(b).list()) == 1


async def test_typed_reference_checks_cover_insert_and_update(installation: Any) -> None:
    database, _, _, _, _, _, first, second, _ = installation
    a, b = database.for_project(first.id), database.for_project(second.id)
    ticket_a = await TicketService(a).open_or_reopen(
        telegram_user_id=556, display_name="First", username=None
    )
    ticket_b = await TicketService(b).open_or_reopen(
        telegram_user_id=557, display_name="Second", username=None
    )
    async with b.session() as session:
        foreign_user = (await session.get(Ticket, ticket_b.id)).user_id
    async with a.session() as session:
        definition = await session.scalar(
            text(
                "SELECT pg_get_triggerdef(oid) FROM pg_trigger "
                "WHERE tgrelid = 'tickets'::regclass AND tgname = 'project_ref_user_id'"
            )
        )
        assert "UPDATE OF user_id, project_id" in definition
        assert "'integer'" in definition
        # Unrelated hot-path updates still succeed, while FK changes are checked.
        await session.execute(
            text("UPDATE tickets SET last_activity_at = now() WHERE id = :id"), {"id": ticket_a.id}
        )
        await session.commit()
        with pytest.raises(DBAPIError):
            await session.execute(
                text("UPDATE tickets SET user_id = :user WHERE id = :id"),
                {"user": foreign_user, "id": ticket_a.id},
            )
        await session.rollback()


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


async def test_cross_project_http_and_api_tokens(
    installation: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = ConsoleEvents.stream

    async def finite(self: ConsoleEvents, item: Any, authorize: Any) -> AsyncIterator[str]:
        stream = original(self, item, authorize)
        try:
            yield await anext(stream)
        finally:
            await stream.aclose()

    monkeypatch.setattr(ConsoleEvents, "stream", finite)
    database, settings, _, owner, alice, bob, first, second, service = installation
    manager = ProjectManager(database, settings)
    tokens = {first.id: "a" * 40, second.id: "b" * 40}
    ticket_ids = {}
    folder_ids = {}
    for project in (first, second):
        scoped = database.for_project(project.id)
        tickets = TicketService(scoped)
        ticket = await tickets.open_or_reopen(
            telegram_user_id=555, display_name=project.name, username=None
        )
        ticket_ids[project.id] = ticket.id
        folder_ids[project.id] = (await ConsoleFolders(scoped).create(alice, "Общая папка"))["id"]
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
            assert (await client.get(f"{own}/events")).status_code == 200
            assert (await client.get(f"/console/projects/{second.id}/events")).status_code == 403
            other = f"/console/projects/{second.id}"
            assert (await client.get(f"{own}/tickets/{ticket_ids[first.id]}")).status_code == 200
            own_folders = await client.get(f"{own}/folders")
            assert own_folders.status_code == 200
            assert [f["id"] for f in own_folders.json()] == [folder_ids[first.id]]
            assert (await client.get(f"{other}/folders")).status_code == 403
            assert (
                await client.post(
                    f"{own}/folders/{folder_ids[second.id]}/delete", json={"revision": 0}
                )
            ).status_code == 404
            assert (
                await client.post(
                    f"{own}/folders/{folder_ids[second.id]}/rename",
                    json={"name": "Чужая", "revision": 0},
                )
            ).status_code == 404
            assert (
                await client.post(
                    f"{own}/tickets/{ticket_ids[first.id]}/folder",
                    json={"folder_id": folder_ids[second.id], "revision": 0},
                )
            ).status_code == 404
            assert (
                await client.post(
                    f"{own}/tickets/{ticket_ids[second.id]}/folder",
                    json={"folder_id": folder_ids[first.id], "revision": 0},
                )
            ).status_code == 404
            assert (
                await client.post(f"{own}/tickets/sync", json={"folder_id": folder_ids[second.id]})
            ).json()["items"] == []
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
                assert (await client.get(f"{prefix}/media/{media.id}/thumbnail")).status_code == 200
            # Even an operator of both projects must use the correct project context.
            assert (await client.get(f"{own}/media/{media_ids[second.id]}")).status_code == 410
            assert (await client.get(f"{other}/media/{media_ids[first.id]}")).status_code == 410
            assert (
                await client.get(f"{own}/media/{media_ids[second.id]}/thumbnail")
            ).status_code == 410
            assert (
                await client.get(f"{other}/media/{media_ids[first.id]}/thumbnail")
            ).status_code == 410
            await service.change_member(bob, second.id, "alice", remove=True)
            assert (await client.get(f"{other}/tickets/{ticket_ids[second.id]}")).status_code == 403
            assert (await client.get(f"{other}/events")).status_code == 403
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
