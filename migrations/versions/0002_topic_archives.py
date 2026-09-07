"""Durable topic transcripts and rotation state.

Revision ID: 0002_topic_archives
Revises: 0001_postgresql_initial
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002_topic_archives"
down_revision = "0001_postgresql_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_inbound_updates_payload", "inbound_updates", ["payload"], postgresql_using="gin"
    )
    op.create_table(
        "topic_archives",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "ticket_id",
            sa.String(36),
            sa.ForeignKey("tickets.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("chat_id", sa.BigInteger(), nullable=False),
        sa.Column("topic_id", sa.BigInteger(), nullable=False),
        sa.Column("state", sa.String(24), nullable=False),
        sa.Column("complete", sa.Boolean(), nullable=False),
        sa.Column("message_count", sa.BigInteger(), nullable=False),
        sa.Column("revision", sa.BigInteger(), nullable=False),
        sa.Column("pending_writes", sa.Integer(), nullable=False),
        sa.Column("prepared_revision", sa.BigInteger()),
        sa.Column("prepared_close_cycle", sa.Integer()),
        sa.Column("replacement_topic_id", sa.BigInteger()),
        sa.Column("replacement_token", sa.String(36)),
        sa.Column("setup_message_id", sa.BigInteger()),
        sa.Column("cutover_at", sa.DateTime(timezone=True)),
        sa.Column("mode", sa.String(24)),
        sa.Column("error_code", sa.String(64)),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("chat_id", "topic_id", name="uq_topic_archives_telegram"),
    )
    op.create_index("ix_topic_archives_state_due", "topic_archives", ["state", "next_attempt_at"])
    op.create_index("ix_topic_archives_ticket", "topic_archives", ["ticket_id", "created_at"])
    op.create_index("ix_topic_archives_retention", "topic_archives", ["state", "archived_at"])
    op.create_table(
        "transcript_media",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("file_unique_id", sa.String(255), nullable=False, unique=True),
        sa.Column("file_id", sa.Text(), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("filename", sa.String(255)),
        sa.Column("state", sa.String(24), nullable=False),
        sa.Column("declared_size", sa.BigInteger()),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("storage_path", sa.String(512)),
        sa.Column("sha256", sa.String(64)),
        sa.Column("compressed_at", sa.DateTime(timezone=True)),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_transcript_media_state", "transcript_media", ["state", "created_at"])
    op.create_table(
        "transcript_messages",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "archive_id",
            sa.String(36),
            sa.ForeignKey("topic_archives.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("message_id", sa.BigInteger(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column(
            "media_id", sa.String(36), sa.ForeignKey("transcript_media.id", ondelete="RESTRICT")
        ),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("archive_id", "message_id", name="uq_transcript_message"),
    )
    op.create_index(
        "ix_transcript_messages_media", "transcript_messages", ["media_id", "archive_id"]
    )
    op.create_table(
        "customer_summaries",
        sa.Column(
            "ticket_id",
            sa.String(36),
            sa.ForeignKey("tickets.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("through_archive_id", sa.String(36), nullable=False),
        sa.Column("through_revision", sa.BigInteger(), nullable=False),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "operational_notices",
        sa.Column("key", sa.String(128), primary_key=True),
        sa.Column("severity", sa.String(16), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("next_delivery_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    # A clean installation is reversible; populated archives require an explicit restore plan.
    op.execute("""
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM topic_archives)
            OR EXISTS (SELECT 1 FROM transcript_media)
            OR EXISTS (SELECT 1 FROM customer_summaries) THEN
            RAISE EXCEPTION 'Cannot downgrade populated topic archives; restore a verified backup';
          END IF;
        END $$;
    """)
    op.drop_table("operational_notices")
    op.drop_table("customer_summaries")
    op.drop_table("transcript_messages")
    op.drop_table("transcript_media")
    op.drop_table("topic_archives")
    op.drop_index("ix_inbound_updates_payload", table_name="inbound_updates")
