from __future__ import annotations

from datetime import datetime, timedelta
from typing import cast

from sqlalchemy import ColumnElement, delete, exists, func, literal_column, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from resolvate.models import (
    DeliveryOutbox,
    DeliveryStatus,
    InboundUpdate,
    Ticket,
    TicketMessage,
    TopicArchive,
    TranscriptMedia,
    TranscriptMessage,
    UserIdentity,
    WorkStatus,
    utcnow,
)
from resolvate.rotation_gate import ingress_matches_archive, lock_rotation_gate
from resolvate.topic_archive import TopicArchiveRepository
from resolvate.web_models import MediaAsset


def protected_archive() -> ColumnElement[bool]:
    return or_(
        TopicArchive.state != "archived",
        TopicArchive.archived_at.is_(None),
        TopicArchive.complete.is_(False),
        TopicArchive.pending_writes > 0,
        exists().where(
            Ticket.id == TopicArchive.ticket_id, Ticket.topic_id == TopicArchive.topic_id
        ),
        exists().where(
            DeliveryOutbox.ticket_id == TopicArchive.ticket_id,
            DeliveryOutbox.status != DeliveryStatus.DELIVERED,
        ),
        exists(
            select(InboundUpdate.telegram_update_id)
            .select_from(InboundUpdate)
            .join(Ticket, Ticket.id == TopicArchive.ticket_id)
            .outerjoin(
                UserIdentity,
                (UserIdentity.user_id == Ticket.user_id) & (UserIdentity.provider == "telegram"),
            )
            .where(
                InboundUpdate.status != WorkStatus.DELIVERED,
                ingress_matches_archive(InboundUpdate.ordering_key),
            )
            .correlate(TopicArchive)
        ),
    )


def eligible_media(before: datetime) -> ColumnElement[bool]:
    other = aliased(TranscriptMedia)
    protected_reference = exists(
        select(TranscriptMessage.id)
        .join(TopicArchive, TopicArchive.id == TranscriptMessage.archive_id)
        .join(other, other.id == TranscriptMessage.media_id)
        .where(
            or_(
                TranscriptMessage.media_id == TranscriptMedia.id,
                other.storage_path == TranscriptMedia.storage_path,
            ),
            or_(protected_archive(), TopicArchive.archived_at > before),
        )
    )
    web_reference = exists(
        select(MediaAsset.id)
        .join(TicketMessage, TicketMessage.id == MediaAsset.message_id)
        .outerjoin(TopicArchive, TopicArchive.id == TicketMessage.archive_id)
        .where(
            MediaAsset.storage_path == TranscriptMedia.storage_path,
            or_(
                TicketMessage.archive_id.is_(None),
                protected_archive(),
                TopicArchive.archived_at > before,
            ),
        )
        .correlate(TranscriptMedia)
    )
    # Admission can precede journaling: protect attachments in not-yet-handled updates too.
    queued_attachment = exists().where(
        InboundUpdate.status != WorkStatus.DELIVERED,
        func.jsonb_path_exists(
            InboundUpdate.payload,
            literal_column("'$.**.file_unique_id ? (@ == $file)'::jsonpath"),
            func.jsonb_build_object("file", TranscriptMedia.file_unique_id),
        ),
    )
    return ~protected_reference & ~queued_attachment & ~web_reference


class ArchiveRetention:
    def __init__(self, archives: TopicArchiveRepository) -> None:
        self.archives = archives

    async def media_candidates(
        self,
        before: datetime,
        *,
        after: str = "",
        oldest_first: bool = False,
        compression: bool = False,
        limit: int = 100,
    ) -> list[str]:
        if not 1 <= limit <= 100:
            raise ValueError("media candidate limit must be between 1 and 100")
        last_archive = (
            select(func.max(TopicArchive.archived_at))
            .join(TranscriptMessage, TranscriptMessage.archive_id == TopicArchive.id)
            .where(TranscriptMessage.media_id == TranscriptMedia.id)
            .correlate(TranscriptMedia)
            .scalar_subquery()
        )
        ordering = (
            (func.coalesce(last_archive, TranscriptMedia.created_at), TranscriptMedia.id)
            if oldest_first
            else (TranscriptMedia.id,)
        )
        async with self.archives.database.session() as session:
            return list(
                (
                    await session.scalars(
                        select(TranscriptMedia.id)
                        .where(
                            TranscriptMedia.id > after,
                            TranscriptMedia.state == "stored",
                            TranscriptMedia.storage_path.is_not(None),
                            or_(
                                exists().where(TranscriptMessage.media_id == TranscriptMedia.id),
                                TranscriptMedia.created_at < utcnow() - timedelta(days=1),
                            ),
                            *(
                                [
                                    TranscriptMedia.kind.in_(("photo", "video")),
                                    TranscriptMedia.compressed_at.is_(None),
                                ]
                                if compression
                                else []
                            ),
                            eligible_media(before),
                        )
                        .order_by(*ordering)
                        .limit(limit)
                    )
                ).all()
            )

    async def media_for_change(
        self, session: AsyncSession, media_id: str, before: datetime
    ) -> TranscriptMedia | None:
        await lock_rotation_gate(session)
        return cast(
            TranscriptMedia | None,
            await session.scalar(
                select(TranscriptMedia)
                .where(
                    TranscriptMedia.id == media_id,
                    TranscriptMedia.state == "stored",
                    eligible_media(before),
                )
                .with_for_update()
            ),
        )

    async def purge_transcripts(self, now: datetime) -> int:
        before = now - timedelta(days=self.archives.settings.archive_retention_days)
        removed = 0
        async with self.archives.database.session() as session:
            ids = list(
                (
                    await session.scalars(
                        select(TopicArchive.id)
                        .where(
                            TopicArchive.archived_at <= before,
                            ~protected_archive(),
                            or_(
                                exists().where(TranscriptMessage.archive_id == TopicArchive.id),
                                exists().where(TicketMessage.archive_id == TopicArchive.id),
                            ),
                        )
                        .order_by(TopicArchive.archived_at)
                        .limit(100)
                    )
                ).all()
            )
        for archive_id in ids:
            async with self.archives.media_lock, self.archives.database.session() as session:
                await lock_rotation_gate(session)
                archive = await session.scalar(
                    select(TopicArchive)
                    .where(
                        TopicArchive.id == archive_id,
                        TopicArchive.archived_at <= before,
                        ~protected_archive(),
                    )
                    .with_for_update()
                )
                if archive is None:
                    continue
                # Keep the small routing/history tombstone, not the message bodies.
                await session.execute(
                    delete(TicketMessage).where(TicketMessage.archive_id == archive_id)
                )
                await session.execute(
                    delete(TranscriptMessage).where(TranscriptMessage.archive_id == archive_id)
                )
                await session.commit()
                removed += 1
        return removed

    async def logical_bytes(self) -> int:
        async with self.archives.database.session() as session:
            return int(
                await session.scalar(
                    select(
                        func.coalesce(func.sum(func.pg_column_size(TranscriptMessage.payload)), 0)
                    )
                    .join(TopicArchive, TopicArchive.id == TranscriptMessage.archive_id)
                    .where(TopicArchive.archived_at.is_not(None))
                )
                or 0
            )
