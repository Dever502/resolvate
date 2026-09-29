"""Isolated projects; this release requires a fresh installation."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

from resolvate.project_isolation import install_project_isolation

revision = "0005_projects"
down_revision = "0004_operator_console"
branch_labels = None
depends_on = None

SCOPED = (
    "users",
    "user_identities",
    "tickets",
    "ticket_messages",
    "delivery_outbox",
    "notification_outbox",
    "inbound_updates",
    "reconciliation_outbox",
    "operator_actions",
    "blocklist",
    "support_blocks",
    "quick_responses",
    "topic_archives",
    "transcript_media",
    "transcript_messages",
    "customer_summaries",
    "operational_notices",
    "console_reads",
    "console_sends",
    "media_assets",
    "ticket_lifecycle_events",
    "system_settings",
    "operator_dashboard_state",
)
COMPOSITE = {
    "inbound_updates",
    "blocklist",
    "operational_notices",
    "console_sends",
    "system_settings",
    "operator_dashboard_state",
}
UNIQUES = {
    "user_identities": [("uq_identity_provider_external", ["provider", "external_id"])],
    "tickets": [("uq_tickets_project_topic", ["topic_id"])],
    "ticket_messages": [
        ("uq_ticket_message_source", ["direction", "source_chat_id", "source_message_id"])
    ],
    "delivery_outbox": [("uq_delivery_project_key", ["idempotency_key"])],
    "notification_outbox": [("uq_notification_project_key", ["idempotency_key"])],
    "reconciliation_outbox": [("uq_reconciliation_project_key", ["idempotency_key"])],
    "operator_actions": [("uq_action_project_key", ["idempotency_key"])],
    "quick_responses": [
        ("uq_quick_responses_source", ["source_chat_id", "source_message_id"]),
        ("uq_quick_responses_published_message", ["published_message_id"]),
    ],
    "transcript_media": [("uq_transcript_project_file", ["file_unique_id"])],
}


def upgrade() -> None:
    connection = op.get_bind()
    for table in (*SCOPED, "console_accounts"):
        op.execute(f"""DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM "{table}" LIMIT 1) THEN
              RAISE EXCEPTION 'Project isolation requires a fresh database';
            END IF;
        END $$""")
    op.add_column("console_accounts", sa.Column("telegram_id", sa.BigInteger()))
    op.create_unique_constraint(
        "uq_console_accounts_telegram_id", "console_accounts", ["telegram_id"]
    )
    op.create_index(
        "uq_installation_admin",
        "console_accounts",
        ["role"],
        unique=True,
        postgresql_where=sa.text("role = 'admin'"),
    )
    op.create_table(
        "projects",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column(
            "admin_id",
            sa.String(36),
            sa.ForeignKey("console_accounts.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("settings", JSONB(), nullable=False),
        sa.Column("bot_id", sa.BigInteger(), unique=True),
        sa.Column("group_id", sa.BigInteger(), unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "project_members",
        sa.Column(
            "project_id",
            sa.String(36),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "account_id",
            sa.String(36),
            sa.ForeignKey("console_accounts.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "access_audit",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("actor_id", sa.String(36), sa.ForeignKey("console_accounts.id")),
        sa.Column("project_id", sa.String(36), sa.ForeignKey("projects.id")),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("target_id", sa.String(36)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "project_credentials",
        sa.Column("fingerprint", sa.String(64), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(36),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
    )
    op.create_index("ix_project_credentials_project_id", "project_credentials", ["project_id"])
    for table in SCOPED:
        op.add_column(
            table,
            sa.Column(
                "project_id",
                sa.String(36),
                nullable=False,
                server_default=sa.text("nullif(current_setting('resolvate.project_id', true), '')"),
            ),
        )
        op.create_foreign_key(
            f"fk_{table}_project", table, "projects", ["project_id"], ["id"], ondelete="RESTRICT"
        )
        if table in COMPOSITE:
            key = {
                "inbound_updates": "telegram_update_id",
                "blocklist": "telegram_user_id",
                "operational_notices": "key",
                "system_settings": "key",
            }.get(table, "id")
            op.drop_constraint(f"{table}_pkey", table, type_="primary")
            op.create_primary_key(f"{table}_pkey", table, [key, "project_id"])
        else:
            op.create_index(f"ix_{table}_project_id", table, ["project_id"])
        for new_name, columns in UNIQUES.get(table, []):
            old_name = (
                new_name
                if new_name
                in {
                    "uq_identity_provider_external",
                    "uq_ticket_message_source",
                    "uq_quick_responses_source",
                    "uq_quick_responses_published_message",
                }
                else f"{table}_{columns[0]}_key"
            )
            op.drop_constraint(old_name, table, type_="unique")
            op.create_unique_constraint(new_name, table, ["project_id", *columns])
    install_project_isolation(connection)


def downgrade() -> None:
    raise RuntimeError("Restore a backup to revert project isolation; automatic merging is unsafe")
