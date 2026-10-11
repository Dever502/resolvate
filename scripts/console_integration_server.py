"""Loopback-only browser test server: real HTTP/API, PostgreSQL, auth and RLS.

No production database, Telegram polling, delivery workers or external integrations.
The same guarded disposable database helper as pytest owns database cleanup.
"""

from __future__ import annotations

import asyncio
import os
import signal
import tempfile
import uuid
from contextlib import aclosing
from pathlib import Path

import psycopg
import uvicorn
from postgres_support import configured_postgres_admin_url, disposable_postgres_database
from psycopg import sql
from sqlalchemy import make_url

from resolvate.api import create_app
from resolvate.config import Settings
from resolvate.console_auth import ConsoleAuth
from resolvate.database import Database
from resolvate.installation import (
    ProjectManager,
    ProjectRuntime,
    create_installation,
    validate_project_database,
)
from resolvate.media_storage import LocalMediaStorage
from resolvate.migrations import upgrade_database
from resolvate.models import (
    Direction,
    Project,
    ProjectMember,
    Ticket,
    TicketMessage,
    User,
    UserIdentity,
)
from resolvate.postgres_provision import PostgresProvisioningSettings, provision_postgres_roles
from resolvate.services import TicketService

PASSWORD = "browser-test-password-only"
FIRST = "00000000-0000-4000-8000-000000000101"
SECOND = "00000000-0000-4000-8000-000000000102"
TICKET = "00000000-0000-4000-8000-000000000201"
OTHER_TICKET = "00000000-0000-4000-8000-000000000202"


async def serve(database: Database, directory: Path, port: int) -> None:
    origin = f"http://127.0.0.1:{port}"
    settings = Settings(
        database_url=database.engine.url.render_as_string(hide_password=False),
        console_origin=origin,
        data_dir=directory,
        _env_file=None,
    )
    await validate_project_database(database)
    auth = ConsoleAuth(database, origin)
    owner = await auth.create_account(
        login="owner", name="CI Administrator", password=PASSWORD, role="admin", bootstrap=True
    )
    operator = await auth.create_account(
        login="operator", name="CI Operator", password=PASSWORD, role="operator"
    )
    async with database.session() as session:
        session.add_all(
            [
                Project(
                    id=FIRST, name="Browser project", admin_id=owner.id, active=True, settings={}
                ),
                Project(
                    id=SECOND, name="Private project", admin_id=owner.id, active=True, settings={}
                ),
            ]
        )
        await session.flush()
        session.add(ProjectMember(project_id=FIRST, account_id=operator.id))
        await session.commit()

    manager = ProjectManager(database, settings)
    stop = asyncio.Event()

    async def wait_for_stop() -> None:
        await stop.wait()

    task = asyncio.create_task(wait_for_stop())
    try:
        for project_id, ticket_id, name in (
            (FIRST, TICKET, "Browser customer"),
            (SECOND, OTHER_TICKET, "Private customer"),
        ):
            scoped = database.for_project(project_id)
            async with scoped.session() as session:
                user = User(display_name=name)
                session.add(user)
                await session.flush()
                session.add(
                    UserIdentity(
                        user_id=user.id,
                        provider="telegram",
                        external_id="10001" if project_id == FIRST else "10002",
                    )
                )
                ticket = Ticket(id=ticket_id, user_id=user.id, topic_id=10, status="open")
                session.add(ticket)
                await session.flush()
                session.add(
                    TicketMessage(
                        ticket_id=ticket.id,
                        direction=Direction.USER_TO_OPERATOR,
                        content=f"Hello from {name}",
                    )
                )
                await session.commit()
            project_settings = settings.model_copy(update={"support_group_id": -1001234567890})
            app = create_app(
                database=scoped,
                ticket_service=TicketService(scoped),
                settings=project_settings,
                media_storage=LocalMediaStorage(directory / project_id),
            )
            async with database.session() as session:
                project = await session.get(Project, project_id)
                assert project is not None
                manager.runtimes[project_id] = ProjectRuntime(project.revision, stop, task, app)
        # Uvicorn re-raises SIGTERM after shutting down. Let serve() return so
        # our outer finally blocks can remove the database, files and roles.
        previous_sigterm = signal.signal(signal.SIGTERM, lambda *_: None)
        try:
            await uvicorn.Server(
                uvicorn.Config(
                    create_installation(database, settings, manager), host="127.0.0.1", port=port
                )
            ).serve()
        finally:
            signal.signal(signal.SIGTERM, previous_sigterm)
    finally:
        stop.set()
        await task


async def main() -> None:
    admin = make_url(configured_postgres_admin_url())
    suffix = uuid.uuid4().hex
    migration_role, runtime_role = f"sbm_{suffix}", f"sbr_{suffix}"
    try:
        async with aclosing(disposable_postgres_database()) as databases:
            url = await anext(databases)
            child = make_url(url)
            provision = PostgresProvisioningSettings(
                host=child.host or "127.0.0.1",
                port=child.port or 5432,
                database=child.database or "",
                admin_user=child.username or "",
                admin_password=child.password or "local-trust-test-password",
                migration_role=migration_role,
                migration_password=PASSWORD,
                runtime_role=runtime_role,
                runtime_password=PASSWORD,
            )
            await provision_postgres_roles(provision)
            await upgrade_database(
                child.set(username=migration_role, password=PASSWORD).render_as_string(
                    hide_password=False
                )
            )
            runtime_url = child.set(username=runtime_role, password=PASSWORD).render_as_string(
                hide_password=False
            )
            database = Database(runtime_url)
            try:
                with tempfile.TemporaryDirectory(prefix="resolvate-browser-") as directory:
                    await serve(
                        database, Path(directory), int(os.getenv("CONSOLE_TEST_PORT", "4174"))
                    )
            finally:
                await database.dispose()
    finally:
        # The disposable database is gone before its owning roles are removed.
        async with await psycopg.AsyncConnection.connect(
            host=admin.host,
            port=admin.port or 5432,
            dbname=admin.database,
            user=admin.username,
            password=admin.password,
            autocommit=True,
        ) as connection:
            for role in (runtime_role, migration_role):
                await connection.execute(
                    sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(role))
                )


if __name__ == "__main__":
    os.chdir(Path(__file__).resolve().parents[1])
    asyncio.run(main())
