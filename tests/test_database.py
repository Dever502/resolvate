from __future__ import annotations

import pytest
from sqlalchemy import text

from resolvate.database import Database
from resolvate.runtime_defaults import POSTGRES_POOL_SIZE


async def test_postgres_connection_uses_expected_database_and_safe_engine_options(
    postgres_database_url: str,
) -> None:
    database = Database(postgres_database_url)
    try:
        assert database.engine.sync_engine.hide_parameters is True
        assert database.engine.pool.size() == POSTGRES_POOL_SIZE
        async with database.engine.connect() as connection:
            name = await connection.scalar(text("SELECT current_database()"))
    finally:
        await database.dispose()

    assert isinstance(name, str)
    assert name.startswith("sbtest_")


@pytest.mark.parametrize(
    "database_url",
    (
        "mysql+aiomysql://user:password@database.invalid/resolvate",
        "postgresql+psycopg://user:password@database.invalid/resolvate",
        "not-a-database-url",
    ),
)
def test_database_rejects_unsupported_or_malformed_urls(database_url: str) -> None:
    with pytest.raises(ValueError, match="DATABASE_URL"):
        Database(database_url)


def test_database_requires_explicit_database_name() -> None:
    with pytest.raises(ValueError, match="database name"):
        Database("postgresql+asyncpg://user:password@database.invalid")


def test_postgres_engine_uses_bounded_runtime_pool_without_connecting() -> None:
    database = Database("postgresql+asyncpg://user:password@database.invalid/resolvate")
    try:
        assert database.engine.sync_engine.hide_parameters is True
        assert database.engine.pool.size() == POSTGRES_POOL_SIZE
    finally:
        # Engine construction does not open a connection; this test remains synchronous.
        database.engine.sync_engine.dispose(close=False)
