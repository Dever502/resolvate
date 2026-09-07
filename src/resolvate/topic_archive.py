from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from typing import Any, cast

from sqlalchemy import exists, func, or_, select
from sqlalchemy.dialects.postgresql import insert

from resolvate.archive_media_policy import unavailable_media
from resolvate.config import Settings
from resolvate.database import Database
from resolvate.models import (
    CustomerSummary,
    DeliveryOutbox,
    DeliveryStatus,
    InboundUpdate,
    OperationalNotice,
    ReconciliationOutbox,
    Ticket,
    TicketStatus,
    TopicArchive,
    TranscriptMedia,
    TranscriptMessage,
    UserIdentity,
    WorkStatus,
    utcnow,
)
from resolvate.operational_notices import EVENT_NOTICE_KEYS
from resolvate.rotation_gate import SWITCHING_STATES, ingress_matches_archive, lock_rotation_gate


class TopicSwitchingError(RuntimeError):
    """Delivery must remain durable until the physical topic switch finishes."""


class TopicArchiveRepository:
    def __init__(self, database: Database, settings: Settings) -> None:
        self.database = database
        self.settings = settings
        self.prepare_media: Callable[[str], Awaitable[bool]] | None = None
        # Single runtime process: serialize short journal/file publication decisions.
        self.media_lock = asyncio.Lock()

    async def source_message(self, chat_id: int, message_id: int) -> dict[str, Any] | None:
        async with self.database.session() as session:
            recorded = await session.scalar(
                select(TranscriptMessage.payload)
                .join(TopicArchive, TopicArchive.id == TranscriptMessage.archive_id)
                .where(TopicArchive.chat_id == chat_id, TranscriptMessage.message_id == message_id)
                .order_by(TranscriptMessage.id.desc())
                .limit(1)
            )
            if recorded is not None:
                return cast(dict[str, Any], recorded)
            needle = {"chat": {"id": chat_id}, "message_id": message_id}
            update = await session.scalar(
                select(InboundUpdate)
                .where(
                    or_(
                        InboundUpdate.payload.contains({"message": needle}),
                        InboundUpdate.payload.contains({"edited_message": needle}),
                    )
                )
                .order_by(InboundUpdate.telegram_update_id.desc())
                .limit(1)
            )
            if update is None:
                return None
            return cast(
                dict[str, Any], update.payload.get("edited_message") or update.payload["message"]
            )

    async def begin_write(self, topic_id: int) -> str | None:
        async with self.database.session() as session:
            archive = await session.scalar(
                select(TopicArchive)
                .where(
                    TopicArchive.chat_id == self.settings.support_group_id,
                    TopicArchive.topic_id == topic_id,
                )
                .with_for_update()
            )
            if archive is None:
                return None
            if (
                archive.state in SWITCHING_STATES
                or archive.state in {"archived", "archived_pending"}
                or (archive.state == "retiring" and archive.mode != "evict")
            ):
                raise TopicSwitchingError("topic delivery is temporarily suspended")
            archive.pending_writes += 1
            await session.commit()
            return archive.id

    async def publication_topic(self, topic_id: int) -> int:
        """Route late bot replies to the current generation, never to a retired topic."""
        async with self.database.session() as session:
            archive = await session.scalar(
                select(TopicArchive).where(
                    TopicArchive.chat_id == self.settings.support_group_id,
                    TopicArchive.topic_id == topic_id,
                )
            )
            if archive is None:
                return topic_id
            if archive.state in SWITCHING_STATES:
                raise TopicSwitchingError("topic delivery is temporarily suspended")
            if archive.state not in {"retiring", "archived", "archived_pending"}:
                return topic_id
            ticket = await session.get(Ticket, archive.ticket_id)
            if ticket is not None and ticket.topic_id is not None and ticket.topic_id != topic_id:
                return ticket.topic_id
            if archive.state == "retiring" and archive.mode == "evict":
                return topic_id
            raise TopicSwitchingError("replacement topic is not ready")

    async def finish_write(self, archive_id: str, *, complete: bool = True) -> None:
        async with self.database.session() as session:
            archive = await session.get(TopicArchive, archive_id, with_for_update=True)
            if archive is None or archive.pending_writes <= 0:
                raise RuntimeError("topic write has no durable reservation")
            archive.pending_writes -= 1
            if not complete:
                archive.complete = False
            await session.commit()

    async def register_topic(self, *, ticket_id: str, topic_id: int, complete: bool = False) -> str:
        async with self.database.session() as session:
            await session.execute(
                insert(TopicArchive)
                .values(
                    ticket_id=ticket_id,
                    chat_id=self.settings.support_group_id,
                    topic_id=topic_id,
                    complete=complete,
                )
                .on_conflict_do_nothing(constraint="uq_topic_archives_telegram")
            )
            archive = await session.scalar(
                select(TopicArchive).where(
                    TopicArchive.chat_id == self.settings.support_group_id,
                    TopicArchive.topic_id == topic_id,
                )
            )
            assert archive is not None
            if archive.ticket_id != ticket_id:
                raise ValueError("topic archive belongs to another ticket")
            await session.commit()
            return archive.id

    async def topic(self, topic_id: int) -> TopicArchive | None:
        async with self.database.session() as session:
            return cast(
                TopicArchive | None,
                await session.scalar(
                    select(TopicArchive).where(
                        TopicArchive.chat_id == self.settings.support_group_id,
                        TopicArchive.topic_id == topic_id,
                    )
                ),
            )

    async def observe(
        self,
        *,
        topic_id: int,
        message_id: int,
        payload: dict[str, Any],
        attachment: dict[str, Any] | None = None,
    ) -> bool:
        """Record once by physical message ID; edits advance revision, not the count."""
        async with self.media_lock, self.database.session() as session:
            archive = await session.scalar(
                select(TopicArchive)
                .where(
                    TopicArchive.chat_id == self.settings.support_group_id,
                    TopicArchive.topic_id == topic_id,
                )
                .with_for_update()
            )
            if archive is None:
                return False
            if (
                archive.state == "archived"
                and archive.archived_at is not None
                and archive.archived_at
                <= utcnow() - timedelta(days=self.settings.archive_retention_days)
            ):
                # A delayed edit must not recreate an expired transcript.
                return False
            old = await session.scalar(
                select(TranscriptMessage).where(
                    TranscriptMessage.archive_id == archive.id,
                    TranscriptMessage.message_id == message_id,
                )
            )
            if old is not None and old.payload == payload:
                return False
            media_id: str | None = None
            if attachment and isinstance(attachment.get("file_id"), str):
                unique = attachment.get("file_unique_id")
                if not isinstance(unique, str) or not unique:
                    # Do not certify a transcript if its attachment cannot be identified.
                    archive.complete = False
                else:
                    proposed_id = str(uuid.uuid4())
                    await session.execute(
                        insert(TranscriptMedia)
                        .values(
                            id=proposed_id,
                            file_unique_id=unique,
                            file_id=attachment["file_id"],
                            kind=str(attachment.get("telegram_content_type", "document")),
                            filename=str(attachment["file_name"])[:255]
                            if attachment.get("file_name")
                            else None,
                            declared_size=attachment.get("file_size"),
                        )
                        .on_conflict_do_update(
                            index_elements=[TranscriptMedia.file_unique_id],
                            set_={"file_id": attachment["file_id"]},
                        )
                    )
                    media_id = await session.scalar(
                        select(TranscriptMedia.id).where(TranscriptMedia.file_unique_id == unique)
                    )
            now = utcnow()
            if old is None:
                session.add(
                    TranscriptMessage(
                        archive_id=archive.id,
                        message_id=message_id,
                        payload=payload,
                        media_id=media_id,
                        observed_at=now,
                    )
                )
                archive.message_count += 1
            else:
                # Old edits cannot overwrite a newer Telegram edit.
                old_edit = old.payload.get("edit_date", old.payload.get("date", 0))
                new_edit = payload.get("edit_date", payload.get("date", 0))
                if str(new_edit) < str(old_edit):
                    return False
                old.payload = payload
                old.media_id = media_id
                old.observed_at = now
            archive.revision += 1
            archive.last_observed_at = now
            if archive.state in {"archived", "archived_pending"} and media_id is not None:
                archive.state = "archived_pending"
                archive.next_attempt_at = now
            await session.commit()
            return True

    async def transcript(
        self, archive_id: str, *, after: int = 0, limit: int = 100
    ) -> list[TranscriptMessage]:
        if not 1 <= limit <= 1000:
            raise ValueError("transcript page size must be between 1 and 1000")
        async with self.database.session() as session:
            return list(
                (
                    await session.scalars(
                        select(TranscriptMessage)
                        .where(
                            TranscriptMessage.archive_id == archive_id,
                            TranscriptMessage.message_id > after,
                        )
                        .order_by(TranscriptMessage.message_id)
                        .limit(limit)
                    )
                ).all()
            )

    async def media_ready(self, archive_id: str) -> bool:
        async with self.database.session() as session:
            missing = await session.scalar(
                select(TranscriptMessage.id)
                .join(TranscriptMedia, TranscriptMedia.id == TranscriptMessage.media_id)
                .where(
                    TranscriptMessage.archive_id == archive_id,
                    unavailable_media(),
                )
                .limit(1)
            )
            return missing is None

    async def notice(
        self, key: str, message: str, *, severity: str = "warning", active: bool = True
    ) -> None:
        now = utcnow()
        async with self.database.session() as session:
            await session.execute(
                insert(OperationalNotice)
                .values(key=key, text=message, severity=severity, active=active)
                .on_conflict_do_nothing(index_elements=[OperationalNotice.key])
            )
            current = await session.get(OperationalNotice, key, with_for_update=True)
            assert current is not None
            if current.severity != severity or current.active != active:
                current.next_delivery_at = now
                if key in EVENT_NOTICE_KEYS and current.delivered_at is not None:
                    current.next_delivery_at = max(now, current.delivered_at + timedelta(hours=1))
            current.text = message
            current.active = active
            current.severity = severity
            current.updated_at = now
            await session.commit()

    async def has_history(self, ticket_id: str) -> bool:
        async with self.database.session() as session:
            return bool(
                await session.scalar(
                    select(
                        exists().where(
                            TopicArchive.ticket_id == ticket_id,
                            TopicArchive.state.in_(("retiring", "archived", "archived_pending")),
                        )
                    )
                )
            )

    async def count_topics(self) -> int:
        async with self.database.session() as session:
            # Include untracked legacy topics and detached topics awaiting confirmed deletion.
            current = select(Ticket.topic_id).where(Ticket.topic_id.is_not(None))
            retiring = select(TopicArchive.topic_id).where(
                TopicArchive.state.not_in(("archived", "archived_pending")),
                TopicArchive.chat_id == self.settings.support_group_id,
            )
            unknown_creations = int(
                await session.scalar(
                    select(func.count())
                    .select_from(TopicArchive)
                    .where(
                        TopicArchive.chat_id == self.settings.support_group_id,
                        TopicArchive.state.in_(("creating", "uncertain")),
                        TopicArchive.replacement_token.is_not(None),
                        TopicArchive.replacement_topic_id.is_(None),
                    )
                )
                or 0
            )
            return unknown_creations + int(
                await session.scalar(
                    select(func.count()).select_from(current.union(retiring).subquery())
                )
                or 0
            )

    async def candidates(self, *, capacity: bool, now: datetime | None = None) -> list[str]:
        cutoff = (now or utcnow()) - timedelta(seconds=self.settings.topic_rotation_delay_seconds)
        async with self.database.session() as session:
            query = (
                select(TopicArchive.id)
                .join(Ticket, Ticket.id == TopicArchive.ticket_id)
                .where(
                    TopicArchive.topic_id == Ticket.topic_id,
                    TopicArchive.chat_id == self.settings.support_group_id,
                    TopicArchive.state == "live",
                    TopicArchive.complete.is_(True),
                    TopicArchive.next_attempt_at <= (now or utcnow()),
                    Ticket.status == TicketStatus.CLOSED,
                    Ticket.closed_at <= cutoff,
                )
                .order_by(Ticket.last_activity_at, TopicArchive.id)
                .limit(20)
            )
            if not capacity:
                query = query.where(
                    TopicArchive.message_count > self.settings.rotation_message_limit
                )
            return list((await session.scalars(query)).all())

    async def prepare(self, archive_id: str, *, capacity: bool) -> TopicArchive | None:
        async with self.database.session() as session:
            archive = await session.get(TopicArchive, archive_id, with_for_update=True)
            if archive is None or archive.state != "live" or not archive.complete:
                return None
            ticket = await session.get(Ticket, archive.ticket_id, with_for_update=True)
            if not self._closed(ticket) or ticket is None or ticket.topic_id != archive.topic_id:
                return None
            archive.state = "preparing"
            archive.mode = "evict" if capacity else "replace"
            archive.prepared_revision = archive.revision
            archive.prepared_close_cycle = ticket.close_cycle
            await session.commit()
            return archive

    def _closed(self, ticket: Ticket | None) -> bool:
        return bool(
            ticket is not None
            and ticket.status == TicketStatus.CLOSED
            and ticket.closed_at is not None
            and ticket.closed_at
            <= utcnow() - timedelta(seconds=self.settings.topic_rotation_delay_seconds)
        )

    async def defer(self, archive_id: str, *, reason: str | None = None, seconds: int = 0) -> None:
        async with self.database.session() as session:
            archive = await session.get(TopicArchive, archive_id, with_for_update=True)
            if archive is not None and archive.state == "preparing":
                archive.state = "live"
                archive.error_code = reason
                archive.next_attempt_at = utcnow() + timedelta(seconds=seconds)
                await session.commit()

    async def begin_switch(self, archive_id: str) -> bool:
        """Prepare the cutover barrier under a ticket row lock.

        Before a runtime worker can use this, delivery/ingress claims must share
        the advisory gate and exclude switching topics. No rotation worker is
        enabled until that integration is complete.
        """
        if self.prepare_media is not None and not await self.prepare_media(archive_id):
            await self.defer(archive_id, reason="media_unavailable", seconds=900)
            return False
        async with self.database.session() as session:
            await lock_rotation_gate(session)
            archive = await session.get(TopicArchive, archive_id, with_for_update=True)
            if archive is None or archive.state != "preparing":
                return False
            ticket = await session.get(Ticket, archive.ticket_id, with_for_update=True)
            if (
                not self._closed(ticket)
                or ticket is None
                or ticket.topic_id != archive.topic_id
                or ticket.close_cycle != archive.prepared_close_cycle
                or archive.revision != archive.prepared_revision
                or archive.pending_writes != 0
            ):
                archive.state = "live"
                await session.commit()
                return False
            unfinished = await session.scalar(
                select(
                    exists().where(
                        DeliveryOutbox.ticket_id == archive.ticket_id,
                        DeliveryOutbox.status.in_(
                            (
                                DeliveryStatus.PENDING,
                                DeliveryStatus.PROCESSING,
                                DeliveryStatus.WAITING_TOPIC,
                            )
                        ),
                    )
                )
            )
            inbound = await session.scalar(
                select(
                    exists(
                        select(InboundUpdate.telegram_update_id)
                        .select_from(TopicArchive)
                        .join(Ticket, Ticket.id == TopicArchive.ticket_id)
                        .outerjoin(
                            UserIdentity,
                            (UserIdentity.user_id == Ticket.user_id)
                            & (UserIdentity.provider == "telegram"),
                        )
                        .join(InboundUpdate, ingress_matches_archive(InboundUpdate.ordering_key))
                        .where(
                            TopicArchive.id == archive.id,
                            InboundUpdate.status.in_((WorkStatus.PENDING, WorkStatus.PROCESSING)),
                        )
                    )
                )
            )
            reconciling = await session.scalar(
                select(
                    exists().where(
                        ReconciliationOutbox.ticket_id == archive.ticket_id,
                        ReconciliationOutbox.status == WorkStatus.PROCESSING,
                    )
                )
            )
            if unfinished or inbound or reconciling:
                return False
            if self.settings.ai_enabled:
                summary = await session.get(CustomerSummary, archive.ticket_id)
                if (
                    summary is None
                    or summary.through_archive_id != archive.id
                    or summary.through_revision != archive.revision
                ):
                    return False
            if await session.scalar(
                select(
                    exists().where(
                        TranscriptMessage.archive_id == archive.id,
                        TranscriptMessage.media_id == TranscriptMedia.id,
                        unavailable_media(),
                    )
                )
            ):
                return False
            archive.state = "switching"
            await session.commit()
            return True
