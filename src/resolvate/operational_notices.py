from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import or_, select

from resolvate.database import Database
from resolvate.models import OperationalNotice, utcnow

# Explicit public-safe wording. Never send stored exception text, paths or identifiers.
# rotation_capacity is internal hysteresis state, not an incident to publish.
NOTICE_TEXT = {
    "archive_media_budget": (
        "Хранилище медиа достигло порога заполнения. Проверьте свободное место."
    ),
    "archive_text_budget": (
        "Объём архивной переписки достиг порога. Тексты раньше срока не удаляются."
    ),
    "archive_disk_reserve": (
        "Недостаточно свободного места для новых вложений с сохранением резерва."
    ),
    "archive_media_early_deletion": (
        "Из-за нехватки места досрочно удалены старые архивные вложения. Метаданные сохранены."
    ),
    "archive_media_unavailable": "Не удалось сохранить вложения архива. Ротация отложена.",
    "archive_maintenance_failed": (
        "Обслуживание архивного хранилища завершилось ошибкой. Повторим позже."
    ),
    "archive_compression_deferred": "Не удалось сжать архивное вложение. Оригинал сохранён.",
    "archive_media_corrupt": (
        "Архивное вложение не прошло проверку целостности. Требуется проверка хранилища."
    ),
    "rotation_capacity_exceeded": (
        "Лимит топиков превышен, безопасная очистка пока невозможна. Приём обращений продолжается."
    ),
    "rotation_summary_unavailable": (
        "Актуальное AI-резюме недоступно. Ротация отложена, топик сохранён."
    ),
    "rotation_step_failed": "Переезд топика не завершён. При длительном сбое нужна проверка.",
    "rotation_creation_uncertain": (
        "Не удалось подтвердить создание топика. Старый топик сохранён; нужна ручная проверка."
    ),
    "rotation_setup_uncertain": (
        "Не удалось подтвердить оформление нового топика. Нужна ручная проверка."
    ),
}
EVENT_NOTICE_KEYS = frozenset(
    {
        "archive_media_early_deletion",
        "archive_compression_deferred",
        "archive_media_corrupt",
    }
)
RECOVERY_TEXT = {
    "archive_media_budget": "Объём медиа вернулся ниже порога предупреждения.",
    "archive_text_budget": "Объём архивной переписки вернулся ниже порога предупреждения.",
    "archive_disk_reserve": "Свободного места снова достаточно для сохранения вложений.",
    "archive_media_unavailable": "Сохранение архивных вложений восстановлено.",
    "archive_maintenance_failed": "Обслуживание архивного хранилища восстановлено.",
    "rotation_capacity_exceeded": "Количество топиков вернулось в допустимые пределы.",
    "rotation_summary_unavailable": "Блокировка ротации из-за недоступного AI-резюме снята.",
    "rotation_step_failed": "Ошибки незавершённых переездов устранены.",
    "rotation_creation_uncertain": "Неопределённые результаты создания топиков разрешены.",
    "rotation_setup_uncertain": "Неопределённые результаты оформления топиков разрешены.",
}


@dataclass(frozen=True)
class NoticeDelivery:
    key: str
    active: bool
    severity: str
    updated_at: datetime

    def text(self) -> str:
        if not self.active:
            return "✅ Resolvate: восстановление\n\n" + RECOVERY_TEXT[self.key]
        icon = "🚨" if self.severity == "critical" else "⚠️"
        return f"{icon} Resolvate: системное уведомление\n\n" + NOTICE_TEXT[self.key]


class OperationalNoticeRepository:
    def __init__(self, database: Database) -> None:
        self.database = database

    async def claim(self, now: datetime | None = None) -> NoticeDelivery | None:
        now = now or utcnow()
        async with self.database.session() as session:
            row = await session.scalar(
                select(OperationalNotice)
                .where(
                    OperationalNotice.key.in_(NOTICE_TEXT),
                    OperationalNotice.next_delivery_at <= now,
                    or_(
                        OperationalNotice.active.is_(True),
                        OperationalNotice.delivered_active.is_(True),
                    ),
                )
                .order_by(OperationalNotice.next_delivery_at, OperationalNotice.key)
                .limit(1)
                .with_for_update(skip_locked=True)
            )
            if row is None:
                return None
            delivery = NoticeDelivery(row.key, row.active, row.severity, row.updated_at)
            # A restart during an ambiguous send must not produce an immediate duplicate.
            row.next_delivery_at = now + timedelta(hours=1)
            await session.commit()
            return delivery

    async def delivered(self, delivery: NoticeDelivery, now: datetime | None = None) -> None:
        now = now or utcnow()
        async with self.database.session() as session:
            row = await session.get(OperationalNotice, delivery.key, with_for_update=True)
            if row is None:
                return
            row.delivered_at = now
            row.delivered_active = delivery.active
            same_state = row.active == delivery.active and row.severity == delivery.severity
            if delivery.key in EVENT_NOTICE_KEYS:
                row.delivered_active = False
                if row.updated_at == delivery.updated_at:
                    row.active = False
                row.next_delivery_at = now + timedelta(hours=1)
            elif same_state:
                row.next_delivery_at = now + timedelta(hours=1)
            else:
                # State changed during the network call: don't acknowledge the newer state.
                row.next_delivery_at = now
            await session.commit()

    async def retry(self, delivery: NoticeDelivery, seconds: float) -> None:
        async with self.database.session() as session:
            row = await session.get(OperationalNotice, delivery.key, with_for_update=True)
            if row and row.active == delivery.active and row.severity == delivery.severity:
                row.next_delivery_at = utcnow() + timedelta(seconds=seconds)
                await session.commit()
