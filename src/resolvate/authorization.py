from __future__ import annotations

from sqlalchemy import or_, select

from resolvate.config import Settings
from resolvate.database import Database
from resolvate.models import ConsoleAccount, Project, ProjectMember


class AuthorizationService:
    """Application-level admins; Telegram group permissions are not authorization."""

    def __init__(self, settings: Settings, database: Database | None = None) -> None:
        self.settings = settings
        self.database = database

    def is_admin(self, telegram_user_id: int) -> bool:
        return telegram_user_id in self.settings.admin_telegram_ids

    async def can_operate(self, telegram_user_id: int) -> bool:
        if self.database is None or self.database.project_id is None:
            return self.is_admin(telegram_user_id)
        async with self.database.session() as session:
            return (
                await session.scalar(
                    select(ConsoleAccount.id)
                    .join(Project, Project.id == self.database.project_id)
                    .where(
                        ConsoleAccount.telegram_id == telegram_user_id,
                        ConsoleAccount.active.is_(True),
                        Project.active.is_(True),
                        or_(
                            Project.admin_id == ConsoleAccount.id,
                            ConsoleAccount.id.in_(
                                select(ProjectMember.account_id).where(
                                    ProjectMember.project_id == Project.id
                                )
                            ),
                        ),
                    )
                    .limit(1)
                )
                is not None
            )
