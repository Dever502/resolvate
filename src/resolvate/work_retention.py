"""Finite recovery window for failed work; active work never expires here."""

from datetime import datetime, timedelta

from sqlalchemy import ColumnElement, and_, func, or_

from resolvate.models import DeliveryOutbox, DeliveryStatus, InboundUpdate, WorkStatus, utcnow

FAILED_WORK_RECOVERY = timedelta(days=30)


def failed_work_expired(
    model: type[DeliveryOutbox] | type[InboundUpdate], now: datetime
) -> ColumnElement[bool]:
    # next_attempt_at is advanced on failure, unlike created_at. Include both for
    # imported/legacy rows and allow the entire window after the last attempt.
    return and_(
        model.status == "failed",
        func.greatest(model.created_at, model.next_attempt_at) <= now - FAILED_WORK_RECOVERY,
    )


def work_protects_archive(
    model: type[DeliveryOutbox] | type[InboundUpdate], now: datetime | None = None
) -> ColumnElement[bool]:
    active = (
        (DeliveryStatus.PENDING, DeliveryStatus.PROCESSING, DeliveryStatus.WAITING_TOPIC)
        if model is DeliveryOutbox
        else (WorkStatus.PENDING, WorkStatus.PROCESSING)
    )
    return or_(
        model.status.in_(active),
        and_(model.status == "failed", ~failed_work_expired(model, now or utcnow())),
    )


def delivery_recovery_expired(job: DeliveryOutbox, now: datetime) -> bool:
    return max(job.created_at, job.next_attempt_at) <= now - FAILED_WORK_RECOVERY
