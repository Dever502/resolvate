"""Shared project folders; deleting a folder never deletes a conversation."""

import sqlalchemy as sa
from alembic import op

from resolvate.project_isolation import install_project_isolation

revision = "0007_ticket_folders"
down_revision = "0006_project_branding"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ticket_folders",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(36),
            sa.ForeignKey("projects.id", ondelete="RESTRICT"),
            nullable=False,
            server_default=sa.text("nullif(current_setting('resolvate.project_id', true), '')"),
        ),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("name_key", sa.String(240), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        sa.UniqueConstraint("project_id", "name_key", name="uq_ticket_folders_project_name"),
    )
    op.create_index("ix_ticket_folders_project_id", "ticket_folders", ["project_id"])
    op.add_column("tickets", sa.Column("folder_id", sa.String(36), nullable=True))
    op.add_column(
        "tickets", sa.Column("folder_revision", sa.Integer(), nullable=False, server_default="0")
    )
    op.create_foreign_key(
        "fk_tickets_folder", "tickets", "ticket_folders", ["folder_id"], ["id"], ondelete="SET NULL"
    )
    op.create_index("ix_tickets_project_folder", "tickets", ["project_id", "folder_id"])
    install_project_isolation(op.get_bind())


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS project_ref_folder_id ON tickets")
    op.drop_index("ix_tickets_project_folder", table_name="tickets")
    op.drop_constraint("fk_tickets_folder", "tickets", type_="foreignkey")
    op.drop_column("tickets", "folder_id")
    op.drop_column("tickets", "folder_revision")
    op.drop_table("ticket_folders")
