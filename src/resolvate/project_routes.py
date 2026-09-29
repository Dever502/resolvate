from typing import Annotated, Any
from uuid import UUID

from fastapi import Depends, FastAPI
from pydantic import BaseModel, Field

from resolvate.console_auth import ConsoleAuth
from resolvate.models import ConsoleAccount
from resolvate.projects import ProjectService


class CreateProject(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    admin_login: str = Field(min_length=3, max_length=64)


class TargetLogin(BaseModel):
    login: str = Field(min_length=3, max_length=64)


class ActiveProject(BaseModel):
    active: bool


class ProjectConfiguration(BaseModel):
    settings: dict[str, Any] = Field(max_length=40)


class TelegramIdentity(BaseModel):
    telegram_id: int | None = Field(default=None, gt=0, le=2**52 - 1)


def register_project_routes(app: FastAPI, auth: ConsoleAuth, service: ProjectService) -> None:
    Actor = Annotated[ConsoleAccount, Depends(auth.require)]

    @app.post("/accounts/{account_id}/identity/telegram")
    async def telegram_identity(
        account_id: UUID, payload: TelegramIdentity, actor: Actor
    ) -> dict[str, bool]:
        await service.set_telegram_identity(actor, str(account_id), payload.telegram_id)
        return {"ok": True}

    @app.get("/projects")
    async def projects(actor: Actor) -> list[dict[str, Any]]:
        return await service.list_projects(actor)

    @app.post("/projects")
    async def create(payload: CreateProject, actor: Actor) -> dict[str, str]:
        project = await service.create(actor, payload.name, payload.admin_login)
        return {"id": project.id}

    @app.get("/projects/{project_id}/members")
    async def members(project_id: UUID, actor: Actor) -> list[dict[str, Any]]:
        return await service.members(actor, str(project_id))

    @app.post("/projects/{project_id}/members")
    async def add_member(project_id: UUID, payload: TargetLogin, actor: Actor) -> dict[str, bool]:
        await service.change_member(actor, str(project_id), payload.login)
        return {"ok": True}

    @app.post("/projects/{project_id}/members/remove")
    async def remove_member(
        project_id: UUID, payload: TargetLogin, actor: Actor
    ) -> dict[str, bool]:
        await service.change_member(actor, str(project_id), payload.login, remove=True)
        return {"ok": True}

    @app.post("/projects/{project_id}/admin")
    async def transfer_admin(
        project_id: UUID, payload: TargetLogin, actor: Actor
    ) -> dict[str, bool]:
        await service.transfer(actor, payload.login, str(project_id))
        return {"ok": True}

    @app.post("/installation/admin")
    async def transfer_owner(payload: TargetLogin, actor: Actor) -> dict[str, bool]:
        await service.transfer(actor, payload.login)
        return {"ok": True}

    @app.post("/projects/{project_id}/active")
    async def set_active(project_id: UUID, payload: ActiveProject, actor: Actor) -> dict[str, bool]:
        await service.set_active(actor, str(project_id), payload.active)
        return {"ok": True}

    @app.get("/projects/{project_id}/settings")
    async def settings(project_id: UUID, actor: Actor) -> dict[str, Any]:
        return await service.configuration(actor, str(project_id))

    @app.post("/projects/{project_id}/settings")
    async def configure(
        project_id: UUID, payload: ProjectConfiguration, actor: Actor
    ) -> dict[str, bool]:
        await service.configure(actor, str(project_id), payload.settings)
        return {"ok": True}
