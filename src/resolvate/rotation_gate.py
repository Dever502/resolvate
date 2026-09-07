from __future__ import annotations

from sqlalchemy import ColumnElement, String, cast, exists, literal, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from resolvate.models import Ticket, TopicArchive, UserIdentity

ROTATION_GATE_LOCK = 726015
SWITCHING_STATES = ("switching", "creating", "installing", "evicting", "deleting")


async def lock_rotation_gate(session: AsyncSession) -> None:
    """Short DB-only barrier shared by ingress, work claims and topic cutover."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": ROTATION_GATE_LOCK})


def ticket_is_switching(
    ticket_id: InstrumentedAttribute[str] | InstrumentedAttribute[str | None],
) -> ColumnElement[bool]:
    return exists(
        select(TopicArchive.id).where(
            TopicArchive.ticket_id == ticket_id, TopicArchive.state.in_(SWITCHING_STATES)
        )
    )


def archive_ingress_keys() -> tuple[ColumnElement[str], ...]:
    return (
        literal("chat:")
        + cast(TopicArchive.chat_id, String)
        + ":thread:"
        + cast(TopicArchive.topic_id, String),
        literal("chat:")
        + cast(TopicArchive.chat_id, String)
        + ":thread:"
        + cast(TopicArchive.replacement_topic_id, String),
        literal("chat:") + UserIdentity.external_id + ":thread:0",
    )


def ingress_matches_archive(ordering_key: InstrumentedAttribute[str]) -> ColumnElement[bool]:
    return or_(*(ordering_key == key for key in archive_ingress_keys()))


def ingress_is_switching(ordering_key: InstrumentedAttribute[str]) -> ColumnElement[bool]:
    return exists(
        select(TopicArchive.id)
        .join(Ticket, Ticket.id == TopicArchive.ticket_id)
        .outerjoin(
            UserIdentity,
            (UserIdentity.user_id == Ticket.user_id) & (UserIdentity.provider == "telegram"),
        )
        .where(TopicArchive.state.in_(SWITCHING_STATES), ingress_matches_archive(ordering_key))
    )
