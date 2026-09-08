from __future__ import annotations

import asyncio

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import create_async_engine

import resolvate.web_models  # noqa: F401
from resolvate.migrations import build_alembic_config, upgrade_database
from resolvate.models import Base

pytestmark = pytest.mark.postgres

HEAD_REVISION = "0004_operator_console"
EXPECTED_QUERY_INDEXES = {
    "ix_tickets_status_updated",
    "ix_tickets_status_last_activity",
    "ix_ticket_messages_ticket_created",
    "ix_ticket_messages_sensitive_created",
    "ix_delivery_outbox_claim",
    "ix_delivery_outbox_stale",
    "ix_delivery_outbox_ticket_direction_status",
    "ix_delivery_outbox_ticket_status_created",
    "ix_notification_outbox_claim",
    "ix_notification_outbox_stale",
    "ix_notification_outbox_ticket_status_created",
    "ix_inbound_updates_ordering",
    "ix_reconciliation_ticket_status_created",
    "ix_operator_actions_ticket_action_result",
    "ix_operator_actions_result_created",
    "uq_operator_actions_unresolved_ticket",
    "ix_quick_responses_state_deadline",
}


async def _current_revision(database_url: str) -> str:
    engine = create_async_engine(database_url)
    try:
        async with engine.connect() as connection:
            revision = await connection.scalar(text("SELECT version_num FROM alembic_version"))
            assert revision is not None
            return str(revision)
    finally:
        await engine.dispose()


async def _metadata_differences(database_url: str) -> list[object]:
    engine = create_async_engine(database_url)
    try:
        async with engine.connect() as connection:
            return await connection.run_sync(
                lambda sync_connection: compare_metadata(
                    MigrationContext.configure(sync_connection),
                    Base.metadata,
                )
            )
    finally:
        await engine.dispose()


def test_repository_has_one_head_above_postgresql_baseline() -> None:
    scripts = ScriptDirectory.from_config(
        build_alembic_config("postgresql+asyncpg://user:password@database/resolvate")
    )

    assert scripts.get_heads() == [HEAD_REVISION]
    assert [revision.revision for revision in scripts.walk_revisions()] == [
        HEAD_REVISION,
        "0003_notice_delivery",
        "0002_topic_archives",
        "0001_postgresql_initial",
    ]


async def test_fresh_upgrade_exactly_matches_orm_metadata(
    postgres_database_url: str,
) -> None:
    await upgrade_database(postgres_database_url)

    assert await _current_revision(postgres_database_url) == HEAD_REVISION
    assert await _metadata_differences(postgres_database_url) == []


async def test_baseline_uses_postgresql_native_types_and_required_indexes(
    postgres_database_url: str,
) -> None:
    await upgrade_database(postgres_database_url)
    engine = create_async_engine(postgres_database_url)
    try:
        async with engine.connect() as connection:
            tables, indexes, json_columns, unresolved_index = await connection.run_sync(
                _inspect_postgresql_schema
            )
    finally:
        await engine.dispose()

    assert tables == set(Base.metadata.tables)
    assert EXPECTED_QUERY_INDEXES <= indexes
    assert {
        ("delivery_outbox", "payload"),
        ("notification_outbox", "payload"),
        ("quick_responses", "tags"),
        ("ticket_messages", "media"),
    } <= json_columns
    assert "WHERE" in unresolved_index.upper()
    assert "result" in unresolved_index
    assert "remnawave_" in unresolved_index


def _inspect_postgresql_schema(
    connection: sa.Connection,
) -> tuple[set[str], set[str], set[tuple[str, str]], str]:
    inspector = sa.inspect(connection)
    tables = set(inspector.get_table_names()) - {"alembic_version"}
    indexes = {
        str(index["name"])
        for table in tables
        for index in inspector.get_indexes(table)
        if index.get("name")
    }
    json_columns = {
        (table, str(column["name"]))
        for table in tables
        for column in inspector.get_columns(table)
        if isinstance(column["type"], JSONB)
    }
    unresolved_index = connection.scalar(
        text(
            "SELECT indexdef FROM pg_indexes "
            "WHERE schemaname = current_schema() "
            "AND indexname = 'uq_operator_actions_unresolved_ticket'"
        )
    )
    assert isinstance(unresolved_index, str)
    return tables, indexes, json_columns, unresolved_index


async def test_baseline_supports_full_downgrade_and_clean_reupgrade(
    postgres_database_url: str,
) -> None:
    config = build_alembic_config(postgres_database_url)
    await upgrade_database(postgres_database_url)
    await asyncio.to_thread(command.downgrade, config, "base")

    engine = create_async_engine(postgres_database_url)
    try:
        async with engine.connect() as connection:
            tables_after_downgrade = await connection.run_sync(
                lambda sync_connection: set(sa.inspect(sync_connection).get_table_names())
            )
    finally:
        await engine.dispose()

    assert tables_after_downgrade <= {"alembic_version"}

    await upgrade_database(postgres_database_url)
    assert await _current_revision(postgres_database_url) == HEAD_REVISION
    assert await _metadata_differences(postgres_database_url) == []
