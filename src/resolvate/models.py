from __future__ import annotations

import enum
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, validates

_TRUE_SERVER_DEFAULT = text("true")


def utcnow() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class ProjectScoped(Base):
    """Business data always belongs to exactly one project."""

    __abstract__ = True
    project_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("projects.id", ondelete="RESTRICT"),
        nullable=False,
        server_default=text("nullif(current_setting('resolvate.project_id', true), '')"),
        index=True,
    )


def project_key() -> Any:
    return mapped_column(
        String(36),
        ForeignKey("projects.id", ondelete="RESTRICT"),
        primary_key=True,
        server_default=text("nullif(current_setting('resolvate.project_id', true), '')"),
    )


class TicketStatus(enum.StrEnum):
    PROVISIONING = "provisioning"
    OPEN = "open"
    CLOSED = "closed"


class DeliveryStatus(enum.StrEnum):
    WAITING_TOPIC = "waiting_topic"
    PENDING = "pending"
    PROCESSING = "processing"
    CANCELLED = "cancelled"
    DELIVERED = "delivered"
    FAILED = "failed"


class NotificationStatus(enum.StrEnum):
    AWAITING_PAYLOAD = "awaiting_payload"
    CANCELLED = "cancelled"
    PENDING = "pending"
    PROCESSING = "processing"
    DELIVERED = "delivered"
    FAILED = "failed"


class WorkStatus(enum.StrEnum):
    PENDING = "pending"
    PROCESSING = "processing"
    DELIVERED = "delivered"
    FAILED = "failed"


class Direction(enum.StrEnum):
    USER_TO_OPERATOR = "user_to_operator"
    OPERATOR_TO_USER = "operator_to_user"


class TicketChannel(enum.StrEnum):
    TELEGRAM = "telegram"
    WEB = "web"


class User(ProjectScoped):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    display_name: Mapped[str | None] = mapped_column(String(255))
    username: Mapped[str | None] = mapped_column(String(255))
    email: Mapped[str | None] = mapped_column(String(320))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    identities: Mapped[list[UserIdentity]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    tickets: Mapped[list[Ticket]] = relationship(back_populates="user")


class UserIdentity(ProjectScoped):
    __tablename__ = "user_identities"
    __table_args__ = (
        UniqueConstraint(
            "project_id", "provider", "external_id", name="uq_identity_provider_external"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    external_id: Mapped[str] = mapped_column(String(320), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    user: Mapped[User] = relationship(back_populates="identities")


class TicketFolder(ProjectScoped):
    __tablename__ = "ticket_folders"
    __table_args__ = (
        UniqueConstraint("project_id", "name_key", name="uq_ticket_folders_project_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(80))
    name_key: Mapped[str] = mapped_column(String(240))
    revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class Ticket(ProjectScoped):
    __tablename__ = "tickets"
    __table_args__ = (
        Index("ix_tickets_status_updated", "status", "updated_at"),
        Index("ix_tickets_status_last_activity", "status", "last_activity_at"),
        Index("ix_tickets_project_folder", "project_id", "folder_id"),
        Index(
            "ix_tickets_active_page",
            "project_id",
            text("last_activity_at DESC"),
            text("id DESC"),
            postgresql_where=text("status <> 'closed'"),
        ),
        Index(
            "ix_tickets_archive_page",
            "project_id",
            text("last_activity_at DESC"),
            text("id DESC"),
            postgresql_where=text("status = 'closed'"),
        ),
        UniqueConstraint("user_id", "channel", name="uq_ticket_user_channel"),
        UniqueConstraint("project_id", "topic_id", name="uq_tickets_project_topic"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    channel: Mapped[TicketChannel] = mapped_column(
        String(32), default=TicketChannel.TELEGRAM, nullable=False
    )
    remnawave_user_uuid: Mapped[str | None] = mapped_column(String(36))
    topic_id: Mapped[int | None] = mapped_column(BigInteger)
    status: Mapped[TicketStatus] = mapped_column(
        String(32), default=TicketStatus.PROVISIONING, nullable=False
    )
    topic_provisioning_token: Mapped[str | None] = mapped_column(String(36), unique=True)
    topic_provisioning_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )
    last_activity_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    close_cycle: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    folder_id: Mapped[str | None] = mapped_column(
        ForeignKey("ticket_folders.id", ondelete="SET NULL")
    )
    folder_revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    user: Mapped[User] = relationship(back_populates="tickets")
    messages: Mapped[list[TicketMessage]] = relationship(
        back_populates="ticket", cascade="all, delete-orphan"
    )


class TicketMessage(ProjectScoped):
    __tablename__ = "ticket_messages"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "direction",
            "source_chat_id",
            "source_message_id",
            name="uq_ticket_message_source",
        ),
        UniqueConstraint(
            "ticket_id",
            "channel",
            "rating_cycle",
            name="uq_ticket_message_rating_cycle",
        ),
        Index("ix_ticket_messages_ticket_created", "ticket_id", "created_at"),
        Index(
            "ix_ticket_messages_unread",
            "project_id",
            "ticket_id",
            "created_at",
            postgresql_where=text("direction = 'user_to_operator' AND suppressed IS false"),
        ),
        Index(
            "ix_ticket_messages_project_time",
            "project_id",
            "created_at",
            postgresql_where=text("suppressed IS false"),
        ),
        Index(
            "ix_ticket_messages_direction_channel_created",
            "direction",
            "channel",
            "created_at",
        ),
        Index("ix_ticket_messages_sensitive_created", "sensitive", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    ticket_id: Mapped[str] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), nullable=False
    )
    direction: Mapped[Direction] = mapped_column(String(32), nullable=False)
    channel: Mapped[str] = mapped_column(String(32), default="telegram", nullable=False)
    archive_id: Mapped[str | None] = mapped_column(
        ForeignKey("topic_archives.id", ondelete="SET NULL"), index=True
    )
    content: Mapped[str | None] = mapped_column(Text)
    media: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    suppressed: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )
    sensitive: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )
    rating_cycle: Mapped[int | None] = mapped_column(Integer)
    source_chat_id: Mapped[int | None] = mapped_column(BigInteger)
    source_message_id: Mapped[int | None] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    ticket: Mapped[Ticket] = relationship(back_populates="messages")


class DeliveryOutbox(ProjectScoped):
    __tablename__ = "delivery_outbox"
    __table_args__ = (
        UniqueConstraint("project_id", "idempotency_key", name="uq_delivery_project_key"),
        Index("ix_delivery_outbox_claim", "status", "next_attempt_at", "created_at"),
        Index("ix_delivery_outbox_stale", "status", "claimed_at"),
        Index(
            "ix_delivery_outbox_ticket_direction_status",
            "ticket_id",
            "direction",
            "status",
        ),
        Index(
            "ix_delivery_outbox_ticket_status_created",
            "ticket_id",
            "status",
            "created_at",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    ticket_id: Mapped[str] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), nullable=False
    )
    idempotency_key: Mapped[str] = mapped_column(String(512), nullable=False)
    direction: Mapped[Direction] = mapped_column(String(32), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    status: Mapped[DeliveryStatus] = mapped_column(
        String(32), default=DeliveryStatus.PENDING, nullable=False
    )
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    claim_token: Mapped[str | None] = mapped_column(String(36))
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    delivered_message_id: Mapped[int | None] = mapped_column(BigInteger)
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class NotificationOutbox(ProjectScoped):
    __tablename__ = "notification_outbox"
    __table_args__ = (
        UniqueConstraint("project_id", "idempotency_key", name="uq_notification_project_key"),
        Index("ix_notification_outbox_claim", "status", "next_attempt_at", "created_at"),
        Index("ix_notification_outbox_stale", "status", "claimed_at"),
        Index(
            "ix_notification_outbox_ticket_status_created",
            "ticket_id",
            "status",
            "created_at",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    ticket_id: Mapped[str] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), nullable=False
    )
    operator_action_id: Mapped[str | None] = mapped_column(
        ForeignKey("operator_actions.id", ondelete="SET NULL"),
        unique=True,
    )
    idempotency_key: Mapped[str] = mapped_column(String(512), nullable=False)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    destination: Mapped[str] = mapped_column(String(64), nullable=False)
    recipient_identity_provider: Mapped[str] = mapped_column(String(32), nullable=False)
    recipient_identity_value: Mapped[str] = mapped_column(String(320), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    status: Mapped[NotificationStatus] = mapped_column(
        String(32), default=NotificationStatus.PENDING, nullable=False
    )
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    claim_token: Mapped[str | None] = mapped_column(String(36))
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class InboundUpdate(ProjectScoped):
    __tablename__ = "inbound_updates"
    project_id: Mapped[str] = project_key()
    __table_args__ = (
        Index("ix_inbound_updates_payload", "payload", postgresql_using="gin"),
        Index("ix_inbound_updates_claim", "status", "next_attempt_at", "telegram_update_id"),
        Index("ix_inbound_updates_stale", "status", "claimed_at"),
        Index(
            "ix_inbound_updates_ordering",
            "ordering_key",
            "status",
            "telegram_update_id",
        ),
    )

    telegram_update_id: Mapped[int] = mapped_column(
        BigInteger, primary_key=True, autoincrement=False
    )
    ordering_key: Mapped[str] = mapped_column(
        String(64), nullable=False, server_default="legacy:global"
    )
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    status: Mapped[WorkStatus] = mapped_column(
        String(32), default=WorkStatus.PENDING, nullable=False
    )
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    claim_token: Mapped[str | None] = mapped_column(String(36))
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ReconciliationOutbox(ProjectScoped):
    __tablename__ = "reconciliation_outbox"
    __table_args__ = (
        UniqueConstraint("project_id", "idempotency_key", name="uq_reconciliation_project_key"),
        Index("ix_reconciliation_claim", "status", "next_attempt_at", "created_at"),
        Index("ix_reconciliation_stale", "status", "claimed_at"),
        Index(
            "ix_reconciliation_ticket_status_created",
            "ticket_id",
            "status",
            "created_at",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    idempotency_key: Mapped[str] = mapped_column(String(512), nullable=False)
    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    ticket_id: Mapped[str | None] = mapped_column(ForeignKey("tickets.id", ondelete="CASCADE"))
    operator_action_id: Mapped[str | None] = mapped_column(
        ForeignKey("operator_actions.id", ondelete="CASCADE"), unique=True
    )
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    status: Mapped[WorkStatus] = mapped_column(
        String(32), default=WorkStatus.PENDING, nullable=False
    )
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    claim_token: Mapped[str | None] = mapped_column(String(36))
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class OperatorAction(ProjectScoped):
    __tablename__ = "operator_actions"
    __table_args__ = (
        UniqueConstraint("project_id", "idempotency_key", name="uq_action_project_key"),
        Index(
            "ix_operator_actions_ticket_action_result",
            "ticket_id",
            "action",
            "result",
        ),
        Index("ix_operator_actions_result_created", "result", "created_at"),
        Index(
            "uq_operator_actions_unresolved_ticket",
            "ticket_id",
            unique=True,
            postgresql_where=text("result IN ('started', 'unknown') AND action LIKE 'remnawave_%'"),
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    ticket_id: Mapped[str | None] = mapped_column(ForeignKey("tickets.id", ondelete="SET NULL"))
    operator_telegram_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(512), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, nullable=False)
    result: Mapped[str | None] = mapped_column(String(64))
    trace_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    @validates("result")
    def track_result_timestamp(self, key: str, value: str | None) -> str | None:
        now = utcnow()
        self.updated_at = now
        if value not in {None, "started", "unknown"} and self.completed_at is None:
            self.completed_at = now
        return value


class BlocklistEntry(ProjectScoped):
    __tablename__ = "blocklist"
    project_id: Mapped[str] = project_key()

    telegram_user_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    blocked_by_telegram_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class SupportBlock(ProjectScoped):
    __tablename__ = "support_blocks"

    ticket_id: Mapped[str] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), primary_key=True
    )
    blocked_by_telegram_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(32), default="telegram", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class QuickResponse(ProjectScoped):
    __tablename__ = "quick_responses"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "source_chat_id",
            "source_message_id",
            name="uq_quick_responses_source",
        ),
        UniqueConstraint(
            "project_id",
            "published_message_id",
            name="uq_quick_responses_published_message",
        ),
        Index(
            "ix_quick_responses_state_deadline",
            "state",
            "invalid_until",
            "id",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    tags: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    created_by_telegram_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_by_display_name: Mapped[str | None] = mapped_column(String(255))
    created_by_username: Mapped[str | None] = mapped_column(String(255))
    source_chat_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    source_message_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    published_message_id: Mapped[int | None] = mapped_column(BigInteger)
    publication_format_version: Mapped[int] = mapped_column(
        Integer,
        default=0,
        server_default="0",
        nullable=False,
    )
    state: Mapped[str] = mapped_column(String(24), default="valid", nullable=False)
    invalid_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    warning_message_id: Mapped[int | None] = mapped_column(BigInteger)
    deleted_by_telegram_id: Mapped[int | None] = mapped_column(BigInteger)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class TopicArchive(ProjectScoped):
    """One physical Telegram topic; its identity survives replacement and deletion."""

    __tablename__ = "topic_archives"
    __table_args__ = (
        UniqueConstraint("chat_id", "topic_id", name="uq_topic_archives_telegram"),
        Index("ix_topic_archives_state_due", "state", "next_attempt_at"),
        Index("ix_topic_archives_ticket", "ticket_id", "created_at"),
        Index("ix_topic_archives_retention", "state", "archived_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    ticket_id: Mapped[str] = mapped_column(ForeignKey("tickets.id", ondelete="RESTRICT"))
    chat_id: Mapped[int] = mapped_column(BigInteger)
    topic_id: Mapped[int] = mapped_column(BigInteger)
    state: Mapped[str] = mapped_column(String(24), default="live")
    complete: Mapped[bool] = mapped_column(Boolean, default=False)
    message_count: Mapped[int] = mapped_column(BigInteger, default=0)
    revision: Mapped[int] = mapped_column(BigInteger, default=0)
    pending_writes: Mapped[int] = mapped_column(Integer, default=0)
    prepared_revision: Mapped[int | None] = mapped_column(BigInteger)
    prepared_close_cycle: Mapped[int | None] = mapped_column(Integer)
    replacement_topic_id: Mapped[int | None] = mapped_column(BigInteger)
    replacement_token: Mapped[str | None] = mapped_column(String(36))
    setup_message_id: Mapped[int | None] = mapped_column(BigInteger)
    cutover_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    mode: Mapped[str | None] = mapped_column(String(24))
    error_code: Mapped[str | None] = mapped_column(String(64))
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class TranscriptMedia(ProjectScoped):
    __tablename__ = "transcript_media"
    __table_args__ = (
        Index("ix_transcript_media_state", "state", "created_at"),
        UniqueConstraint("project_id", "file_unique_id", name="uq_transcript_project_file"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    file_unique_id: Mapped[str] = mapped_column(String(255))
    file_id: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(32))
    filename: Mapped[str | None] = mapped_column(String(255))
    state: Mapped[str] = mapped_column(String(24), default="pending")
    declared_size: Mapped[int | None] = mapped_column(BigInteger)
    size_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    storage_path: Mapped[str | None] = mapped_column(String(512))
    sha256: Mapped[str | None] = mapped_column(String(64))
    compressed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class TranscriptMessage(ProjectScoped):
    __tablename__ = "transcript_messages"
    __table_args__ = (
        UniqueConstraint("archive_id", "message_id", name="uq_transcript_message"),
        Index("ix_transcript_messages_media", "media_id", "archive_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    archive_id: Mapped[str] = mapped_column(ForeignKey("topic_archives.id", ondelete="CASCADE"))
    message_id: Mapped[int] = mapped_column(BigInteger)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    media_id: Mapped[str | None] = mapped_column(
        ForeignKey("transcript_media.id", ondelete="RESTRICT")
    )
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class CustomerSummary(ProjectScoped):
    __tablename__ = "customer_summaries"

    ticket_id: Mapped[str] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), primary_key=True
    )
    text: Mapped[str] = mapped_column(Text)
    through_archive_id: Mapped[str] = mapped_column(String(36))
    through_revision: Mapped[int] = mapped_column(BigInteger)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class OperationalNotice(ProjectScoped):
    __tablename__ = "operational_notices"
    project_id: Mapped[str] = project_key()

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    severity: Mapped[str] = mapped_column(String(16))
    text: Mapped[str] = mapped_column(Text)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    delivered_active: Mapped[bool | None] = mapped_column(Boolean)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_delivery_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ConsoleAccount(Base):
    __tablename__ = "console_accounts"
    __table_args__ = (
        Index(
            "uq_installation_admin", "role", unique=True, postgresql_where=text("role = 'admin'")
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    login: Mapped[str] = mapped_column(String(64), unique=True)
    display_name: Mapped[str] = mapped_column(String(100))
    password_hash: Mapped[str] = mapped_column(String(256))
    role: Mapped[str] = mapped_column(String(16))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    telegram_id: Mapped[int | None] = mapped_column(BigInteger, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ConsoleSession(Base):
    __tablename__ = "console_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[str] = mapped_column(
        ForeignKey("console_accounts.id", ondelete="CASCADE"), index=True
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class ConsoleRead(ProjectScoped):
    __tablename__ = "console_reads"

    account_id: Mapped[str] = mapped_column(
        ForeignKey("console_accounts.id", ondelete="CASCADE"), primary_key=True
    )
    ticket_id: Mapped[str] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), primary_key=True
    )
    through_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ConsoleSend(ProjectScoped):
    """Durable command snapshot, never an independent conversation history."""

    __tablename__ = "console_sends"
    project_id: Mapped[str] = project_key()

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    account_id: Mapped[str] = mapped_column(ForeignKey("console_accounts.id"))
    message_id: Mapped[str] = mapped_column(
        ForeignKey("ticket_messages.id", ondelete="CASCADE"), unique=True
    )
    fingerprint: Mapped[str] = mapped_column(String(64))
    deliveries: Mapped[dict[str, Any]] = mapped_column(JSONB)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(100))
    logo_sha256: Mapped[str | None] = mapped_column(String(64))
    admin_id: Mapped[str] = mapped_column(ForeignKey("console_accounts.id", ondelete="RESTRICT"))
    active: Mapped[bool] = mapped_column(Boolean, default=False)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    settings: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    bot_id: Mapped[int | None] = mapped_column(BigInteger, unique=True)
    group_id: Mapped[int | None] = mapped_column(BigInteger, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ProjectMember(Base):
    __tablename__ = "project_members"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    account_id: Mapped[str] = mapped_column(
        ForeignKey("console_accounts.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AccessAudit(Base):
    __tablename__ = "access_audit"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    actor_id: Mapped[str | None] = mapped_column(ForeignKey("console_accounts.id"))
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id"))
    action: Mapped[str] = mapped_column(String(64))
    target_id: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ProjectCredential(Base):
    __tablename__ = "project_credentials"

    fingerprint: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
