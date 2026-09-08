"""Operator accounts, revocable sessions and durable console commands."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004_operator_console"
down_revision = "0003_notice_delivery"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ticket_messages", sa.Column("archive_id", sa.String(36)))
    op.create_foreign_key(
        "fk_ticket_message_archive",
        "ticket_messages",
        "topic_archives",
        ["archive_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_ticket_messages_archive_id", "ticket_messages", ["archive_id"])
    op.execute("""
        CREATE FUNCTION bind_ticket_message_archive() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.archive_id IS NULL THEN
            SELECT a.id INTO NEW.archive_id FROM topic_archives a
            JOIN tickets t ON t.id = a.ticket_id AND t.topic_id = a.topic_id
            WHERE t.id = NEW.ticket_id LIMIT 1;
          END IF;
          RETURN NEW;
        END $$
    """)
    op.execute("""CREATE TRIGGER ticket_message_archive BEFORE INSERT ON ticket_messages
                  FOR EACH ROW EXECUTE FUNCTION bind_ticket_message_archive()""")
    op.drop_constraint("uq_media_asset_storage_path", "media_assets", type_="unique")
    op.create_index("ix_media_assets_storage_path", "media_assets", ["storage_path"])
    op.create_table(
        "console_accounts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("login", sa.String(64), nullable=False, unique=True),
        sa.Column("display_name", sa.String(100), nullable=False),
        sa.Column("password_hash", sa.String(256), nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "console_sessions",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column(
            "account_id",
            sa.String(36),
            sa.ForeignKey("console_accounts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_console_sessions_account_id", "console_sessions", ["account_id"])
    op.create_index("ix_console_sessions_expires_at", "console_sessions", ["expires_at"])
    op.create_table(
        "console_reads",
        sa.Column(
            "account_id",
            sa.String(36),
            sa.ForeignKey("console_accounts.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "ticket_id",
            sa.String(36),
            sa.ForeignKey("tickets.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("through_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "console_sends",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "account_id", sa.String(36), sa.ForeignKey("console_accounts.id"), nullable=False
        ),
        sa.Column(
            "message_id",
            sa.String(36),
            sa.ForeignKey("ticket_messages.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("deliveries", postgresql.JSONB(), nullable=False),
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER ticket_message_archive ON ticket_messages")
    op.execute("DROP FUNCTION bind_ticket_message_archive()")
    op.drop_index("ix_ticket_messages_archive_id", table_name="ticket_messages")
    op.drop_constraint("fk_ticket_message_archive", "ticket_messages", type_="foreignkey")
    op.drop_column("ticket_messages", "archive_id")
    # Shared files cannot be made unique without copying data; require an explicit rollback plan.
    connection = op.get_bind()
    if connection.execute(
        sa.text("SELECT 1 FROM media_assets GROUP BY storage_path HAVING count(*) > 1 LIMIT 1")
    ).first():
        raise RuntimeError("Shared media exists; restore a pre-upgrade backup to downgrade")
    op.drop_index("ix_media_assets_storage_path", table_name="media_assets")
    op.create_unique_constraint("uq_media_asset_storage_path", "media_assets", ["storage_path"])
    for table in ("console_sends", "console_reads", "console_sessions", "console_accounts"):
        op.drop_table(table)
