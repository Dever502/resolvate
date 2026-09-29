from __future__ import annotations

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
        self.project_id = str(uuid.UUID(project_id)) if project_id else None
        self._owns_engine = True
        self._configure_sessions()

    def _configure_sessions(self) -> None:
        self.sessions = async_sessionmaker(
            self.engine,
            expire_on_commit=False,
            sync_session_class=ScopedSession,
            info={"project_id": self.project_id},
        )

    def for_project(self, project_id: str) -> Database:
        scoped = object.__new__(Database)
        scoped.engine = self.engine
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
