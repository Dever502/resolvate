"""Console command transport; mutations stay in the existing ticket/panel services."""

import uuid
from html.parser import HTMLParser
from typing import Annotated, TypedDict

from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, text

from resolvate.action_permissions import TELEGRAM_ACTIONS, ActionActor, allows_action
from resolvate.console_auth import ConsoleAuth
from resolvate.models import ConsoleAccount, OperatorAction
from resolvate.panel import PanelService
from resolvate.projects import membership
from resolvate.services import TicketService
from resolvate.telegram_formatting import (
    format_subscription_lookup,
    internal_notes_text,
    operator_ticket_info,
    panel_action_reply,
)

# Names are shared with Telegram, not aliases invented by the UI.
COMMANDS = {
    "info": ("Информация о клиенте", ""),
    "subinfo": ("Подписка Remnawave", ""),
    "gift": ("Продлить подписку", "<дни: 1–9999>"),
    "resetkey": ("Перевыпустить ключи подписки", ""),
    "revokelink": ("Перевыпустить ссылку подписки", ""),
    "resetdevices": ("Сбросить устройства", ""),
    "resolvepanel": ("Зафиксировать проверенный результат операции", "<UUID> applied|not_applied"),
    "notes": ("Прочитать внутренние заметки", ""),
    "note": ("Добавить внутреннюю заметку", "<текст>"),
    "stop": ("Закрыть тикет с уведомлением", ""),
    "hidestop": ("Закрыть тикет без уведомления", ""),
    "block": ("Заблокировать клиента", ""),
    "unblock": ("Разблокировать клиента", ""),
    "closeall": ("Закрыть все тикеты проекта без уведомления", ""),
    "synctopics": ("Синхронизировать темы проекта", ""),
}
PANEL = {"subinfo", "gift", "resetkey", "revokelink", "resetdevices", "resolvepanel"}
READ = {"info", "subinfo", "notes"}


class MutationArguments(TypedDict):
    ticket_id: str
    operator_telegram_id: int
    idempotency_key: str


class CommandBody(BaseModel):
    arguments: str = Field(default="", max_length=3900)


class PlainText(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def plain(value: str) -> str:
    parser = PlainText()
    parser.feed(value)
    return "".join(parser.parts)


def validate_arguments(command: str, value: str) -> str:
    value = value.strip()
    if command not in COMMANDS:
        raise HTTPException(422, "Неизвестная команда.")
    valid = not value
    if command == "gift":
        valid = value.isascii() and value.isdecimal() and 1 <= int(value) <= 9999
    elif command == "note":
        valid = bool(value)
    elif command == "resolvepanel":
        args = value.split()
        valid = len(args) == 2 and args[1] in {"applied", "not_applied"}
        if valid:
            try:
                uuid.UUID(args[0])
            except ValueError:
                valid = False
    if not valid:
        raise HTTPException(422, f"Формат: /{command} {COMMANDS[command][1]}".strip())
    return value


def register_commands(
    app: FastAPI, auth: ConsoleAuth, tickets: TicketService, panel: PanelService | None
) -> None:
    Actor = Annotated[ConsoleAccount, Depends(auth.project_actor)]
    database = auth.database

    async def available(actor: ConsoleAccount) -> list[dict[str, str | bool]]:
        project = await membership(database, actor)
        identity = ActionActor(
            project.id,
            actor.id,
            True,
            administrator=actor.role == "admin" or project.admin_id == actor.id,
        )
        return [
            {
                "name": name,
                "description": description,
                "arguments": arguments,
                "mutation": name not in READ,
            }
            for name, (description, arguments) in COMMANDS.items()
            if (name not in PANEL or panel is not None)
            and allows_action(identity, TELEGRAM_ACTIONS["/" + name], project_id=project.id)
        ]

    @app.get("/commands")
    async def command_list(actor: Actor) -> list[dict[str, str | bool]]:
        return await available(actor)

    async def perform(
        actor: ConsoleAccount, ticket_id: str, command: str, argument: str, key: str
    ) -> str:
        ticket = await tickets.get_ticket(ticket_id)
        operator = actor.telegram_id or 0
        kwargs: MutationArguments = {
            "ticket_id": ticket_id,
            "operator_telegram_id": operator,
            "idempotency_key": key,
        }
        if command == "info":
            return plain(operator_ticket_info(ticket))
        if command == "notes":
            return plain(internal_notes_text(await tickets.list_internal_notes(ticket_id)))
        if command in PANEL:
            assert panel is not None
            if command == "subinfo":
                return plain(
                    format_subscription_lookup(await panel.get_subscription_for_ticket(ticket))
                )
            if command == "resolvepanel":
                ident, resolution = argument.split()
                changed = await panel.resolve_inconclusive_action(
                    ticket_id=ticket_id,
                    operator_action_id=ident,
                    operator_telegram_id=operator,
                    resolution=resolution,
                    idempotency_key=key,
                )
                return (
                    "Результат зафиксирован."
                    if changed
                    else "Операция не найдена или уже разрешена."
                )
            if command == "gift":
                result = await panel.extend_subscription_for_ticket(
                    ticket=ticket,
                    operator_telegram_id=operator,
                    idempotency_key=key,
                    extend_days=int(argument),
                )
                return plain(panel_action_reply(result))
            methods = {
                "resetkey": panel.reset_key_for_ticket,
                "revokelink": panel.revoke_subscription_link_for_ticket,
                "resetdevices": panel.reset_devices_for_ticket,
            }
            result = await methods[command](
                ticket=ticket, operator_telegram_id=operator, idempotency_key=key
            )
            return plain(panel_action_reply(result))
        if command == "note":
            await tickets.add_internal_note(
                **kwargs,
                operator_display_name=actor.display_name,
                operator_username=None,
                note=argument,
                source_chat_id=None,
                source_message_id=None,
            )
            return "Заметка добавлена."
        if command == "stop":
            await tickets.close_with_notification(**kwargs)
        elif command == "hidestop":
            await tickets.close(**kwargs)
        elif command == "block":
            await tickets.block_ticket(**kwargs)
        elif command == "unblock":
            await tickets.unblock_ticket(**kwargs)
        elif command == "closeall":
            closed = await tickets.close_all(operator_telegram_id=operator, idempotency_key=key)
            return f"Закрыто тикетов: {len(closed)}."
        elif command == "synctopics":
            queued = await tickets.queue_all_topic_reconciliations()
            return f"Тем поставлено на синхронизацию: {queued}."
        return "Команда выполнена."

    @app.post("/tickets/{ticket_id}/commands/{command}")
    async def command_execute(
        ticket_id: uuid.UUID, command: str, body: CommandBody, request: Request, actor: Actor
    ) -> dict[str, str]:
        argument = validate_arguments(command, body.arguments)
        # Recheck the live session and membership before reserving a mutation.
        actor = await auth.session_account(request)
        if command not in {item["name"] for item in await available(actor)}:
            raise HTTPException(403, "Команда недоступна в этом проекте.")
        await tickets.get_ticket(str(ticket_id))
        try:
            token = str(uuid.UUID(request.headers.get("x-idempotency-key", "")))
        except ValueError as error:
            raise HTTPException(422, "Нужен ключ команды.") from error
        key = f"console-command:{actor.id}:{token}"
        signature = {
            "account_id": actor.id,
            "ticket_id": str(ticket_id),
            "command": command,
            "arguments": argument,
        }
        if command in READ:
            return {
                "status": "completed",
                "message": await perform(actor, str(ticket_id), command, argument, key),
            }
        # Reserve durably BEFORE invoking a service. A crash cannot lead a retry to
        # run the mutation again. An unfinished receipt is explicitly uncertain.
        async with database.session() as session:
            await session.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": key}
            )
            previous = await session.scalar(
                select(OperatorAction).where(OperatorAction.idempotency_key == key)
            )
            if previous:
                if previous.payload.get("request") != signature:
                    raise HTTPException(409, "Ключ уже использован для другой команды.")
                return previous.payload.get("response") or {
                    "status": "unknown",
                    "message": (
                        "Команда выполняется или её результат неизвестен. "
                        "Проверьте состояние перед новой операцией; "
                        "повторный запрос не выполняет её заново."
                    ),
                }
            receipt = OperatorAction(
                ticket_id=str(ticket_id),
                operator_telegram_id=actor.telegram_id or 0,
                action="console_command",
                idempotency_key=key,
                payload={"request": signature},
                result="started",
            )
            session.add(receipt)
            await session.commit()
        # An unexpected exception deliberately leaves the receipt unfinished.
        message = await perform(actor, str(ticket_id), command, argument, key + ":action")
        response = {"status": "completed", "message": message}
        async with database.session() as session:
            stored = await session.scalar(
                select(OperatorAction)
                .where(OperatorAction.idempotency_key == key)
                .with_for_update()
            )
            assert stored is not None
            stored.payload = {"request": signature, "response": response}
            stored.result = "completed"
            await session.commit()
        return response
