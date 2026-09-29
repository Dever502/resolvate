from __future__ import annotations

import pytest
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

import resolvate.migrations as migrations_module
from resolvate.migrations import (
    build_alembic_config,
    resolve_migration_database_url,
    synchronous_database_url,
    upgrade_database,
)

HEAD_REVISION = "0006_project_branding"


async def current_revision(database_url: str) -> str:
    engine = create_async_engine(database_url)
    try:
        async with engine.connect() as connection:
            revision = await connection.scalar(text("SELECT version_num FROM alembic_version"))
            assert revision is not None
            return str(revision)
    finally:
        await engine.dispose()


async def test_migration_service_requires_a_dedicated_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("MIGRATION_DATABASE_URL", raising=False)

    with pytest.raises(RuntimeError, match="MIGRATION_DATABASE_URL"):
        await migrations_module.run()


async def test_migration_service_uses_only_migration_database_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = "postgresql+asyncpg://migrator:migration-password-123@postgres/resolvate"
    monkeypatch.setenv("MIGRATION_DATABASE_URL", target)
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql+asyncpg://runtime:runtime-password-123@postgres/resolvate",
    )
    observed: list[str] = []

    async def fake_upgrade(database_url: str) -> None:
        observed.append(database_url)

    monkeypatch.setattr(migrations_module, "upgrade_database", fake_upgrade)

    await migrations_module.run()

    assert observed == [target]


async def test_explicit_upgrade_target_ignores_ambient_database_url(
    postgres_database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql+asyncpg://ambient:ambient-password-123@127.0.0.1/not_the_target",
    )

    await upgrade_database(postgres_database_url)
    await upgrade_database(postgres_database_url)

    assert await current_revision(postgres_database_url) == HEAD_REVISION


def test_async_url_is_converted_without_corrupting_encoded_credentials() -> None:
    assert (
        synchronous_database_url("postgresql+asyncpg://support:p%40ss%25word@postgres:5432/support")
        == "postgresql+psycopg://support:p%40ss%25word@postgres:5432/support"
    )


def test_synchronous_postgres_url_is_preserved() -> None:
    database_url = "postgresql+psycopg://support:password@postgres:5432/support"

    assert synchronous_database_url(database_url) == database_url


@pytest.mark.parametrize(
    "database_url",
    (
        "mysql+pymysql://support:password@database/support",
        "not-a-database-url",
        "postgresql+asyncpg://support:password@database",
    ),
)
def test_migration_url_rejects_unsupported_or_incomplete_targets(database_url: str) -> None:
    with pytest.raises(ValueError, match="Migration database URL"):
        synchronous_database_url(database_url)


def test_migration_url_resolution_has_explicit_safe_precedence() -> None:
    config = Config()
    config.set_main_option(
        "sqlalchemy.url",
        "postgresql+asyncpg://configured:configured-password@database/configured",
    )
    environment = {
        "DATABASE_URL": ("postgresql+asyncpg://runtime:runtime-password@database/runtime"),
        "MIGRATION_DATABASE_URL": (
            "postgresql+asyncpg://migrator:migrator-password@database/migration"
        ),
    }

    assert resolve_migration_database_url(config, environment) == (
        "postgresql+psycopg://migrator:migrator-password@database/migration"
    )


def test_explicit_migration_target_has_priority_over_environment() -> None:
    config = build_alembic_config(
        "postgresql+asyncpg://explicit:explicit-password@database/explicit"
    )

    assert (
        resolve_migration_database_url(
            config,
            {
                "MIGRATION_DATABASE_URL": (
                    "postgresql+asyncpg://ambient:ambient-password@database/ambient"
                )
            },
        )
        == "postgresql+psycopg://explicit:explicit-password@database/explicit"
    )


def test_empty_explicit_migration_target_is_rejected() -> None:
    config = build_alembic_config("")

    with pytest.raises(ValueError, match="must not be empty"):
        resolve_migration_database_url(config, {})


def test_missing_migration_target_is_rejected() -> None:
    config = Config()

    with pytest.raises(ValueError, match="MIGRATION_DATABASE_URL or DATABASE_URL"):
        resolve_migration_database_url(config, {})
