from __future__ import annotations

import asyncio
import os
from collections.abc import Mapping
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import make_url

EXPLICIT_DATABASE_URL_ATTRIBUTE = "resolvate_explicit_database_url"


def synchronous_database_url(database_url: str) -> str:
    try:
        parsed_url = make_url(database_url)
    except Exception as error:
        raise ValueError("Migration database URL must be a valid SQLAlchemy URL") from error
    if parsed_url.drivername == "postgresql+asyncpg":
        parsed_url = parsed_url.set(drivername="postgresql+psycopg")
    elif parsed_url.drivername != "postgresql+psycopg":
        raise ValueError("Migration database URL must use postgresql+asyncpg or postgresql+psycopg")
    if not parsed_url.database:
        raise ValueError("Migration database URL must include a PostgreSQL database name")
    return parsed_url.render_as_string(hide_password=False)


def build_alembic_config(database_url: str) -> Config:
    """Build a config whose explicit target cannot be replaced by ambient state."""

    root = Path.cwd()
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    config.attributes[EXPLICIT_DATABASE_URL_ATTRIBUTE] = database_url
    config.attributes["skip_logging_config"] = True
    return config


def resolve_migration_database_url(
    config: Config, environment: Mapping[str, str] | None = None
) -> str:
    """Resolve explicit, ambient and configured migration targets in safe order."""

    runtime_environment = os.environ if environment is None else environment
    explicit_database_url = config.attributes.get(EXPLICIT_DATABASE_URL_ATTRIBUTE)
    if explicit_database_url is not None:
        if not str(explicit_database_url).strip():
            raise ValueError("Explicit migration database URL must not be empty")
        database_url = explicit_database_url
    else:
        database_url = (
            runtime_environment.get("MIGRATION_DATABASE_URL")
            or runtime_environment.get("DATABASE_URL")
            or config.get_main_option("sqlalchemy.url")
        )
    if not database_url:
        raise ValueError("MIGRATION_DATABASE_URL or DATABASE_URL is required")
    return synchronous_database_url(str(database_url))


async def upgrade_database(database_url: str) -> None:
    """Run schema migrations before the bot starts consuming updates."""

    config = build_alembic_config(database_url)
    await asyncio.to_thread(command.upgrade, config, "head")


async def run() -> None:
    database_url = os.getenv("MIGRATION_DATABASE_URL")
    if not database_url:
        raise RuntimeError("MIGRATION_DATABASE_URL is required for the migration service")
    await upgrade_database(database_url)
    print("Database migrations completed")


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
