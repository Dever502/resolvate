from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from html import escape

from aiogram import Bot
from aiogram.exceptions import TelegramAPIError, TelegramBadRequest, TelegramRetryAfter
from sqlalchemy import or_, select

from resolvate.models import CustomerSummary, OperationalNotice, TopicArchive, TranscriptMessage
from resolvate.runtime_supervision import wait_for_event
from resolvate.service_types import TicketView
from resolvate.services import TicketService
from resolvate.telegram_archive_media import TelegramArchiveMedia
from resolvate.telegram_errors import is_missing_topic_error
from resolvate.telegram_formatting import topic_name
from resolvate.telegram_limits import TelegramRateLimiter
from resolvate.telegram_poll_progress import TelegramPollProgress
from resolvate.telegram_transcript import rotation_setup_context
from resolvate.topic_archive import TopicArchiveRepository
from resolvate.topic_rotation import TopicRotationRepository

logger = logging.getLogger(__name__)


class TopicRotationWorker:
    """Single-instance orchestration; every destructive step has a durable checkpoint."""

    def __init__(
        self,
        *,
        archives: TopicArchiveRepository,
        bot: Bot,
        tickets: TicketService,
        media: TelegramArchiveMedia,
        limiter: TelegramRateLimiter,
        customer_card: Callable[[TicketView], Awaitable[str]],
        poll_progress: TelegramPollProgress,
    ) -> None:
        self.archives = archives
        self.repository = TopicRotationRepository(archives)
        self.bot = bot
        self.tickets = tickets
        self.media = media
        self.limiter = limiter
        self.customer_card = customer_card
        self.poll_progress = poll_progress
        self._stopped = asyncio.Event()

    def stop(self) -> None:
        self._stopped.set()

    async def recover(self) -> None:
        # A create request cannot be retried safely after an ambiguous HTTP result.
        async with self.archives.database.session() as session:
            creating = list(
                (
                    await session.scalars(
                        select(TopicArchive.id).where(TopicArchive.state == "creating")
                    )
                ).all()
            )
        for archive_id in creating:
            await self.repository.transition(
                archive_id, "creating", "uncertain", error="creation_outcome_unknown"
            )
            await self.archives.notice(
                "rotation_creation_uncertain",
                "Результат создания топика неизвестен. Старый топик сохранён; нужна проверка.",
            )
            archive = await self.repository.get(archive_id)
            if archive is not None:
                await self._reopen(archive)

    async def run(self) -> None:
        while not self._stopped.is_set():
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Topic rotation pass failed", extra={"event": "rotation_failed"})
            await wait_for_event(self._stopped, 5)

    async def tick(self) -> None:
        await self.recover()
        pending = await self.repository.pending()
        for archive_id in pending:
            if self._stopped.is_set():
                return
            await self.advance(archive_id)
        await self._resolve_notices()
        if not self.archives.settings.topic_rotation_enabled:
            return
        count = await self.archives.count_topics()
        async with self.archives.database.session() as session:
            notice = await session.get(OperationalNotice, "rotation_capacity")
            cleaning = notice is not None and notice.active
        if count >= self.archives.settings.rotation_cleanup_trigger:
            cleaning = True
        elif count <= self.archives.settings.rotation_cleanup_target:
            cleaning = False
        await self.archives.notice(
            "rotation_capacity",
            "Очистка закрытых клиентских топиков по лимиту.",
            active=cleaning,
        )
        candidates = await self.archives.candidates(capacity=cleaning)
        if cleaning and not candidates and count >= self.archives.settings.rotation_topic_limit:
            await self.archives.notice(
                "rotation_capacity_exceeded",
                "Лимит топиков превышен: безопасная очистка пока невозможна. Приём продолжается.",
            )
        elif count < self.archives.settings.rotation_topic_limit:
            await self.archives.notice(
                "rotation_capacity_exceeded", "Лимит топиков соблюдается.", active=False
            )
        if candidates:
            archive_id = candidates[0]
            if await self.archives.prepare(archive_id, capacity=cleaning):
                await self.advance(archive_id)

    async def _resolve_notices(self) -> None:
        async with self.archives.database.session() as session:
            rows = (
                await session.execute(
                    select(TopicArchive.state, TopicArchive.error_code).where(
                        TopicArchive.state != "archived"
                    )
                )
            ).all()
        errors = {row.error_code for row in rows if row.error_code}
        if any(
            row.state == "uncertain" and row.error_code != "setup_outcome_unknown" for row in rows
        ):
            errors.add("creation_outcome_unknown")
        for key, codes in {
            "archive_media_unavailable": {"media_unavailable", "late_media_unavailable"},
            "rotation_summary_unavailable": {"summary_unavailable"},
            "rotation_step_failed": {
                "telegram_or_storage_error",
                "creation_outcome_unknown",
                "setup_outcome_unknown",
            },
            "rotation_creation_uncertain": {"creation_outcome_unknown"},
            "rotation_setup_uncertain": {"setup_outcome_unknown"},
        }.items():
            if not errors.intersection(codes):
                await self.archives.notice(key, "Препятствие для ротации устранено.", active=False)

    async def advance(self, archive_id: str) -> None:
        archive = await self.repository.get(archive_id)
        if archive is None:
            return
        try:
            if archive.state == "archived_pending":
                saved = await self.media.prepare_archive(archive.id)
                await self.repository.transition(
                    archive.id,
                    "archived_pending",
                    "archived" if saved else "archived_pending",
                    delay=0 if saved else 900,
                    error=None if saved else "late_media_unavailable",
                    revision=archive.revision,
                )
                return
            if archive.state == "preparing":
                if self.archives.settings.ai_enabled:
                    async with self.archives.database.session() as session:
                        summary = await session.get(CustomerSummary, archive.ticket_id)
                    if (
                        summary is None
                        or summary.through_archive_id != archive.id
                        or summary.through_revision != archive.revision
                    ):
                        await self.archives.defer(
                            archive.id, reason="summary_unavailable", seconds=900
                        )
                        await self.archives.notice(
                            "rotation_summary_unavailable",
                            "Актуальное AI-резюме недоступно. Ротация отложена, топик сохранён.",
                        )
                        return
                if not await self.archives.begin_switch(archive.id):
                    current = await self.repository.get(archive.id)
                    if (
                        current is not None
                        and current.state == "live"
                        and archive.replacement_token is not None
                    ):
                        await self._reopen(current)
                    return
                archive = await self.repository.get(archive_id)
                assert archive is not None
            if archive.state == "switching":
                # Closing prevents ordinary members from adding to the retired generation.
                await self.limiter.wait()
                try:
                    await self.bot.close_forum_topic(
                        chat_id=archive.chat_id, message_thread_id=archive.topic_id
                    )
                except TelegramBadRequest as error:
                    if "TOPIC_NOT_MODIFIED" not in str(error):
                        raise
                if archive.mode == "evict":
                    await self.repository.start_eviction(archive.id)
                    return
                if archive.replacement_topic_id is not None:
                    # Offline recovery adopted an existing, verified empty topic.
                    # All ordinary cutover checks above still apply.
                    await self.repository.transition(archive.id, "switching", "installing")
                    return
                token = await self.repository.claim_creation(archive.id)
                if token is None:
                    return
                ticket = await self.tickets.get_ticket(archive.ticket_id)
                try:
                    await self.limiter.wait()
                    topic = await self.bot.create_forum_topic(
                        chat_id=archive.chat_id, name=topic_name(ticket, closed=True)
                    )
                except (TelegramBadRequest, TelegramRetryAfter):
                    await self.repository.transition(archive.id, "creating", "switching", delay=60)
                    raise
                except BaseException:
                    await self.repository.transition(
                        archive.id, "creating", "uncertain", error="creation_outcome_unknown"
                    )
                    raise
                if not await self.repository.created(archive.id, token, topic.message_thread_id):
                    raise RuntimeError("created rotation topic could not be attached")
                archive = await self.repository.get(archive_id)
                assert archive is not None
            if archive.state == "installing":
                await self._install(archive)
                return
            if archive.state == "evicting" and await self.repository.redirect_eviction(archive.id):
                return
            if archive.state in {"retiring", "evicting"}:
                if not self.poll_progress.ready_to_delete(archive.cutover_at):
                    return
                if not await self.media.prepare_archive(archive.id):
                    await self.repository.transition(
                        archive.id,
                        archive.state,
                        archive.state,
                        delay=900,
                        error="media_unavailable",
                    )
                    return
                if not await self.repository.begin_delete(archive.id, revision=archive.revision):
                    current = await self.repository.get(archive.id)
                    if current is not None and current.state == "live":
                        await self._reopen(archive)
                    return
                archive = await self.repository.get(archive_id)
                assert archive is not None
            if archive.state == "deleting":
                if not self.poll_progress.ready_to_delete(archive.cutover_at):
                    return
                await self.limiter.wait()
                try:
                    await self.bot.delete_forum_topic(
                        chat_id=archive.chat_id, message_thread_id=archive.topic_id
                    )
                except TelegramBadRequest as error:
                    if not is_missing_topic_error(error):
                        raise
                await self.repository.deleted(archive.id)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.warning(
                "Topic rotation step deferred",
                extra={
                    "event": "rotation_deferred",
                    "archive_id": archive_id,
                    "exception_type": type(error).__name__,
                },
            )
            current = await self.repository.get(archive_id)
            if current is not None:
                await self.repository.transition(
                    archive_id,
                    current.state,
                    current.state,
                    delay=60,
                    error=current.error_code
                    if current.state == "uncertain"
                    else "telegram_or_storage_error",
                )
                if current.state == "uncertain":
                    await self._reopen(current)
            await self.archives.notice(
                "rotation_step_failed",
                "Переезд топика не завершён. Данные и очередь сохранены; "
                "нужна проверка при длительном сбое.",
            )

    async def _reopen(self, archive: TopicArchive) -> None:
        try:
            await self.limiter.wait()
            await self.bot.reopen_forum_topic(
                chat_id=archive.chat_id, message_thread_id=archive.topic_id
            )
        except TelegramAPIError:
            logger.warning("Unable to reopen preserved rotation source")

    async def _install(self, archive: TopicArchive) -> None:
        assert archive.replacement_topic_id is not None
        ticket = await self.tickets.get_ticket(archive.ticket_id)
        card = await self.customer_card(ticket)
        card += "\n\nℹ️ Клиент уже обращался. Предыдущая переписка архивирована."
        if self.archives.settings.ai_enabled:
            async with self.archives.database.session() as session:
                summary = await session.get(CustomerSummary, archive.ticket_id)
            if summary is None:
                raise RuntimeError("required summary disappeared during cutover")
            card += f"\n\nAI-резюме · {summary.generated_at:%d.%m.%Y}\n{escape(summary.text)}"
        if len(card) > 4096:
            raise ValueError("rotation customer card exceeds Telegram message limit")
        if archive.setup_message_id is None:
            new_archive = await self.archives.topic(archive.replacement_topic_id)
            assert new_archive is not None
            async with self.archives.database.session() as session:
                saved_id = await session.scalar(
                    select(TranscriptMessage.message_id)
                    .where(
                        TranscriptMessage.archive_id == new_archive.id,
                        or_(
                            TranscriptMessage.payload["rotation_setup_id"].as_string()
                            == archive.id,
                            TranscriptMessage.payload["text"].as_string() == card,
                        ),
                    )
                    .limit(1)
                )
            if saved_id is not None and not new_archive.pending_writes:
                await self.repository.setup_sent(archive.id, saved_id)
            elif new_archive.pending_writes:
                await self.repository.transition(
                    archive.id, "installing", "uncertain", error="setup_outcome_unknown"
                )
                await self._reopen(archive)
                await self.archives.notice(
                    "rotation_setup_uncertain",
                    "Результат оформления нового топика неизвестен. "
                    "Источник сохранён; нужна проверка.",
                )
                return
            else:
                await self.limiter.wait()
                context_token = rotation_setup_context.set(archive.id)
                try:
                    sent = await self.bot.send_message(
                        chat_id=archive.chat_id,
                        message_thread_id=archive.replacement_topic_id,
                        text=card,
                    )
                finally:
                    rotation_setup_context.reset(context_token)
                await self.repository.setup_sent(archive.id, sent.message_id)
        await self.repository.publish(archive.id)
