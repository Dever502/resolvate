from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from postgres_support import disposable_postgres_database

from resolvate.migrations import upgrade_database


@pytest.fixture(autouse=True)
def configured_runtime_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """Give unit-only Settings instances a valid, non-secret PostgreSQL target."""

    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql+asyncpg://resolvate:unit-runtime-password@database/resolvate",
    )


@pytest.fixture
async def postgres_database_url() -> AsyncIterator[str]:
    async for database_url in disposable_postgres_database():
        yield database_url


@pytest.fixture
async def migrated_postgres_database_url(postgres_database_url: str) -> str:
    """Return an isolated PostgreSQL database upgraded to the current schema."""

    await upgrade_database(postgres_database_url)
    return postgres_database_url
