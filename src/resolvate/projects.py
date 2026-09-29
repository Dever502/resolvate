"""Installation accounts and explicit, independent project memberships."""

from __future__ import annotations

import ipaddress
import re
from typing import Any
from urllib.parse import urlsplit

from fastapi import HTTPException
from pydantic import SecretStr, ValidationError
from sqlalchemy import delete, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from resolvate.config import Settings
from resolvate.console_auth import ACCOUNT_LOCK, digest
from resolvate.database import Database
from resolvate.models import (
    AccessAudit,
    ConsoleAccount,
    ConsoleSession,
    Project,
    ProjectCredential,
    ProjectMember,
)

SECRET_FIELDS = frozenset(
    {
        "support_bot_token",
        "api_admin_token",
        "web_api_token",
        "remnawave_api_token",
        "notification_webhook_secret",
    }
)
PROJECT_FIELDS = frozenset(
    {
        *SECRET_FIELDS,
        "support_group_id",
        "api_enabled",
        "web_api_enabled",
        "web_identity_mode",
        "remnawave_enabled",
        "remnawave_base_url",
        "remnawave_revoke_link_telegram_notification",
        "notification_webhook_enabled",
        "notification_webhook_url",
        "user_messages_per_minute",
        "user_messages_per_hour",
        "topic_rotation_enabled",
        "topic_rotation_message_limit",
        "topic_rotation_topic_limit",
        "topic_rotation_topic_reserve",
        "topic_rotation_delay_seconds",
        "archive_retention_days",
        "archive_media_compress_after_days",
        "archive_media_retention_days",
    }
)


def runtime_settings(base: Settings, project: Project) -> Settings:
    # Never inherit credentials or destinations from another project or the installation env.
    values = {key: value for key, value in project.settings.items() if key in PROJECT_FIELDS}
    values.update(
        database_url=base.database_url,
        migration_database_url=base.migration_database_url,
        migrations_at_startup=False,
        console_origin=base.console_origin,
        data_dir=base.data_dir / "projects" / project.id,
        api_host=base.api_host,
        api_port=base.api_port,
        api_requests_per_minute=base.api_requests_per_minute,
        api_trusted_proxy_ips=base.api_trusted_proxy_ips,
        media_budget_bytes=base.media_budget_bytes,
        archive_budget_bytes=base.archive_budget_bytes,
        storage_reserve_bytes=base.storage_reserve_bytes,
    )
    # model_validate still consults BaseSettings env; explicitly supply every remaining default.
    for name, field in Settings.model_fields.items():
        if name not in values and not field.is_required():
            values[name] = field.get_default(call_default_factory=True)
    values["_env_file"] = None
    return Settings(**values)


def project_view(project: Project, account: ConsoleAccount, member: bool) -> dict[str, Any]:
    return {
        "id": project.id,
        "name": project.name,
        "active": project.active,
        "admin_id": project.admin_id,
        "role": "admin" if project.admin_id == account.id else "operator" if member else None,
        "logo": project.logo_sha256 if member or project.admin_id == account.id else None,
    }


async def membership(
    database: Database, account: ConsoleAccount, *, active: bool = True
) -> Project:
    async with database.session() as session:
        project = await session.get(Project, database.project_id)
        member = await session.get(ProjectMember, (database.project_id, account.id))
        if project is None or (active and not project.active):
            raise HTTPException(404, "Проект недоступен.")
        if project.admin_id != account.id and member is None:
            raise HTTPException(403, "Нет доступа к проекту.")
        return project


class ProjectService:
    def __init__(self, database: Database, settings: Settings) -> None:
        self.database = database
        self.settings = settings

    async def set_telegram_identity(
        self, actor: ConsoleAccount, account_id: str, telegram_id: int | None
    ) -> None:
        async with self.database.session() as session:
            current = await self._actor(session, actor)
            if current.role != "admin":
                raise HTTPException(403, "Требуются права администратора установки.")
            target = await session.get(ConsoleAccount, account_id)
            if target is None:
                raise HTTPException(404, "Аккаунт не найден.")
            target.telegram_id = telegram_id
            self._audit(session, actor, "telegram_identity_changed", target_id=target.id)
            try:
                await session.commit()
            except IntegrityError:
                raise HTTPException(409, "Этот Telegram ID уже используется.") from None

    async def _actor(self, session: AsyncSession, actor: ConsoleAccount) -> ConsoleAccount:
        await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": ACCOUNT_LOCK})
        current = await session.get(ConsoleAccount, actor.id, populate_existing=True)
        if current is None or not current.active:
            raise HTTPException(401, "Войдите снова.")
        return current

    async def _project(
        self, session: AsyncSession, actor: ConsoleAccount, project_id: str, *, owner: bool = False
    ) -> Project:
        current = await self._actor(session, actor)
        project = await session.get(Project, project_id, with_for_update=True)
        if project is None:
            raise HTTPException(404, "Проект не найден.")
        if (owner and current.role != "admin") or (not owner and project.admin_id != current.id):
            raise HTTPException(403, "Недостаточно прав.")
        return project

    def _audit(
        self,
        session: AsyncSession,
        actor: ConsoleAccount,
        action: str,
        project_id: str | None = None,
        target_id: str | None = None,
    ) -> None:
        session.add(
            AccessAudit(
                actor_id=actor.id, action=action, project_id=project_id, target_id=target_id
            )
        )

    async def list_projects(self, actor: ConsoleAccount) -> list[dict[str, Any]]:
        async with self.database.session() as session:
            member_ids = select(ProjectMember.project_id).where(
                ProjectMember.account_id == actor.id
            )
            query = select(Project).order_by(Project.name, Project.id)
            if actor.role != "admin":
                query = query.where(or_(Project.admin_id == actor.id, Project.id.in_(member_ids)))
            projects = (await session.scalars(query)).all()
            joined = set((await session.scalars(member_ids)).all())
            return [project_view(project, actor, project.id in joined) for project in projects]

    async def create(self, actor: ConsoleAccount, name: str, admin_login: str) -> Project:
        async with self.database.session() as session:
            current = await self._actor(session, actor)
            if current.role != "admin":
                raise HTTPException(403, "Требуются права администратора установки.")
            admin = await self._account(session, admin_login)
            project = Project(name=name.strip(), admin_id=admin.id, settings={}, active=False)
            if not project.name:
                raise HTTPException(422, "Укажите название проекта.")
            session.add(project)
            await session.flush()
            self._audit(session, actor, "project_created", project.id, admin.id)
            await session.commit()
            return project

    async def _account(self, session: AsyncSession, login: str) -> ConsoleAccount:
        account = await session.scalar(
            select(ConsoleAccount).where(
                ConsoleAccount.login == login.strip().casefold(), ConsoleAccount.active.is_(True)
            )
        )
        if account is None:
            raise HTTPException(404, "Активная учётная запись с таким логином не найдена.")
        return account

    async def members(self, actor: ConsoleAccount, project_id: str) -> list[dict[str, Any]]:
        async with self.database.session() as session:
            await self._actor(session, actor)
            project = await session.get(Project, project_id)
            if project is None or (actor.role != "admin" and project.admin_id != actor.id):
                raise HTTPException(403, "Недостаточно прав.")
            rows = (
                await session.scalars(
                    select(ConsoleAccount)
                    .where(
                        or_(
                            ConsoleAccount.id == project.admin_id,
                            ConsoleAccount.id.in_(
                                select(ProjectMember.account_id).where(
                                    ProjectMember.project_id == project_id
                                )
                            ),
                        )
                    )
                    .order_by(ConsoleAccount.login)
                )
            ).all()
            return [
                {
                    "id": row.id,
                    "login": row.login,
                    "name": row.display_name,
                    "active": row.active,
                    "telegram_id": row.telegram_id,
                    "role": "admin" if row.id == project.admin_id else "operator",
                }
                for row in rows
            ]

    async def change_member(
        self, actor: ConsoleAccount, project_id: str, login: str, *, remove: bool = False
    ) -> None:
        async with self.database.session() as session:
            current = await self._actor(session, actor)
            project = await session.get(Project, project_id, with_for_update=True)
            if project is None or (current.role != "admin" and project.admin_id != actor.id):
                raise HTTPException(403, "Недостаточно прав.")
            account = await session.scalar(
                select(ConsoleAccount).where(ConsoleAccount.login == login.strip().casefold())
            )
            if account is None or (not remove and not account.active):
                raise HTTPException(404, "Учётная запись недоступна.")
            if project.admin_id == account.id:
                raise HTTPException(409, "Сначала передайте управление проектом.")
            row = await session.get(ProjectMember, (project_id, account.id))
            if remove and row is not None:
                await session.delete(row)
            elif not remove and row is None:
                session.add(ProjectMember(project_id=project_id, account_id=account.id))
            self._audit(
                session,
                actor,
                "access_revoked" if remove else "access_granted",
                project_id,
                account.id,
            )
            await session.commit()

    async def transfer(
        self, actor: ConsoleAccount, login: str, project_id: str | None = None
    ) -> None:
        async with self.database.session() as session:
            current = await self._actor(session, actor)
            if current.role != "admin":
                raise HTTPException(403, "Требуются права администратора установки.")
            target = await self._account(session, login)
            if project_id is None:
                current.role = "operator"
                await session.flush()
                target.role = "admin"
                await session.execute(
                    delete(ConsoleSession).where(
                        ConsoleSession.account_id.in_([current.id, target.id])
                    )
                )
            else:
                project = await session.get(Project, project_id, with_for_update=True)
                if project is None:
                    raise HTTPException(404, "Проект не найден.")
                # The outgoing administrator keeps no implicit access.
                await session.execute(
                    delete(ProjectMember).where(
                        ProjectMember.project_id == project_id,
                        ProjectMember.account_id.in_([project.admin_id, target.id]),
                    )
                )
                project.admin_id = target.id
            self._audit(session, actor, "admin_transferred", project_id, target.id)
            await session.commit()

    async def configure(
        self, actor: ConsoleAccount, project_id: str, values: dict[str, Any]
    ) -> None:
        if set(values) - PROJECT_FIELDS:
            raise HTTPException(422, "Неизвестные настройки проекта.")
        async with self.database.session() as session:
            project = await self._project(session, actor, project_id)
            previous = project.settings
            project.settings = {**previous, **values}
            try:
                validated = runtime_settings(self.settings, project)
            except (ValidationError, ValueError):
                raise HTTPException(422, "Проверьте настройки и ключи интеграций.") from None
            token = validated.support_bot_token.get_secret_value()
            for field in ("remnawave_base_url", "notification_webhook_url"):
                value = getattr(validated, field)
                if not value:
                    continue
                parsed = urlsplit(value)
                if parsed.scheme != "https" or parsed.hostname in {"localhost", None}:
                    raise HTTPException(422, "Интеграциям нужен публичный HTTPS-адрес.")
                try:
                    address = ipaddress.ip_address(parsed.hostname)
                except ValueError:
                    pass  # Hostnames are resolved, checked and pinned on every outbound request.
                else:
                    if not address.is_global or address.is_multicast:
                        raise HTTPException(422, "Локальные адреса интеграций запрещены.")
            if not -(2**52 - 1) <= validated.support_group_id <= 0:
                raise HTTPException(422, "Укажите отрицательный ID группы Telegram.")
            if token and not re.fullmatch(r"[1-9][0-9]{0,18}:[A-Za-z0-9_-]{20,200}", token):
                raise HTTPException(422, "Неверный формат токена Telegram-бота.")
            # Changing Telegram destinations would invalidate queued copies and topic IDs.
            new_bot = int(token.split(":")[0]) if token else None
            if new_bot is not None and new_bot > 2**52 - 1:
                raise HTTPException(422, "Неверный идентификатор бота.")
            new_group = validated.support_group_id or None
            # Bind each destination independently so partial setup can be completed.
            if (project.bot_id is not None and new_bot != project.bot_id) or (
                project.group_id is not None and new_group != project.group_id
            ):
                raise HTTPException(
                    409, "Бот и группа закреплены за проектом. Для другого канала создайте проект."
                )
            project.bot_id, project.group_id = new_bot, new_group
            project.settings = {
                key: (
                    getattr(validated, key).get_secret_value()
                    if isinstance(getattr(validated, key), SecretStr)
                    else getattr(validated, key)
                )
                for key in PROJECT_FIELDS
            }
            project.revision += 1
            await session.execute(
                delete(ProjectCredential).where(ProjectCredential.project_id == project_id)
            )
            await session.flush()
            for field in ("api_admin_token", "web_api_token"):
                credential = getattr(validated, field)
                if credential is not None:
                    session.add(
                        ProjectCredential(
                            project_id=project_id, fingerprint=digest(credential.get_secret_value())
                        )
                    )
            self._audit(session, actor, "project_configured", project_id)
            try:
                await session.commit()
            except IntegrityError:
                raise HTTPException(
                    409, "Этот бот, группа или API-ключ уже используется другим проектом."
                ) from None

    async def configuration(self, actor: ConsoleAccount, project_id: str) -> dict[str, Any]:
        async with self.database.session() as session:
            project = await self._project(session, actor, project_id)
            return {
                key: bool(value) if key in SECRET_FIELDS else value
                for key, value in project.settings.items()
                if key in PROJECT_FIELDS
            }

    async def set_active(self, actor: ConsoleAccount, project_id: str, active: bool) -> None:
        async with self.database.session() as session:
            project = await self._project(session, actor, project_id, owner=True)
            if active and (project.bot_id is None or project.group_id is None):
                raise HTTPException(
                    409, "Администратор проекта должен сначала настроить бота и группу."
                )
            project.active = active
            project.revision += 1
            self._audit(
                session, actor, "project_enabled" if active else "project_disabled", project_id
            )
            await session.commit()
