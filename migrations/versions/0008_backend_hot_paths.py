"""Indexed project references and project-local conversation/statistics scans."""

import sqlalchemy as sa
from alembic import op

from resolvate.project_isolation import install_project_isolation

revision = "0008_backend_hot_paths"
down_revision = "0007_ticket_folders"
branch_labels = None
depends_on = None


def upgrade() -> None:
    install_project_isolation(op.get_bind())
    for name, predicate in (
        ("ix_tickets_active_page", "status <> 'closed'"),
        ("ix_tickets_archive_page", "status = 'closed'"),
    ):
        op.create_index(
            name,
            "tickets",
            ["project_id", sa.text("last_activity_at DESC"), sa.text("id DESC")],
            postgresql_where=sa.text(predicate),
        )
    op.create_index(
        "ix_ticket_messages_project_time",
        "ticket_messages",
        ["project_id", "created_at"],
        postgresql_where=sa.text("suppressed IS false"),
    )


def downgrade() -> None:
    op.drop_index("ix_ticket_messages_project_time", table_name="ticket_messages")
    op.drop_index("ix_tickets_archive_page", table_name="tickets")
    op.drop_index("ix_tickets_active_page", table_name="tickets")
    # The optimized reference checks are backward-compatible with the old schema;
    # keep enforcing them on downgrade rather than weakening project isolation.
