"""Shared folder mutations with project isolation and optimistic concurrency."""

import unicodedata
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from resolvate.database import Database
from resolvate.models import AccessAudit, ConsoleAccount, Ticket, TicketFolder


def folder_name(value: str) -> tuple[str, str]:
    name = " ".join(unicodedata.normalize("NFKC", value).split())
    if not 1 <= len(name) <= 80 or any(unicodedata.category(c).startswith("C") for c in name):
        raise HTTPException(422, "Название папки: от 1 до 80 символов без управляющих знаков.")
    return name, name.casefold()


def folder_view(folder: TicketFolder) -> dict[str, Any]:
    return {"id": folder.id, "name": folder.name, "revision": folder.revision}


def assignment(ticket: Ticket) -> dict[str, Any]:
    return {"folder_id": ticket.folder_id, "folder_revision": ticket.folder_revision}


class ConsoleFolders:
    def __init__(self, database: Database) -> None:
        self.database = database

    async def _lock(self, session: AsyncSession) -> None:
        # Serialize only short folder writes within this project. No network I/O or
        # runtime configuration locks. Ticket row locks follow this lock, never vice versa.
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:project, 726016))"),
            {"project": self.database.project_id or ""},
        )

    def _audit(
        self, session: AsyncSession, actor: ConsoleAccount, action: str, target: str
    ) -> None:
        session.add(
            AccessAudit(
                actor_id=actor.id,
                project_id=self.database.project_id,
                action=action,
                target_id=target,
            )
        )

    async def list(self) -> list[dict[str, Any]]:
        async with self.database.session() as session:
            rows = await session.scalars(select(TicketFolder).order_by(TicketFolder.name_key))
            return [folder_view(row) for row in rows]

    async def ticket(self, ticket_id: str) -> dict[str, Any]:
        async with self.database.session() as session:
            ticket = await session.get(Ticket, ticket_id)
            if ticket is None:
                raise HTTPException(404, "Диалог не найден.")
            return assignment(ticket)

    async def _unique(self, session: AsyncSession, key: str, folder_id: str | None = None) -> None:
        duplicate = await session.scalar(
            select(TicketFolder.id).where(
                TicketFolder.name_key == key, TicketFolder.id != folder_id
            )
        )
        if duplicate:
            raise HTTPException(409, "Папка с таким названием уже существует.")

    async def create(self, actor: ConsoleAccount, value: str) -> dict[str, Any]:
        name, key = folder_name(value)
        async with self.database.session() as session:
            await self._lock(session)
            await self._unique(session, key)
            folder = TicketFolder(name=name, name_key=key)
            session.add(folder)
            await session.flush()
            self._audit(session, actor, "folder_created", folder.id)
            await session.commit()
            return folder_view(folder)

    async def change(
        self, actor: ConsoleAccount, folder_id: str, revision: int, *, name: str | None = None
    ) -> None:
        normalized = folder_name(name) if name is not None else None
        async with self.database.session() as session:
            await self._lock(session)
            folder = await session.get(TicketFolder, folder_id, with_for_update=True)
            if folder is None:
                raise HTTPException(404, "Папка уже удалена или недоступна.")
            if folder.revision != revision:
                raise HTTPException(
                    409, "Папка изменена другим оператором. Проверьте новое название."
                )
            if normalized:
                await self._unique(session, normalized[1], folder.id)
                folder.name, folder.name_key = normalized
                folder.revision += 1
            else:
                # Explicitly advance assignment revisions so pending moves cannot overwrite
                # the deletion using a stale UI. SET NULL is also a database-level safety net.
                await session.execute(
                    update(Ticket)
                    .where(Ticket.folder_id == folder.id)
                    .values(
                        folder_id=None,
                        folder_revision=Ticket.folder_revision + 1,
                        updated_at=Ticket.updated_at,
                    )
                )
                await session.delete(folder)
            self._audit(
                session, actor, "folder_renamed" if normalized else "folder_deleted", folder.id
            )
            await session.commit()

    async def move(
        self, actor: ConsoleAccount, ticket_id: str, folder_id: str | None, revision: int
    ) -> dict[str, Any]:
        async with self.database.session() as session:
            await self._lock(session)
            ticket = await session.get(Ticket, ticket_id, with_for_update=True)
            if ticket is None:
                raise HTTPException(404, "Диалог не найден.")
            if ticket.folder_revision != revision:
                raise HTTPException(
                    409, "Другой оператор уже изменил папку диалога. Выберите её заново."
                )
            if folder_id is not None and await session.get(TicketFolder, folder_id) is None:
                raise HTTPException(404, "Папка уже удалена или недоступна.")
            if ticket.folder_id != folder_id:
                ticket.folder_id = folder_id
                ticket.folder_revision += 1
                self._audit(session, actor, "ticket_folder_changed", ticket.id)
            await session.commit()
            return assignment(ticket)
