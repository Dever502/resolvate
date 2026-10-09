"""Cover project-local unread counts without fetching message bodies."""

import sqlalchemy as sa
from alembic import op

revision = "0009_console_read_paths"
down_revision = "0008_backend_hot_paths"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_ticket_messages_unread",
        "ticket_messages",
        ["project_id", "ticket_id", "created_at"],
        postgresql_where=sa.text("direction = 'user_to_operator' AND suppressed IS false"),
    )


def downgrade() -> None:
    op.drop_index("ix_ticket_messages_unread", table_name="ticket_messages")
