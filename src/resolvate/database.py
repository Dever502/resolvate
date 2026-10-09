from __future__ import annotations

import asyncio
import uuid
from typing import Any

from sqlalchemy import event, inspect, make_url, text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import ORMExecuteState, Session, with_loader_criteria

from resolvate.console_events import VISIBLE_TABLES, ConsoleEvents
from resolvate.models import Base, ProjectScoped
from resolvate.runtime_defaults import (
    POSTGRES_MAX_OVERFLOW,
    POSTGRES_POOL_RECYCLE_SECONDS,
    POSTGRES_POOL_SIZE,
    POSTGRES_POOL_TIMEOUT_SECONDS,
)


class ScopedSession(Session):
    def get(self, entity: Any, ident: Any, **kw: Any) -> Any:
        keys = [column.key for column in inspect(entity).primary_key]
        if "project_id" in keys:
            if isinstance(ident, dict):
                ident = {**ident, "project_id": self.info.get("project_id")}
            else:
                values = list(ident) if isinstance(ident, (list, tuple)) else [ident]
                if len(values) == len(keys) - 1:
                    values.insert(keys.index("project_id"), self.info.get("project_id"))
                ident = tuple(values)
        return super().get(entity, ident, **kw)


@event.listens_for(ScopedSession, "after_begin")
def _transaction_scope(session: Session, transaction: Any, connection: Any) -> None:
    connection.execute(
        text("SELECT set_config('resolvate.project_id', :project, true)"),
        {"project": session.info.get("project_id") or ""},
    )


@event.listens_for(ScopedSession, "do_orm_execute")
def _query_scope(state: ORMExecuteState) -> None:
    project = state.session.info.get("project_id") or ""
    state.statement = state.statement.options(
        with_loader_criteria(
            ProjectScoped, lambda row: row.project_id == project, include_aliases=True
        )
    )


@event.listens_for(ScopedSession, "before_flush")
def _write_scope(session: Session, context: Any, instances: Any) -> None:
    project = session.info.get("project_id")
    for row in session.new | session.dirty | session.deleted:
        if isinstance(row, ProjectScoped):
            if not project or row.project_id not in {None, project}:
                raise ValueError("A matching project context is required")
            row.project_id = project


@event.listens_for(ScopedSession, "after_flush")
def _console_flushed(session: Session, context: Any) -> None:
    if any(
        getattr(row, "__tablename__", "") == "delivery_outbox"
        for row in session.new | session.dirty
    ):
        session.info["delivery_changed"] = True
    if any(
        getattr(row, "__tablename__", "") in VISIBLE_TABLES
        or (
            getattr(row, "__tablename__", "") == "delivery_outbox"
            and inspect(row).attrs.status.history.has_changes()
            and row.status != "processing"
        )
        for row in session.new | session.dirty | session.deleted
    ):
        session.info["console_changed"] = True


@event.listens_for(ScopedSession, "do_orm_execute", retval=True)
def _console_executed(state: ORMExecuteState) -> Any:
    result = state.invoke_statement()
    if state.is_insert or state.is_update or state.is_delete:
        table = getattr(getattr(state.statement, "table", None), "name", "")
        visible = table in VISIBLE_TABLES or state.execution_options.get("console_change", False)
        if visible and getattr(result, "rowcount", None) != 0:
            state.session.info["console_changed"] = True
        if table == "delivery_outbox" and (
            state.is_insert or (getattr(result, "rowcount", 0) or 0) > 0
        ):
            state.session.info["delivery_changed"] = True
    return result


@event.listens_for(ScopedSession, "after_commit")
def _console_committed(session: Session) -> None:
    if session.in_nested_transaction():
        return
    changed = session.info.pop("console_changed", False)
    project = session.info.get("project_id")
    events = session.info.get("console_events")
    if changed and project and events is not None:
        events.publish(project)
    delivery_changed = session.info.pop("delivery_changed", False)
    delivery_ready = session.info.get("delivery_ready")
    if delivery_changed and project and delivery_ready is not None:
        delivery_ready.set()


@event.listens_for(ScopedSession, "after_soft_rollback")
def _console_rolled_back(session: Session, previous: Any) -> None:
    if previous.parent is None:
        session.info.pop("console_changed", None)
        session.info.pop("delivery_changed", None)


class Database:
    def __init__(self, database_url: str, *, project_id: str | None = None) -> None:
        try:
            parsed_url = make_url(database_url)
        except Exception as error:
            raise ValueError("DATABASE_URL must be a valid SQLAlchemy URL") from error
        if parsed_url.drivername != "postgresql+asyncpg":
            raise ValueError("DATABASE_URL must use the postgresql+asyncpg driver")
        if not parsed_url.database:
            raise ValueError("DATABASE_URL must include a PostgreSQL database name")

        engine_options: dict[str, Any] = {
            "pool_pre_ping": True,
            "hide_parameters": True,
            # Bound the pool below the PostgreSQL connection budget while allowing
            # enough overlap for the API and the internal workers in one application instance.
            "pool_size": POSTGRES_POOL_SIZE,
            "max_overflow": POSTGRES_MAX_OVERFLOW,
            "pool_timeout": POSTGRES_POOL_TIMEOUT_SECONDS,
            "pool_recycle": POSTGRES_POOL_RECYCLE_SECONDS,
            "pool_use_lifo": True,
        }
        self.engine: AsyncEngine = create_async_engine(database_url, **engine_options)
        self.console_events = ConsoleEvents()
        self.project_id = str(uuid.UUID(project_id)) if project_id else None
        self._owns_engine = True
        self._configure_sessions()

    def _configure_sessions(self) -> None:
        # Best-effort wakeup for this project runtime, never a replacement for
        # durable claiming/polling. Other processes/connections still use polling.
        self.delivery_ready = asyncio.Event()
        self.sessions = async_sessionmaker(
            self.engine,
            expire_on_commit=False,
            sync_session_class=ScopedSession,
            info={
                "project_id": self.project_id,
                "console_events": self.console_events,
                "delivery_ready": self.delivery_ready,
            },
        )

    def for_project(self, project_id: str) -> Database:
        scoped = object.__new__(Database)
        scoped.engine = self.engine
        scoped.console_events = self.console_events
        scoped.project_id = str(uuid.UUID(project_id))
        scoped._owns_engine = False
        scoped._configure_sessions()
        return scoped

    async def create_schema_for_tests(self) -> None:
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
            from resolvate.project_isolation import install_project_isolation

            await connection.run_sync(install_project_isolation)

    async def dispose(self) -> None:
        if self._owns_engine:
            await self.engine.dispose()

    def session(self) -> AsyncSession:
        return self.sessions()
