"""Project-local catalog. Telegram publications are derived, never a second catalog."""

import unicodedata
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from resolvate.database import Database
from resolvate.models import AccessAudit, ConsoleAccount, QuickResponse, QuickResponseGroup
from resolvate.quick_replies import utf16_code_units

# Fits the composer and Telegram even with a maximum-length group heading.
REPLY_TEXT_LIMIT = 3900


def _valid_text(value: str) -> bool:
    return "\x00" not in value and not any(unicodedata.category(c) == "Cs" for c in value)


def group_name(value: str) -> str:
    name = unicodedata.normalize("NFKC", value).strip().removeprefix("/").casefold()
    if (
        not 1 <= len(name) <= 48
        or not any(c.isalnum() for c in name)
        or any(not (c.isalnum() or c == "_") for c in name)
    ):
        raise HTTPException(422, "Группа: 1–48 букв, цифр или знаков подчёркивания, без пробелов.")
    return name


def group_view(group: QuickResponseGroup) -> dict[str, Any]:
    return {"id": group.id, "name": group.name, "revision": group.revision}


def reply_view(reply: QuickResponse) -> dict[str, Any]:
    return {
        "id": str(reply.id),
        "text": reply.text,
        "group_id": reply.group_id,
        "revision": reply.revision,
    }


class QuickReplyCatalog:
    def __init__(self, database: Database) -> None:
        self.database = database

    async def _lock(self, session: AsyncSession) -> None:
        # Short mutations only; never hold this lock during Telegram/network calls.
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:project, 726017))"),
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

    @staticmethod
    def _revision(actual: int, expected: int) -> None:
        if actual != expected:
            raise HTTPException(409, "Запись изменена другим оператором. Обновите каталог.")

    async def groups(self, q: str = "", offset: int = 0) -> list[dict[str, Any]]:
        if not _valid_text(q):
            raise HTTPException(422, "Некорректный текст поиска.")
        statement = select(QuickResponseGroup)
        if q:
            statement = statement.where(
                QuickResponseGroup.name.contains(
                    unicodedata.normalize("NFKC", q).casefold().removeprefix("/"), autoescape=True
                )
            )
        async with self.database.session() as session:
            rows = await session.scalars(
                statement.order_by(QuickResponseGroup.name, QuickResponseGroup.id)
                .offset(offset)
                .limit(50)
            )
            return [group_view(row) for row in rows]

    async def replies(
        self, group_id: str | None, q: str = "", offset: int = 0
    ) -> list[dict[str, Any]]:
        if not _valid_text(q):
            raise HTTPException(422, "Некорректный текст поиска.")
        statement = select(QuickResponse).where(QuickResponse.state == "valid")
        if group_id is not None:
            statement = statement.where(QuickResponse.group_id == group_id)
        if q:
            statement = statement.where(QuickResponse.text.icontains(q, autoescape=True))
        async with self.database.session() as session:
            if group_id is not None and await session.get(QuickResponseGroup, group_id) is None:
                raise HTTPException(404, "Группа не найдена.")
            rows = await session.scalars(
                statement.order_by(QuickResponse.id).offset(offset).limit(50)
            )
            return [reply_view(row) for row in rows]

    async def create_group(self, actor: ConsoleAccount, name: str) -> dict[str, Any]:
        name = group_name(name)
        async with self.database.session() as session:
            await self._lock(session)
            if await session.scalar(
                select(QuickResponseGroup.id).where(QuickResponseGroup.name == name)
            ):
                raise HTTPException(409, "Такая группа уже существует.")
            group = QuickResponseGroup(name=name)
            session.add(group)
            await session.flush()
            self._audit(session, actor, "quick_reply_group_created", group.id)
            await session.commit()
            return group_view(group)

    async def change_group(
        self, actor: ConsoleAccount, group_id: str, revision: int, name: str | None = None
    ) -> None:
        normalized = group_name(name) if name is not None else None
        async with self.database.session() as session:
            await self._lock(session)
            group = await session.get(QuickResponseGroup, group_id, with_for_update=True)
            if group is None:
                raise HTTPException(404, "Группа не найдена.")
            self._revision(group.revision, revision)
            if normalized is not None:
                # Legacy answers could be longer than today's composer limit.
                # Refuse a heading that would make their Telegram publication too large.
                legacy_texts = await session.scalars(
                    select(QuickResponse.text).where(
                        QuickResponse.group_id == group_id,
                        QuickResponse.state == "valid",
                        func.octet_length(QuickResponse.text) > 3900,
                    )
                )
                if any(
                    utf16_code_units(f"/{normalized}\n\n" + body) > 4096 for body in legacy_texts
                ):
                    raise HTTPException(
                        409, "Сначала сократите длинные ответы в этой группе до 3900 символов."
                    )
                if await session.scalar(
                    select(QuickResponseGroup.id).where(
                        QuickResponseGroup.name == normalized, QuickResponseGroup.id != group_id
                    )
                ):
                    raise HTTPException(409, "Такая группа уже существует.")
                group.name = normalized
                group.revision += 1
                await session.execute(
                    update(QuickResponse)
                    .where(QuickResponse.group_id == group_id)
                    .values(revision=QuickResponse.revision + 1, publication_format_version=0)
                )
            else:
                if await session.scalar(
                    select(QuickResponse.id)
                    .where(QuickResponse.group_id == group_id, QuickResponse.state == "valid")
                    .limit(1)
                ):
                    raise HTTPException(409, "Сначала перенесите или удалите ответы из группы.")
                await session.execute(
                    update(QuickResponse)
                    .where(QuickResponse.group_id == group_id)
                    .values(group_id=None)
                )
                await session.delete(group)
            self._audit(
                session,
                actor,
                "quick_reply_group_renamed" if normalized else "quick_reply_group_deleted",
                group_id,
            )
            await session.commit()

    async def save(
        self,
        actor: ConsoleAccount,
        group_id: str,
        content: str,
        *,
        reply_id: int | None = None,
        revision: int = 0,
    ) -> dict[str, Any]:
        if (
            not content.strip()
            or utf16_code_units(content) > REPLY_TEXT_LIMIT
            or not _valid_text(content)
        ):
            raise HTTPException(
                422, "Ответ: непустой текст до 3900 символов (эмодзи могут занимать два)."
            )
        async with self.database.session() as session:
            await self._lock(session)
            group = await session.get(QuickResponseGroup, group_id)
            if group is None:
                raise HTTPException(404, "Группа не найдена.")
            if reply_id is None:
                reply = QuickResponse(
                    text=content,
                    group=group,
                    tags=[],
                    created_by_telegram_id=actor.telegram_id or 0,
                    created_by_display_name=actor.display_name,
                    state="valid",
                )
                session.add(reply)
            else:
                existing = await session.get(QuickResponse, reply_id, with_for_update=True)
                if existing is None or existing.state != "valid":
                    raise HTTPException(404, "Ответ не найден.")
                reply = existing
                self._revision(reply.revision, revision)
                reply.text, reply.group = content, group
                reply.tags = []
                reply.revision += 1
                reply.publication_format_version = 0
            await session.flush()
            self._audit(session, actor, "quick_reply_saved", str(reply.id))
            await session.commit()
            return reply_view(reply)

    async def delete(self, actor: ConsoleAccount, reply_id: int, revision: int) -> None:
        async with self.database.session() as session:
            await self._lock(session)
            reply = await session.get(QuickResponse, reply_id, with_for_update=True)
            if reply is None or reply.state != "valid":
                raise HTTPException(404, "Ответ не найден.")
            self._revision(reply.revision, revision)
            reply.state = "deleted"
            reply.revision += 1
            reply.deleted_at = datetime.now(UTC)
            reply.deleted_by_telegram_id = actor.telegram_id
            self._audit(session, actor, "quick_reply_deleted", str(reply.id))
            await session.commit()
