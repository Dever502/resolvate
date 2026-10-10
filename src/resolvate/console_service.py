from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

from fastapi import HTTPException
from sqlalchemy import case, func, literal_column, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import load_only

from resolvate.config import Settings
from resolvate.database import Database
from resolvate.durable_work import enqueue_topic_reconciliation
from resolvate.media_storage import StoredMedia
from resolvate.models import (
    ConsoleAccount,
    ConsoleRead,
    ConsoleSend,
    DeliveryOutbox,
    DeliveryStatus,
    Direction,
    OperatorAction,
    Ticket,
    TicketChannel,
    TicketMessage,
    TicketStatus,
    User,
    UserIdentity,
    utcnow,
)
from resolvate.rotation_gate import lock_rotation_gate
from resolvate.services import TicketService
from resolvate.system_messages import operator_system_text, rating_data, rating_text
from resolvate.topic_messages import topic_deliveries
from resolvate.web_models import MediaAsset, TicketLifecycleEvent
from resolvate.web_support_service import decode_cursor, encode_cursor
from resolvate.work_retention import delivery_recovery_expired


def fingerprint(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def delta(items: list[dict[str, Any]], known: dict[str, str]) -> dict[str, Any]:
    for item in items:
        item["revision"] = fingerprint(item)
    return {
        "order": [item["id"] for item in items],
        "items": [item for item in items if known.get(item["id"]) != item["revision"]],
    }


class ConsoleService:
    def __init__(self, database: Database, tickets: TicketService, settings: Settings) -> None:
        self.database, self.tickets, self.settings = database, tickets, settings

    async def list_tickets(
        self,
        account: ConsoleAccount,
        *,
        archived: bool,
        query: str,
        limit: int,
        offset: int,
        folder_id: str | None = None,
        unfiled: bool = False,
    ) -> list[dict[str, Any]]:
        unread = (
            select(func.count())
            .select_from(TicketMessage)
            .where(
                TicketMessage.ticket_id == Ticket.id,
                TicketMessage.direction == literal_column("'user_to_operator'"),
                TicketMessage.suppressed.is_(False),
                # Join the receipt once per ticket, not once per historical message.
                # The partial covering index avoids fetching message bodies to count.
                TicketMessage.created_at
                > func.coalesce(ConsoleRead.through_at, literal_column("'-infinity'::timestamptz")),
            )
            .correlate(Ticket, ConsoleRead)
            .scalar_subquery()
        )
        latest = (
            select(
                case(
                    (TicketMessage.channel == "rating", "⭐ Оценка поддержки"),
                    (TicketMessage.channel == "system", "Системное уведомление"),
                    else_=TicketMessage.content,
                )
            )
            .where(
                TicketMessage.ticket_id == Ticket.id,
                TicketMessage.suppressed.is_(False),
            )
            .order_by(TicketMessage.created_at.desc(), TicketMessage.id.desc())
            .limit(1)
        )
        page = (
            select(Ticket.id)
            .join(User)
            .where(
                # Fixed predicates let PostgreSQL use partial indexes even with a
                # generic prepared plan. No user input is interpolated here.
                Ticket.status == literal_column("'closed'")
                if archived
                else Ticket.status != literal_column("'closed'")
            )
        )
        if folder_id:
            page = page.where(Ticket.folder_id == folder_id)
        elif unfiled:
            page = page.where(Ticket.folder_id.is_(None))
        if query:
            pattern = (
                "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            )
            identities = select(UserIdentity.user_id).where(
                UserIdentity.external_id.ilike(pattern, escape="\\")
            )
            page = page.where(
                or_(
                    User.display_name.ilike(pattern, escape="\\"),
                    User.username.ilike(pattern, escape="\\"),
                    User.email.ilike(pattern, escape="\\"),
                    Ticket.id == query,
                    Ticket.user_id.in_(identities),
                )
            )
        # Select the page before evaluating history subqueries; OFFSET must not
        # count unread messages or read previews of every skipped ticket.
        page_ids = (
            page.order_by(Ticket.last_activity_at.desc(), Ticket.id.desc())
            .offset(offset)
            .limit(limit)
            .cte("ticket_page")
        )
        statement = (
            select(Ticket, User, unread.label("unread"), latest.scalar_subquery())
            .join(page_ids, page_ids.c.id == Ticket.id)
            .join(User)
            .outerjoin(
                ConsoleRead,
                (ConsoleRead.ticket_id == Ticket.id) & (ConsoleRead.account_id == account.id),
            )
            .order_by(Ticket.last_activity_at.desc(), Ticket.id.desc())
        )
        async with self.database.session() as session:
            rows = (await session.execute(statement)).all()
        return [
            {
                "id": ticket.id,
                "name": user.display_name or user.username or "Клиент",
                "channel": ticket.channel,
                "status": ticket.status,
                "time": ticket.last_activity_at.isoformat(),
                "preview": (preview or "Вложение")[:180],
                "unread": count,
                "folder_id": ticket.folder_id,
                "folder_revision": ticket.folder_revision,
            }
            for ticket, user, count, preview in rows
        ]

    async def messages(
        self, ticket_id: str, *, known: dict[str, str], before: str | None = None
    ) -> dict[str, Any]:
        ticket = await self.tickets.get_ticket(ticket_id)
        base = select(TicketMessage).where(
            TicketMessage.ticket_id == ticket_id, TicketMessage.suppressed.is_(False)
        )
        page = base
        reset = False
        if before:
            try:
                at, ident = decode_cursor(before)
            except ValueError as error:
                raise HTTPException(422, "Неверная страница истории.") from error
            page = page.where(
                or_(
                    TicketMessage.created_at < at,
                    (TicketMessage.created_at == at) & (TicketMessage.id < ident),
                )
            )
        async with self.database.session() as session:
            rows = list(
                (
                    await session.scalars(
                        page.order_by(
                            TicketMessage.created_at.desc(), TicketMessage.id.desc()
                        ).limit(51)
                    )
                ).all()
            )
            older = len(rows) == 51
            rows = rows[:50]
            cursor = encode_cursor(rows[-1].created_at, rows[-1].id) if rows else None
            if known and not before:
                first = (
                    await session.execute(
                        base.with_only_columns(TicketMessage.created_at, TicketMessage.id)
                        .where(TicketMessage.id.in_(known))
                        .order_by(TicketMessage.created_at, TicketMessage.id)
                        .limit(1)
                    )
                ).first()
                if first is not None:
                    window = list(
                        (
                            await session.scalars(
                                base.where(
                                    or_(
                                        TicketMessage.created_at > first.created_at,
                                        (TicketMessage.created_at == first.created_at)
                                        & (TicketMessage.id >= first.id),
                                    )
                                )
                                .order_by(TicketMessage.created_at, TicketMessage.id)
                                .limit(5001)
                            )
                        ).all()
                    )
                    if len(window) <= 5000:
                        rows = window
                    else:
                        # A long-disconnected tab starts a fresh contiguous page instead of
                        # silently omitting messages between the old and new windows.
                        reset = True
            rows.sort(key=lambda item: (item.created_at, item.id))
            commands = (
                list(
                    (
                        await session.execute(
                            select(
                                ConsoleSend.id,
                                ConsoleSend.message_id,
                                func.jsonb_path_query_array(
                                    ConsoleSend.deliveries,
                                    literal_column("'$.keyvalue().key'::jsonpath"),
                                ).label("deliveries"),
                            ).where(ConsoleSend.message_id.in_([row.id for row in rows]))
                        )
                    ).all()
                )
                if rows
                else []
            )
            ids = [ident for command in commands for ident in command.deliveries]
            deliveries = (
                {
                    item.id: item
                    for item in (
                        await session.scalars(
                            select(DeliveryOutbox)
                            .options(
                                load_only(
                                    DeliveryOutbox.id,
                                    DeliveryOutbox.status,
                                    DeliveryOutbox.last_error,
                                )
                            )
                            .where(DeliveryOutbox.id.in_(ids))
                        )
                    ).all()
                }
                if ids
                else {}
            )
        command_by_message = {item.message_id: item for item in commands}
        items: list[dict[str, Any]] = []
        for row in rows:
            media = row.media or {}
            system = row.channel in {"system", "rating"} or bool(media.get("system_event"))
            content = row.content or ""
            rating = None
            if row.channel == "rating" and media.get("rating") in range(1, 6):
                rating = media.get("rating_details") or rating_data(ticket, int(media["rating"]))
                # Routing always uses the authorized ticket, never an embedded metadata ID.
                rating = {**rating, "ticket_id": ticket_id, "score": int(media["rating"])}
                content = rating_text(rating)
            elif row.channel == "system":
                content = operator_system_text(content, media)
            command = command_by_message.get(row.id)
            failed: list[str] = []
            uncertain = False
            if command:
                for ident in command.deliveries:
                    job = deliveries.get(ident)
                    if job and job.status == DeliveryStatus.FAILED:
                        uncertain |= job.last_error == "outcome_unknown"
                        if job.last_error != "outcome_unknown":
                            failed.append(ident)
            items.append(
                {
                    "id": row.id,
                    "direction": row.direction,
                    "channel": row.channel,
                    "text": content,
                    "system": system,
                    "rating": rating,
                    "time": row.created_at.isoformat(),
                    "author": "Система"
                    if system
                    else media.get("operator_name")
                    or (
                        "Оператор (Telegram)"
                        if row.direction == Direction.OPERATOR_TO_USER
                        else "Клиент"
                    ),
                    "media_id": media.get("media_id"),
                    "mime": media.get("mime_type"),
                    "sticker": media.get("telegram_content_type") == "sticker",
                    "sticker_emoji": media.get("emoji")
                    if media.get("telegram_content_type") == "sticker"
                    else None,
                    "attachment": bool(media.get("media_id") or media.get("file_id")),
                    "failed": failed,
                    "uncertain": uncertain,
                    "command": command.id if command else None,
                }
            )
        result = delta(items, known)
        present = set(result["order"])
        result.update(
            {
                "before": cursor,
                "reset": reset,
                "has_older": older,
                "removed": [ident for ident in known if ident not in present],
            }
        )
        return result

    async def mark_read(self, account: ConsoleAccount, ticket_id: str, message_id: str) -> None:
        async with self.database.session() as session:
            at = await session.scalar(
                select(TicketMessage.created_at).where(
                    TicketMessage.id == message_id,
                    TicketMessage.ticket_id == ticket_id,
                    TicketMessage.suppressed.is_(False),
                )
            )
            if at is None:
                raise HTTPException(404, "Сообщение не найдено.")
            statement = insert(ConsoleRead).values(
                account_id=account.id, ticket_id=ticket_id, through_at=at
            )
            await session.execute(
                statement.on_conflict_do_update(
                    index_elements=[ConsoleRead.account_id, ConsoleRead.ticket_id],
                    set_={"through_at": func.greatest(ConsoleRead.through_at, at)},
                )
            )
            await session.commit()

    async def send(
        self,
        account: ConsoleAccount,
        ticket_id: str,
        *,
        key: str,
        content: str,
        media: StoredMedia | None = None,
    ) -> str:
        signature = fingerprint(
            {"ticket": ticket_id, "text": content, "file": media.sha256 if media else None}
        )
        async with self.database.session() as session:
            # Same short barrier as ingress/cutover. Never hold it during upload or HTTP.
            await lock_rotation_gate(session)
            ticket = await session.scalar(
                select(Ticket).where(Ticket.id == ticket_id).with_for_update()
            )
            if ticket is None:
                raise HTTPException(404, "Диалог не найден.")
            previous = await session.get(ConsoleSend, key)
            if previous:
                if previous.account_id != account.id or previous.fingerprint != signature:
                    raise HTTPException(409, "Ключ отправки уже использован.")
                return previous.message_id
            if await self.tickets._is_ticket_blocked_in_session(session, ticket_id):
                raise HTTPException(409, "Клиент заблокирован.")
            view = await self.tickets._ticket_view(session, ticket)
            now = utcnow()
            if ticket.status == TicketStatus.CLOSED:
                ticket.status = TicketStatus.OPEN if ticket.topic_id else TicketStatus.PROVISIONING
                ticket.closed_at = None
                session.add(
                    TicketLifecycleEvent(
                        ticket_id=ticket.id,
                        event_type="reopened",
                        channel=ticket.channel,
                        close_cycle=ticket.close_cycle,
                        created_at=now,
                    )
                )
            ticket.last_activity_at = now
            await enqueue_topic_reconciliation(
                session, ticket_id=ticket.id, desired_status=TicketStatus.OPEN.value
            )
            metadata = media.message_metadata() if media else {}
            metadata.update(
                {"operator_name": account.display_name, "operator_account_id": account.id}
            )
            message = TicketMessage(
                id=str(uuid.uuid4()),
                ticket_id=ticket_id,
                direction=Direction.OPERATOR_TO_USER,
                channel=("web" if ticket.channel == "web" else "console"),
                content=content or None,
                media=metadata,
                created_at=now,
            )
            session.add(message)
            await session.flush()
            if media:
                session.add(
                    MediaAsset(
                        id=media.id,
                        ticket_id=ticket_id,
                        message_id=message.id,
                        storage_path=media.storage_path,
                        mime_type=media.mime_type,
                        size_bytes=media.size_bytes,
                        sha256=media.sha256,
                        original_filename=media.original_filename,
                    )
                )
            payload: dict[str, Any] = {
                "canonical_message_id": message.id,
                "kind": media.delivery_kind if media else "send_text",
                "text": content or None,
                "console_command": key,
            }
            if media:
                payload["storage_path"] = media.storage_path
            jobs: dict[str, Any] = {}
            if ticket.channel == TicketChannel.TELEGRAM:
                if view.telegram_user_id is None:
                    raise HTTPException(409, "Не найдена Telegram-привязка клиента.")
                ident = str(uuid.uuid4())
                customer = {**payload, "target_chat_id": view.telegram_user_id}
                session.add(
                    DeliveryOutbox(
                        id=ident,
                        ticket_id=ticket_id,
                        direction=Direction.OPERATOR_TO_USER,
                        idempotency_key=f"console:{key}:customer",
                        payload=customer,
                        created_at=now,
                    )
                )
                jobs[ident] = customer
            mirror = {
                **payload,
                "target_chat_id": self.settings.support_group_id,
                "target_thread_id": ticket.topic_id,
            }
            for entry in topic_deliveries(
                ticket_id=ticket_id,
                key=f"console:{key}:mirror",
                payload=mirror,
                content=content,
                author=account.display_name,
                operator=True,
            ):
                session.add(entry)
                jobs[entry.id] = entry.payload
            session.add(
                ConsoleSend(
                    id=key,
                    account_id=account.id,
                    message_id=message.id,
                    fingerprint=signature,
                    deliveries=jobs,
                )
            )
            session.add(
                OperatorAction(
                    ticket_id=ticket_id,
                    operator_telegram_id=0,
                    action="console_send",
                    idempotency_key=f"console:{key}",
                    payload={"account_id": account.id},
                    result="completed",
                )
            )
            await session.commit()
            return message.id

    async def retry(self, key: str, delivery_id: str) -> None:
        async with self.database.session() as session:
            await lock_rotation_gate(session)
            command = await session.get(ConsoleSend, key)
            job = await session.scalar(
                select(DeliveryOutbox).where(DeliveryOutbox.id == delivery_id).with_for_update()
            )
            if not command or not job or delivery_id not in command.deliveries:
                raise HTTPException(404, "Отправка не найдена.")
            if job.status != DeliveryStatus.FAILED:
                return
            if delivery_recovery_expired(job, utcnow()):
                raise HTTPException(410, "Срок повторной отправки истёк (30 дней).")
            if job.last_error == "outcome_unknown":
                raise HTTPException(409, "Результат неизвестен. Сначала проверьте Telegram.")
            payload = dict(command.deliveries[delivery_id])
            ticket = await session.get(Ticket, job.ticket_id)
            assert ticket is not None
            if job.direction == Direction.USER_TO_OPERATOR:
                payload["target_thread_id"] = ticket.topic_id
            job.payload = payload
            job.status = (
                DeliveryStatus.WAITING_TOPIC
                if job.direction == Direction.USER_TO_OPERATOR and not ticket.topic_id
                else DeliveryStatus.PENDING
            )
            job.attempt_count = 0
            job.last_error = None
            job.next_attempt_at = utcnow()
            await session.commit()
