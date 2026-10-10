from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import exists, select
from sqlalchemy.dialects.postgresql import insert

from resolvate.models import (
    DeliveryOutbox,
    DeliveryStatus,
    Direction,
    InboundUpdate,
    Ticket,
    TicketStatus,
    TopicArchive,
    UserIdentity,
    WorkStatus,
    utcnow,
)
from resolvate.rotation_gate import ingress_matches_archive, lock_rotation_gate
from resolvate.topic_archive import TopicArchiveRepository
from resolvate.work_retention import work_protects_archive


class TopicRotationRepository:
    def __init__(self, archives: TopicArchiveRepository) -> None:
        self.archives = archives
        self.database = archives.database

    async def get(self, archive_id: str) -> TopicArchive | None:
        async with self.database.session() as session:
            return await session.get(TopicArchive, archive_id)

    async def pending(self) -> list[str]:
        async with self.database.session() as session:
            return list(
                (
                    await session.scalars(
                        select(TopicArchive.id)
                        .where(
                            TopicArchive.state.in_(
                                (
                                    "preparing",
                                    "switching",
                                    "installing",
                                    "retiring",
                                    "evicting",
                                    "deleting",
                                    "archived_pending",
                                )
                            ),
                            TopicArchive.next_attempt_at <= utcnow(),
                        )
                        .order_by(TopicArchive.created_at)
                        .limit(20)
                    )
                ).all()
            )

    async def transition(
        self,
        archive_id: str,
        expected: str,
        state: str,
        *,
        delay: int = 0,
        error: str | None = None,
        revision: int | None = None,
    ) -> bool:
        async with self.database.session() as session:
            await lock_rotation_gate(session)
            archive = await session.get(TopicArchive, archive_id, with_for_update=True)
            if (
                archive is None
                or archive.state != expected
                or (revision is not None and archive.revision != revision)
            ):
                return False
            archive.state = state
            archive.error_code = error
            archive.next_attempt_at = utcnow() + timedelta(seconds=delay)
            await session.commit()
            return True

    async def claim_creation(self, archive_id: str) -> str | None:
        async with self.database.session() as session:
            await lock_rotation_gate(session)
            archive = await session.get(TopicArchive, archive_id, with_for_update=True)
            if archive is None or archive.state != "switching":
                return None
            archive.state = "creating"
            archive.replacement_token = str(uuid.uuid4())
            await session.commit()
            return archive.replacement_token

    async def created(self, archive_id: str, token: str, topic_id: int) -> bool:
        async with self.database.session() as session:
            await lock_rotation_gate(session)
            archive = await session.get(TopicArchive, archive_id, with_for_update=True)
            if archive is None or archive.state != "creating" or archive.replacement_token != token:
                return False
            archive.replacement_topic_id = topic_id
            archive.state = "installing"
            session.add(
                TopicArchive(
                    ticket_id=archive.ticket_id,
                    chat_id=archive.chat_id,
                    topic_id=topic_id,
                    complete=True,
                )
            )
            await session.commit()
            return True

    async def setup_sent(self, archive_id: str, message_id: int) -> None:
        async with self.database.session() as session:
            archive = await session.get(TopicArchive, archive_id, with_for_update=True)
            if archive is None or archive.state != "installing":
                raise RuntimeError("rotation setup no longer owns its topic")
            archive.setup_message_id = message_id
            await session.commit()

    async def publish(self, archive_id: str) -> bool:
        async with self.database.session() as session:
            await lock_rotation_gate(session)
            archive = await session.get(TopicArchive, archive_id, with_for_update=True)
            if (
                archive is None
                or archive.state != "installing"
                or archive.replacement_topic_id is None
                or archive.setup_message_id is None
            ):
                return False
            ticket = await session.get(Ticket, archive.ticket_id, with_for_update=True)
            if ticket is None or ticket.topic_id != archive.topic_id:
                return False
            deliveries = list(
                (
                    await session.scalars(
                        select(DeliveryOutbox).where(
                            DeliveryOutbox.ticket_id == ticket.id,
                            work_protects_archive(DeliveryOutbox),
                        )
                    )
                ).all()
            )
            if any(row.status == DeliveryStatus.PROCESSING for row in deliveries):
                return False
            ticket.topic_id = archive.replacement_topic_id
            for row in deliveries:
                if (
                    row.direction == Direction.USER_TO_OPERATOR
                    and row.payload.get("target_thread_id") in (None, archive.topic_id)
                    and not row.payload.get("target_system_topic")
                ):
                    row.payload = {**row.payload, "target_thread_id": ticket.topic_id}
                    if row.status == DeliveryStatus.WAITING_TOPIC:
                        row.status = DeliveryStatus.PENDING
                        row.next_attempt_at = utcnow()
            archive.state = "retiring"
            archive.cutover_at = utcnow()
            archive.next_attempt_at = utcnow() + timedelta(seconds=30)
            await session.commit()
            return True

    async def start_eviction(self, archive_id: str) -> bool:
        async with self.database.session() as session:
            archive = await session.get(TopicArchive, archive_id, with_for_update=True)
            if archive is None or archive.state != "switching":
                return False
            archive.state = "evicting"
            archive.cutover_at = utcnow()
            archive.next_attempt_at = utcnow()
            await session.commit()
            return True

    async def redirect_eviction(self, archive_id: str) -> bool:
        """Traffic after the barrier needs a replacement, not resuming the old topic."""
        async with self.database.session() as session:
            await lock_rotation_gate(session)
            archive = await session.get(TopicArchive, archive_id, with_for_update=True)
            if archive is None or archive.state != "evicting":
                return False
            ticket = await session.get(Ticket, archive.ticket_id, with_for_update=True)
            assert ticket is not None
            incoming = await session.scalar(
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
            outgoing = await session.scalar(
                select(
                    exists().where(
                        DeliveryOutbox.ticket_id == ticket.id,
                        work_protects_archive(DeliveryOutbox),
                    )
                )
            )
            if ticket.status == TicketStatus.CLOSED and not incoming and not outgoing:
                return False
            archive.mode = "replace"
            archive.state = "switching"
            await session.commit()
            return True

    async def begin_delete(self, archive_id: str, *, revision: int) -> bool:
        """Only delete a quiescent, independently saved source without outstanding copies."""
        async with self.database.session() as session:
            await lock_rotation_gate(session)
            archive = await session.get(TopicArchive, archive_id, with_for_update=True)
            if (
                archive is None
                or archive.state not in {"retiring", "evicting"}
                or not archive.complete
                or archive.revision != revision
            ):
                return False
            ticket = await session.get(Ticket, archive.ticket_id, with_for_update=True)
            if ticket is None or archive.pending_writes:
                return False
            if archive.mode == "evict" and not self.archives._closed(ticket):
                return False
            quiet_before = utcnow() - timedelta(seconds=30)
            if (
                archive.cutover_at is None
                or archive.cutover_at > quiet_before
                or archive.last_observed_at > quiet_before
            ):
                return False
            inbound = await session.scalar(
                select(
                    exists().where(
                        InboundUpdate.ordering_key
                        == f"chat:{archive.chat_id}:thread:{archive.topic_id}",
                        InboundUpdate.status.in_((WorkStatus.PENDING, WorkStatus.PROCESSING)),
                    )
                )
            )
            copies = await session.scalar(
                select(
                    exists().where(
                        DeliveryOutbox.ticket_id == ticket.id,
                        work_protects_archive(DeliveryOutbox),
                    )
                )
            )
            if inbound or copies:
                return False
            archive.state = "deleting"
            await session.commit()
            return True

    async def deleted(self, archive_id: str) -> None:
        async with self.database.session() as session:
            await lock_rotation_gate(session)
            archive = await session.get(TopicArchive, archive_id, with_for_update=True)
            if archive is None or archive.state != "deleting":
                return
            ticket = await session.get(Ticket, archive.ticket_id, with_for_update=True)
            assert ticket is not None
            if ticket.topic_id == archive.topic_id:
                ticket.topic_id = None
                if ticket.status != TicketStatus.CLOSED:
                    ticket.status = TicketStatus.PROVISIONING
                for row in (
                    await session.scalars(
                        select(DeliveryOutbox).where(
                            DeliveryOutbox.ticket_id == ticket.id,
                            DeliveryOutbox.direction == Direction.USER_TO_OPERATOR,
                            DeliveryOutbox.status == DeliveryStatus.PENDING,
                        )
                    )
                ).all():
                    if row.payload.get("target_thread_id") == archive.topic_id:
                        row.payload = {**row.payload, "target_thread_id": None}
                        row.status = DeliveryStatus.WAITING_TOPIC
            archive.state = "archived"
            archive.archived_at = utcnow()
            await session.commit()

    async def enqueue_operator_mirror(
        self,
        *,
        ticket_id: str,
        source_chat_id: int,
        source_message_id: int,
        source_topic_id: int,
        author: str,
        snapshot: dict[str, Any],
    ) -> None:
        async with self.database.session() as session:
            ticket = await session.get(Ticket, ticket_id, with_for_update=True)
            if ticket is None or ticket.topic_id in (None, source_topic_id):
                return
            archive = await session.scalar(
                select(TopicArchive).where(
                    TopicArchive.ticket_id == ticket_id,
                    TopicArchive.chat_id == source_chat_id,
                    TopicArchive.topic_id == source_topic_id,
                    TopicArchive.state.in_(("retiring", "archived", "archived_pending")),
                )
            )
            if archive is None:
                return
            prefix = f"rotation-mirror:{source_chat_id}:{source_message_id}"
            messages: tuple[tuple[str, dict[str, Any]], ...] = (
                (
                    "author",
                    {
                        "kind": "send_text",
                        "text": f"Оператор {author} · {snapshot.get('date', '')}",
                    },
                ),
                ("body", {"kind": "snapshot", "snapshot": snapshot}),
            )
            for index, (suffix, payload) in enumerate(messages):
                await session.execute(
                    insert(DeliveryOutbox)
                    .values(
                        ticket_id=ticket_id,
                        direction=Direction.USER_TO_OPERATOR,
                        idempotency_key=f"{prefix}:{suffix}",
                        payload={
                            **payload,
                            "target_chat_id": archive.chat_id,
                            "target_thread_id": ticket.topic_id,
                        },
                        created_at=utcnow() + timedelta(microseconds=index),
                    )
                    .on_conflict_do_nothing(
                        index_elements=[DeliveryOutbox.project_id, DeliveryOutbox.idempotency_key]
                    )
                )
            await session.commit()
