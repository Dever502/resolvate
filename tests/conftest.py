from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
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


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def migrated_postgres_template() -> AsyncIterator[str]:
    """Migrate once per worker; no connections or data are shared between tests.

    Migration tests still use the empty postgres_database_url fixture and exercise
    real upgrades, including upgrades from older schemas.
    """
    async for url in disposable_postgres_database():
        await upgrade_database(url)
        yield url


@pytest.fixture
async def migrated_postgres_database_url(
    migrated_postgres_template: str, request: pytest.FixtureRequest
) -> AsyncIterator[str]:
    """Each test gets an independent disposable clone of the migrated schema."""
    async for url in disposable_postgres_database(template_url=migrated_postgres_template):
        if request.module.__name__ != "test_projects":
            from project_support import seed_project

            from resolvate.database import Database

            database = Database(url)
            try:
                await seed_project(database)
            finally:
                await database.dispose()
        yield url
