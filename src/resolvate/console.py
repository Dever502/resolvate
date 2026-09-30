import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import asdict
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, SecretStr
from sqlalchemy import delete, select
from starlette.datastructures import UploadFile

from resolvate.archive_media_storage import ArchiveStorageFull
from resolvate.config import Settings
from resolvate.console_auth import COOKIE, SESSION_SECONDS, ConsoleAuth, account_view, digest
from resolvate.console_folders import ConsoleFolders
from resolvate.console_service import ConsoleService, delta
from resolvate.database import Database
from resolvate.media_storage import LocalMediaStorage, MediaValidationError
from resolvate.models import ConsoleAccount, ConsoleSession, QuickResponse
from resolvate.project_branding import MAX_LOGO_BYTES
from resolvate.service_types import TicketNotFoundError
from resolvate.services import TicketService
from resolvate.web_api_routes import _limit_request_body
from resolvate.web_models import MediaAsset

logger = logging.getLogger(__name__)
ASSETS = Path(__file__).with_name("console_assets")


class Login(BaseModel):
    login: str = Field(min_length=1, max_length=64)
    password: SecretStr = Field(min_length=12, max_length=128)


class NewAccount(Login):
    name: str = Field(min_length=1, max_length=100)
    role: Literal["admin", "operator"] = "operator"
    telegram_id: int | None = Field(default=None, gt=0, le=2**52 - 1)


class PasswordChange(BaseModel):
    current_password: SecretStr = Field(min_length=1, max_length=128)
    new_password: SecretStr = Field(min_length=12, max_length=128)


class Sync(BaseModel):
    known: dict[str, str] = Field(default_factory=dict, max_length=5000)
    archived: bool = False
    query: str = Field(default="", max_length=100)
    offset: int = Field(default=0, ge=0, le=100_000)
    before: str | None = Field(default=None, max_length=200)
    folder_id: uuid.UUID | None = None
    unfiled: bool = False


class FolderName(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class FolderRevision(BaseModel):
    revision: int = Field(ge=0, le=2**31 - 1)


class RenameFolder(FolderName, FolderRevision):
    pass


class MoveToFolder(BaseModel):
    folder_id: uuid.UUID | None
    revision: int = Field(ge=0, le=2**31 - 1)


def create_console(
    database: Database,
    tickets: TicketService,
    settings: Settings,
    storage: LocalMediaStorage,
    client_key: Callable[[Request], str],
) -> FastAPI:
    assert settings.console_origin is not None
    auth = ConsoleAuth(database, settings.console_origin)
    service = ConsoleService(database, tickets, settings)
    folders = ConsoleFolders(database)
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.state.auth = auth
    app.state.service = service
    Identity = Annotated[ConsoleAccount, Depends(auth.require)]
    Actor = Annotated[ConsoleAccount, Depends(auth.project_actor)]
    Admin = Annotated[ConsoleAccount, Depends(auth.admin)]

    @app.middleware("http")
    async def security(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        size = 20 * 1024 * 1024 + 65536 if request.url.path.endswith("/send") else 768 * 1024
        if request.url.path.endswith("/logo"):
            size = MAX_LOGO_BYTES + 65536
        _limit_request_body(request, size)
        try:
            if int(request.headers.get("content-length", "0")) > size:
                raise HTTPException(413, "Запрос слишком большой.")
            response = await call_next(request)
        except (ValueError, HTTPException) as error:
            code = error.status_code if isinstance(error, HTTPException) else 400
            response = JSONResponse({"detail": "Неверный размер запроса."}, status_code=code)
        response.headers.update(
            {
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
                "X-Frame-Options": "DENY",
                "Content-Security-Policy": "default-src 'none'; script-src 'self'; "
                "style-src 'self'; "
                "img-src 'self'; media-src 'self'; connect-src 'self'; font-src 'self'; "
                "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
            }
        )
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError) -> JSONResponse:
        return JSONResponse({"detail": "Проверьте введённые данные."}, status_code=422)

    @app.exception_handler(TicketNotFoundError)
    async def not_found(request: Request, error: TicketNotFoundError) -> JSONResponse:
        return JSONResponse({"detail": "Диалог или файл не найден."}, status_code=404)

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(ASSETS / "index.html", media_type="text/html")

    @app.get("/assets/{name}")
    async def asset(name: str) -> FileResponse:
        if name not in {"app.js", "app.css", "image_viewer.js", "theme.js"}:
            raise HTTPException(404)
        return FileResponse(ASSETS / name)

    @app.post("/login")
    async def login(request: Request, payload: Login, response: Response) -> dict[str, object]:
        auth.same_origin(request)
        account, token = await auth.login(
            payload.login, payload.password.get_secret_value(), client_key(request)
        )
        response.set_cookie(
            COOKIE,
            token,
            max_age=SESSION_SECONDS,
            secure=auth.secure,
            httponly=True,
            samesite="strict",
            path="/console",
        )
        return {"account": account_view(account), "csrf": digest("csrf:" + token)}

    @app.get("/me")
    async def me(request: Request, actor: Identity) -> dict[str, object]:
        return {"account": account_view(actor), "csrf": digest("csrf:" + request.cookies[COOKIE])}

    @app.post("/logout")
    async def logout(request: Request, response: Response, actor: Identity) -> dict[str, bool]:
        async with database.session() as session:
            await session.execute(
                delete(ConsoleSession).where(
                    ConsoleSession.token_hash == digest(request.cookies[COOKIE])
                )
            )
            await session.commit()
        response.delete_cookie(
            COOKIE, path="/console", secure=auth.secure, httponly=True, samesite="strict"
        )
        return {"ok": True}

    @app.get("/accounts")
    async def accounts(actor: Admin) -> list[dict[str, object]]:
        async with database.session() as session:
            rows = (
                await session.scalars(select(ConsoleAccount).order_by(ConsoleAccount.login))
            ).all()
        return [account_view(row) for row in rows]

    @app.post("/accounts")
    async def add_account(payload: NewAccount, actor: Admin) -> dict[str, object]:
        created = await auth.create_account(
            login=payload.login,
            name=payload.name,
            password=payload.password.get_secret_value(),
            role=payload.role,
            telegram_id=payload.telegram_id,
        )
        return account_view(created)

    @app.post("/password")
    async def change_password(
        payload: PasswordChange, request: Request, response: Response, actor: Identity
    ) -> dict[str, bool]:
        await auth.change_password(
            actor,
            token=request.cookies[COOKIE],
            current_password=payload.current_password.get_secret_value(),
            new_password=payload.new_password.get_secret_value(),
        )
        response.delete_cookie(
            COOKIE, path="/console", secure=auth.secure, httponly=True, samesite="strict"
        )
        return {"ok": True}

    @app.post("/accounts/{account_id}/password")
    async def reset_password(
        account_id: uuid.UUID, payload: PasswordChange, request: Request, actor: Admin
    ) -> dict[str, bool]:
        await auth.change_password(
            actor,
            token=request.cookies[COOKIE],
            current_password=payload.current_password.get_secret_value(),
            new_password=payload.new_password.get_secret_value(),
            target_id=str(account_id),
        )
        return {"ok": True}

    @app.post("/accounts/{account_id}/{action}")
    async def change_account(
        account_id: uuid.UUID, action: Literal["enable", "disable"], actor: Admin
    ) -> dict[str, bool]:
        await auth.set_active(str(account_id), action == "enable")
        return {"ok": True}

    @app.post("/tickets/sync")
    async def ticket_list(payload: Sync, actor: Actor) -> dict[str, Any]:
        if payload.folder_id and payload.unfiled:
            raise HTTPException(422, "Выберите папку или диалоги без папки.")
        rows = await service.list_tickets(
            actor,
            archived=payload.archived,
            query=payload.query,
            limit=50,
            offset=payload.offset,
            folder_id=str(payload.folder_id) if payload.folder_id else None,
            unfiled=payload.unfiled,
        )
        return delta(rows, payload.known)

    @app.get("/tickets/{ticket_id}")
    async def ticket_detail(ticket_id: uuid.UUID, actor: Actor) -> dict[str, Any]:
        return {
            **asdict(await tickets.get_ticket(str(ticket_id))),
            **await folders.ticket(str(ticket_id)),
        }

    @app.get("/folders")
    async def folder_list(actor: Actor) -> list[dict[str, Any]]:
        return await folders.list()

    @app.post("/folders")
    async def create_folder(payload: FolderName, actor: Actor) -> dict[str, Any]:
        return await folders.create(actor, payload.name)

    @app.post("/folders/{folder_id}/rename")
    async def rename_folder(
        folder_id: uuid.UUID, payload: RenameFolder, actor: Actor
    ) -> dict[str, bool]:
        await folders.change(actor, str(folder_id), payload.revision, name=payload.name)
        return {"ok": True}

    @app.post("/folders/{folder_id}/delete")
    async def delete_folder(
        folder_id: uuid.UUID, payload: FolderRevision, actor: Actor
    ) -> dict[str, bool]:
        await folders.change(actor, str(folder_id), payload.revision)
        return {"ok": True}

    @app.post("/tickets/{ticket_id}/folder")
    async def move_ticket(
        ticket_id: uuid.UUID, payload: MoveToFolder, actor: Actor
    ) -> dict[str, Any]:
        return await folders.move(
            actor,
            str(ticket_id),
            str(payload.folder_id) if payload.folder_id else None,
            payload.revision,
        )

    @app.post("/tickets/{ticket_id}/sync")
    async def messages(ticket_id: uuid.UUID, payload: Sync, actor: Actor) -> dict[str, Any]:
        return await service.messages(str(ticket_id), known=payload.known, before=payload.before)

    @app.post("/tickets/{ticket_id}/read/{message_id}")
    async def read(ticket_id: uuid.UUID, message_id: uuid.UUID, actor: Actor) -> dict[str, bool]:
        await service.mark_read(actor, str(ticket_id), str(message_id))
        return {"ok": True}

    @app.post("/tickets/{ticket_id}/send")
    async def send(ticket_id: uuid.UUID, request: Request, actor: Actor) -> dict[str, str]:
        try:
            key = str(uuid.UUID(request.headers.get("x-idempotency-key", "")))
        except ValueError as error:
            raise HTTPException(422, "Нужен ключ отправки.") from error
        async with request.form(max_files=1, max_fields=1, max_part_size=16 * 1024) as form:
            if len(form.multi_items()) != len(form) or set(form) - {"text", "file"}:
                raise HTTPException(422, "Неверные поля сообщения.")
            text_value, upload = form.get("text", ""), form.get("file")
            if not isinstance(text_value, str) or (
                upload is not None and not isinstance(upload, UploadFile)
            ):
                raise HTTPException(422, "Неверный формат сообщения.")
            content = text_value.strip()
            if not content and upload is None:
                raise HTTPException(422, "Введите сообщение или прикрепите файл.")
            if len(content) > (800 if upload else 3900):
                raise HTTPException(422, "Максимум 3900 символов, с вложением — 800.")
            # Authenticate and check the target before spending upload/decoder resources.
            await tickets.get_ticket(str(ticket_id))
            async with storage.transaction(upload is not None):
                try:
                    media = await storage.save_upload(upload) if upload else None
                    message_id = await service.send(
                        actor, str(ticket_id), key=key, content=content, media=media
                    )
                except MediaValidationError as error:
                    raise HTTPException(422, str(error)) from error
                except ArchiveStorageFull as error:
                    raise HTTPException(
                        503,
                        "Нет места для вложения. Повторите позже.",
                        headers={"Retry-After": "60"},
                    ) from error
        return {"id": message_id}

    @app.post("/tickets/{ticket_id}/{action}")
    async def lifecycle(
        ticket_id: uuid.UUID, action: Literal["close", "reopen"], actor: Actor
    ) -> dict[str, bool]:
        key = f"console:{actor.id}:{uuid.uuid4()}"
        method = tickets.close_with_notification if action == "close" else tickets.reopen
        changed = await method(
            ticket_id=str(ticket_id), operator_telegram_id=0, idempotency_key=key
        )
        return {"changed": changed}

    @app.post("/retry/{key}/{delivery_id}")
    async def retry(key: uuid.UUID, delivery_id: uuid.UUID, actor: Actor) -> dict[str, bool]:
        await service.retry(str(key), str(delivery_id))
        return {"ok": True}

    @app.get("/replies")
    async def replies(actor: Actor, q: str = "") -> list[dict[str, str]]:
        if len(q) > 100:
            raise HTTPException(422)
        statement = select(QuickResponse).where(QuickResponse.state == "valid")
        if q:
            statement = statement.where(QuickResponse.text.icontains(q, autoescape=True))
        async with database.session() as session:
            rows = (
                await session.scalars(statement.order_by(QuickResponse.created_at.desc()).limit(50))
            ).all()
        return [{"id": str(row.id), "text": row.text} for row in rows]

    @app.get("/media/{media_id}")
    async def media_file(media_id: uuid.UUID, actor: Actor) -> FileResponse:
        async with database.session() as session:
            media = await session.get(MediaAsset, str(media_id))
        if media is None:
            raise HTTPException(410, "Вложение больше не хранится.")
        path = await storage.resolve_file(media.storage_path)
        if path is None:
            raise HTTPException(410, "Вложение больше не хранится.")
        return FileResponse(
            path,
            media_type=media.mime_type,
            filename="attachment.pdf" if media.mime_type == "application/pdf" else None,
            headers={"X-Content-Type-Options": "nosniff"},
        )

    return app
