"""One project-local quick response catalog with explicit groups and publication revisions."""

import sqlalchemy as sa
from alembic import op

from resolvate.project_isolation import install_project_isolation

revision = "0010_quick_response_catalog"
down_revision = "0009_console_read_paths"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "quick_response_groups",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(36),
            sa.ForeignKey("projects.id", ondelete="RESTRICT"),
            nullable=False,
            server_default=sa.text("nullif(current_setting('resolvate.project_id', true), '')"),
        ),
        sa.Column("name", sa.String(48), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        sa.UniqueConstraint("project_id", "name", name="uq_quick_response_groups_name"),
    )
    op.create_index("ix_quick_response_groups_project_id", "quick_response_groups", ["project_id"])
    op.add_column("quick_responses", sa.Column("group_id", sa.String(36)))
    op.add_column(
        "quick_responses", sa.Column("revision", sa.Integer(), nullable=False, server_default="0")
    )
    op.add_column("quick_responses", sa.Column("published_revision", sa.Integer()))
    op.alter_column("quick_responses", "source_chat_id", nullable=True)
    op.alter_column("quick_responses", "source_message_id", nullable=True)
    op.create_foreign_key(
        "fk_quick_response_group",
        "quick_responses",
        "quick_response_groups",
        ["group_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_index(
        "ix_quick_responses_group", "quick_responses", ["project_id", "group_id", "state", "id"]
    )
    # Explicit context works for the migration role with FORCE RLS as well as a superuser.
    # Preserve legacy texts verbatim: hashtags are not guessed to be categories or deleted.
    op.execute("""
        DO $$ DECLARE p record; g text; BEGIN
          FOR p IN SELECT id FROM projects LOOP
            PERFORM set_config('resolvate.project_id', p.id, true);
            IF EXISTS (SELECT 1 FROM quick_responses WHERE project_id = p.id) THEN
              g := gen_random_uuid()::text;
              INSERT INTO quick_response_groups (id, project_id, name) VALUES (g, p.id, 'общее');
              UPDATE quick_responses SET group_id = g, publication_format_version = 0
                WHERE project_id = p.id;
            END IF;
          END LOOP;
          PERFORM set_config('resolvate.project_id', '', true);
        END $$;
    """)
    install_project_isolation(op.get_bind())


def downgrade() -> None:
    # Web-created rows have no Telegram source; reverting would discard the new catalog.
    raise RuntimeError("Restore a backup made before the quick response catalog upgrade")
