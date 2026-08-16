from __future__ import annotations

from typing import Any

from sqlalchemy import make_url
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from resolvate.models import Base
from resolvate.runtime_defaults import (
    POSTGRES_MAX_OVERFLOW,
    POSTGRES_POOL_RECYCLE_SECONDS,
    POSTGRES_POOL_SIZE,
    POSTGRES_POOL_TIMEOUT_SECONDS,
)


class Database:
    def __init__(self, database_url: str) -> None:
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
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    async def create_schema_for_tests(self) -> None:
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    async def dispose(self) -> None:
        await self.engine.dispose()

    def session(self) -> AsyncSession:
        return self.sessions()
