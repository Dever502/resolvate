"""One HTTP listener and pool; independent, restartable project runtimes."""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass

from fastapi import FastAPI
from sqlalchemy import Table, select, text
from starlette.responses import JSONResponse
from starlette.types import Receive, Scope, Send

from resolvate.api import client_key_from_request
from resolvate.api_server import ApiServer
from resolvate.config import Settings, get_settings
from resolvate.console import create_console
from resolvate.database import Database
from resolvate.heartbeat import Heartbeat
from resolvate.logging_config import configure_logging
from resolvate.media_storage import LocalMediaStorage
from resolvate.migrations import upgrade_database
from resolvate.models import Base, Project, ProjectScoped
from resolvate.project_routes import register_project_routes
from resolvate.projects import ProjectService, runtime_settings
from resolvate.services import TicketService

logger = logging.getLogger(__name__)
UUID_PATTERN = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
CONSOLE_PATH = re.compile(
    rf"^/console/projects/({UUID_PATTERN})/((?:tickets|media|retry)(?:/.*)?|replies)$"
)
API_PATH = re.compile(
    rf"^/projects/({UUID_PATTERN})(/(?:api/v1(?:/.*)?|health|ready|metrics|docs|openapi\.json))$"
)


async def validate_project_database(database: Database) -> None:
    tables = [
        mapper.local_table.name
        for mapper in Base.registry.mappers
        if issubclass(mapper.class_, ProjectScoped) and isinstance(mapper.local_table, Table)
    ]
    async with database.session() as session:
        unsafe = await session.scalar(
            text(
                "SELECT rolsuper OR rolbypassrls "
                "OR has_schema_privilege(current_user, 'public', 'CREATE') "
                "FROM pg_roles WHERE rolname = current_user"
            )
        )
        if unsafe:
            raise RuntimeError(
                "Runtime PostgreSQL role must not have SUPERUSER, BYPASSRLS or schema CREATE"
            )
        protected = await session.scalar(
            text(
                "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE n.nspname = 'public' AND c.relname = ANY(CAST(:tables AS text[])) "
                "AND c.relrowsecurity AND c.relforcerowsecurity "
                "AND NOT pg_has_role(current_user, c.relowner, 'USAGE')"
            ),
            {"tables": tables},
        )
        if protected != len(tables):
            raise RuntimeError("Project tables require FORCE RLS and a separate runtime role")


@dataclass
class ProjectRuntime:
    revision: int
    stop: asyncio.Event
    task: asyncio.Task[None]
    app: FastAPI | None = None


class ProjectRouter:
    def __init__(self, application: FastAPI, manager: ProjectManager) -> None:
        self.application, self.manager = application, manager

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        console = CONSOLE_PATH.fullmatch(path)
        api = API_PATH.fullmatch(path)
        match = console or api
        if scope["type"] != "http" or match is None:
            await self.application(scope, receive, send)
            return
        project_id = match[1]
        async with self.manager.database.session() as session:
            project = await session.get(Project, project_id)
        runtime = self.manager.runtimes.get(project_id)
        if project is None or not project.active:
            await JSONResponse({"detail": "Проект недоступен."}, status_code=404)(
                scope, receive, send
            )
            return
        if runtime is None or runtime.app is None or runtime.revision != project.revision:
            await JSONResponse({"detail": "Проект запускается. Повторите позже."}, status_code=503)(
                scope, receive, send
            )
            return
        internal_path = f"/console/{match[2]}" if console else match[2]
        # A fresh scope prevents path-based token realms from seeing a project prefix.
        child = {
            **scope,
            "path": internal_path,
            "raw_path": internal_path.encode(),
            "root_path": "",
        }
        await runtime.app(child, receive, send)


class ProjectManager:
    def __init__(self, database: Database, settings: Settings) -> None:
        self.database, self.settings = database, settings
        self.runtimes: dict[str, ProjectRuntime] = {}
        self.retry_after: dict[str, float] = {}
        self.last_progress = time.monotonic()
        self.stopping = asyncio.Event()

    async def _start(self, project: Project, stop: asyncio.Event) -> None:
        from resolvate.__main__ import run_project

        def publish(app: FastAPI) -> None:
            self.runtimes[project.id].app = app

        try:
            settings = runtime_settings(self.settings, project)
            await run_project(settings, self.database.for_project(project.id), publish, stop)
        except Exception:
            # Never put stored project settings or exception payloads in shared logs.
            logger.error(
                "Project runtime stopped",
                extra={"project_id": project.id, "event": "project_failed"},
            )
            self.retry_after[project.id] = time.monotonic() + 30
        finally:
            self.runtimes[project.id].app = None

    async def reconcile(self) -> None:
        async with self.database.session() as session:
            rows = (await session.scalars(select(Project).where(Project.active.is_(True)))).all()
        wanted = {row.id: row for row in rows}
        for project_id, runtime in list(self.runtimes.items()):
            project = wanted.get(project_id)
            if project is None or project.revision != runtime.revision or runtime.task.done():
                runtime.app = None
                runtime.stop.set()
                if not runtime.task.done():
                    continue  # Drain one project without blocking the rest of the installation.
                await runtime.task
                del self.runtimes[project_id]
        for project in rows:
            if project.id not in self.runtimes and time.monotonic() >= self.retry_after.get(
                project.id, 0
            ):
                stop = asyncio.Event()
                task = asyncio.create_task(self._start(project, stop), name=f"project:{project.id}")
                self.runtimes[project.id] = ProjectRuntime(project.revision, stop, task)
        self.last_progress = time.monotonic()

    async def run(self) -> None:
        try:
            while not self.stopping.is_set():
                await self.reconcile()
                try:
                    await asyncio.wait_for(self.stopping.wait(), 3)
                except TimeoutError:
                    pass
        finally:
            for runtime in self.runtimes.values():
                runtime.app = None
                runtime.stop.set()
            await asyncio.gather(
                *(runtime.task for runtime in self.runtimes.values()), return_exceptions=True
            )


def create_installation(database: Database, settings: Settings, manager: ProjectManager) -> FastAPI:
    root = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    console = create_console(
        database,
        TicketService(database),
        settings,
        LocalMediaStorage(settings.data_dir),
        lambda request: client_key_from_request(request, settings.api_trusted_proxy_ips),
    )
    register_project_routes(console, console.state.auth, ProjectService(database, settings))
    root.mount("/console", console)

    @root.get("/health/live")
    async def live() -> dict[str, bool]:
        return {"ok": True}

    # Wrap the router, retaining a FastAPI object for the existing server lifecycle.
    application = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    application.mount("/", ProjectRouter(root, manager))
    return application


async def run() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    if not settings.console_origin:
        raise RuntimeError("CONSOLE_ORIGIN is required for installation management")
    assert settings.migration_database_url is not None
    if settings.migrations_at_startup:
        await upgrade_database(settings.migration_database_url)
    database = Database(settings.database_url)
    try:
        await validate_project_database(database)
        manager = ProjectManager(database, settings)
        server = ApiServer(create_installation(database, settings, manager), settings)
        manager_task = asyncio.create_task(manager.run())
        heartbeat = Heartbeat(
            settings.data_dir / "heartbeat",
            progress_probe=lambda: (
                not manager_task.done() and time.monotonic() - manager.last_progress < 30
            ),
        )
        heartbeat_task = asyncio.create_task(heartbeat.run())
        try:
            api_task = server.start()
            done, _ = await asyncio.wait(
                {api_task, manager_task}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in done:
                await task
        finally:
            server.request_stop()
            await server.wait()
            manager.stopping.set()
            heartbeat.stop()
            await asyncio.gather(manager_task, heartbeat_task)
    finally:
        await database.dispose()
