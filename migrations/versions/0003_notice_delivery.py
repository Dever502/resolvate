"""Persist General-topic notification delivery state."""

import sqlalchemy as sa
from alembic import op

revision = "0003_notice_delivery"
down_revision = "0002_topic_archives"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("operational_notices", sa.Column("delivered_active", sa.Boolean()))
    op.add_column("operational_notices", sa.Column("delivered_at", sa.DateTime(timezone=True)))


def downgrade() -> None:
    op.drop_column("operational_notices", "delivered_at")
    op.drop_column("operational_notices", "delivered_active")
