from __future__ import annotations

from io import StringIO

from alembic import command
from alembic.script import ScriptDirectory

import resolvate.web_models  # noqa: F401
from resolvate.migrations import build_alembic_config
from resolvate.models import Base

CHECK_DATABASE_URL = "postgresql+psycopg://migration-check@localhost/resolvate"


def check_migrations() -> None:
    """Compile PostgreSQL DDL offline and ensure it covers the current ORM schema."""

    output = StringIO()
    config = build_alembic_config(CHECK_DATABASE_URL)
    config.output_buffer = output
    script = ScriptDirectory.from_config(config)
    heads = script.get_heads()
    revisions = list(script.walk_revisions())
    if len(heads) != 1 or not revisions or script.get_bases() != ["0001_postgresql_initial"]:
        raise RuntimeError("Resolvate must have one migration head above its PostgreSQL baseline")

    command.upgrade(config, "head", sql=True)
    ddl = output.getvalue().casefold()
    expected_tables = set(Base.metadata.tables)
    missing_tables = {
        table_name
        for table_name in expected_tables
        if f"create table {table_name.casefold()}" not in ddl
    }
    if missing_tables:
        names = ", ".join(sorted(missing_tables))
        raise RuntimeError(f"Alembic schema is missing ORM tables: {names}")

    expected_indexes = {
        index.name
        for table in Base.metadata.tables.values()
        for index in table.indexes
        if index.name is not None
    }
    missing_indexes = {
        index_name for index_name in expected_indexes if f"index {index_name.casefold()}" not in ddl
    }
    if missing_indexes:
        names = ", ".join(sorted(missing_indexes))
        raise RuntimeError(f"Alembic schema is missing ORM indexes: {names}")


if __name__ == "__main__":
    check_migrations()
