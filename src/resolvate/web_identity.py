"""Serialize identity-mode configuration with the first Web admission."""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

WEB_IDENTITY_MODE_KEY = "web_identity_mode"


async def lock_web_identity_mode(session: AsyncSession, project_id: str) -> None:
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:project, :key))"),
        {"project": project_id, "key": 726016},
    )
