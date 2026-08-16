from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

import resolvate.web_models  # noqa: F401
from resolvate.migrations import resolve_migration_database_url
from resolvate.models import Base

config = context.config

if config.config_file_name is not None and not config.attributes.get("skip_logging_config", False):
    fileConfig(config.config_file_name)


database_url = resolve_migration_database_url(config)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine_configuration = config.get_section(config.config_ini_section, {}) or {}
    engine_configuration["sqlalchemy.url"] = database_url
    connectable = engine_from_config(
        engine_configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            compare_server_default=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
