"""Optional project logo; preserves existing projects and conversations."""

import sqlalchemy as sa
from alembic import op

revision = "0006_project_branding"
down_revision = "0005_projects"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("logo_sha256", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("projects", "logo_sha256")
