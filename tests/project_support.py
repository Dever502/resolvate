"""Explicit single-project context for the existing service regression suite."""

from sqlalchemy import select

from resolvate.database import Database
from resolvate.migrations import upgrade_database as migrate
from resolvate.models import ConsoleAccount, Project

PROJECT_ID = "00000000-0000-4000-8000-000000000001"
ADMIN_ID = "00000000-0000-4000-8000-000000000002"


async def seed_project(database: Database) -> None:
    async with database.session() as session:
        if await session.scalar(select(Project.id).where(Project.id == PROJECT_ID)):
            return
        session.add(
            ConsoleAccount(
                id=ADMIN_ID,
                login="fixture_project_admin",
                display_name="Fixture",
                password_hash="not-a-login-password",
                role="operator",
                active=True,
            )
        )
        await session.flush()
        session.add(
            Project(
                id=PROJECT_ID,
                name="Regression project",
                admin_id=ADMIN_ID,
                active=True,
                settings={},
            )
        )
        await session.commit()


class ProjectDatabase(Database):
    def __init__(self, database_url: str) -> None:
        super().__init__(database_url, project_id=PROJECT_ID)

    async def create_schema_for_tests(self) -> None:
        await super().create_schema_for_tests()
        await seed_project(self)


async def upgrade_database(database_url: str) -> None:
    await migrate(database_url)
    database = Database(database_url)
    try:
        await seed_project(database)
    finally:
        await database.dispose()
