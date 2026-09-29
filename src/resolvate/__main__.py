from __future__ import annotations

import asyncio
import logging
import sys
from collections.abc import Callable
from contextlib import AsyncExitStack
from functools import partial
from ipaddress import ip_address

import httpx
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramAPIError
from fastapi import FastAPI
from pydantic import ValidationError
from sqlalchemy import select

from resolvate.api import create_app
from resolvate.archive_maintenance import ArchiveMaintenance
from resolvate.archive_media_storage import ArchiveMediaStorage
from resolvate.config import Settings
from resolvate.database import Database
from resolvate.delivery import DeliveryWorker
from resolvate.durable_work import DurableWorkRepository
from resolvate.heartbeat import Heartbeat
from resolvate.integration_transport import IntegrationTransport
from resolvate.media_storage import LocalMediaStorage
from resolvate.metrics import MetricsRegistry
from resolvate.models import Ticket
from resolvate.notification_webhook import NotificationWebhookWorker
from resolvate.operational_notices import OperationalNoticeRepository
from resolvate.panel import PanelService
from resolvate.quick_replies import QuickReplyService
from resolvate.reconciliation import ReconciliationWorker
from resolvate.remnawave import RemnawaveClient
from resolvate.runtime_defaults import (
    REMNAWAVE_RECONCILE_DELAY_SECONDS,
    REMNAWAVE_TIMEOUT_SECONDS,
    TELEGRAM_MIN_REQUEST_INTERVAL_SECONDS,
)
from resolvate.runtime_health import RuntimeHealth
from resolvate.runtime_supervision import shutdown_runtime
from resolvate.services import TicketService
from resolvate.telegram_adapter import TelegramSupportAdapter
from resolvate.telegram_archive_media import TelegramArchiveMedia
from resolvate.telegram_ingress import DurableTelegramIngressMiddleware, TelegramIngressWorker
from resolvate.telegram_lifecycle import create_polling_task
from resolvate.telegram_limits import TelegramRateLimiter
from resolvate.telegram_notices import GeneralNoticeWorker
from resolvate.telegram_poll_progress import TelegramPollProgress
from resolvate.telegram_quick_replies import QuickResponseTopicRefreshWorker
from resolvate.telegram_rotation import TopicRotationWorker
from resolvate.telegram_statistics import StatisticsDashboardRefreshWorker
from resolvate.telegram_system_topics import (
    QUICK_REPLIES_TOPIC,
    TelegramSystemTopicService,
)
from resolvate.telegram_transcript import TranscriptIngressMiddleware, TranscriptRequestMiddleware
from resolvate.topic_archive import TopicArchiveRepository
from resolvate.trace import TraceMiddleware
from resolvate.user_message_limits import UserMessageRateLimiter

logger = logging.getLogger(__name__)


def _telegram_value(value: object) -> str:
    return str(getattr(value, "value", value))


def _api_host_is_loopback(host: str) -> bool:
    normalized = host.strip().lower()
    if normalized == "localhost":
        return True
    try:
        return ip_address(normalized).is_loopback
    except ValueError:
        return False


def validate_api_settings(settings: Settings) -> None:
    if not settings.api_enabled:
        return
    if settings.api_unsafe_disable_auth:
        if not _api_host_is_loopback(settings.api_host):
            raise RuntimeError(
                "API_UNSAFE_DISABLE_AUTH=true is allowed only when API_HOST is loopback"
            )
        logger.warning(
            "API authentication is disabled; bind is limited to a loopback host",
            extra={"event": "api_auth_disabled", "api_host": settings.api_host},
        )
        return
    if settings.api_admin_token is None or not settings.api_admin_token.get_secret_value():
        raise RuntimeError("API_ADMIN_TOKEN is required when API_ENABLED=true")


def validate_operator_access(settings: Settings) -> None:
    if settings.admin_telegram_ids or settings.api_enabled or settings.console_origin:
        return
    raise RuntimeError(
        "ADMIN_TELEGRAM_IDS must contain at least one administrator when API_ENABLED=false"
    )


async def validate_support_group(bot: Bot, support_group_id: int) -> None:
    try:
        chat = await bot.get_chat(support_group_id)
        bot_user = await bot.get_me()
        member = await bot.get_chat_member(support_group_id, bot_user.id)
    except TelegramAPIError as error:
        logger.exception(
            "Unable to inspect configured support group",
            extra={
                "event": "support_group_preflight_failed",
                "configured_chat_id": support_group_id,
            },
        )
        raise RuntimeError("Unable to inspect configured support group") from error

    chat_type = _telegram_value(chat.type)
    is_forum = getattr(chat, "is_forum", None)
    member_status = _telegram_value(getattr(member, "status", "unknown"))
    can_manage_topics = getattr(member, "can_manage_topics", None)
    can_delete_messages = getattr(member, "can_delete_messages", None)
    errors: list[str] = []

    if chat_type != "supergroup":
        errors.append("SUPPORT_GROUP_ID must point to a Telegram supergroup")
    if is_forum is not True:
        errors.append("SUPPORT_GROUP_ID must point to a forum group with topics enabled")
    if member_status not in {"administrator", "creator"}:
        errors.append("resolvate bot must be an administrator in SUPPORT_GROUP_ID")
    if member_status == "administrator" and can_manage_topics is not True:
        errors.append("resolvate bot must have permission to manage topics")
    if member_status == "administrator" and can_delete_messages is not True:
        errors.append("resolvate bot must have permission to delete messages")

    extra: dict[str, object] = {
        "event": "support_group_preflight",
        "configured_chat_id": support_group_id,
        "chat_id": chat.id,
        "chat_type": chat_type,
        "chat_title": getattr(chat, "title", None),
        "is_forum": is_forum,
        "bot_id": bot_user.id,
        "member_status": member_status,
        "can_manage_topics": can_manage_topics,
        "can_delete_messages": can_delete_messages,
    }
    if errors:
        logger.error(
            "Configured support group failed preflight checks",
            extra={**extra, "preflight_errors": errors},
        )
        raise RuntimeError("Invalid Telegram support group configuration: " + "; ".join(errors))

    logger.info("Configured support group passed preflight checks", extra=extra)


async def run_project(
    settings: Settings, database: Database, publish: Callable[[FastAPI], None], stop: asyncio.Event
) -> None:
    async with AsyncExitStack() as resources:
        await _run_project(settings, database, publish, stop, resources)


async def _run_project(
    settings: Settings,
    database: Database,
    publish: Callable[[FastAPI], None],
    stop: asyncio.Event,
    resources: AsyncExitStack,
) -> None:
    validate_api_settings(settings)
    validate_operator_access(settings)
    runtime_health = RuntimeHealth()
    runtime_health.register("database")
    runtime_health.register("telegram_ingress", progress_timeout_seconds=45)
    runtime_health.register("reconciliation", progress_timeout_seconds=45)
    runtime_health.register(
        "api",
        configured=bool(
            settings.api_enabled or settings.web_api_enabled or settings.console_origin
        ),
    )
    runtime_health.register("panel", configured=settings.remnawave_enabled)
    runtime_health.register("delivery_worker", progress_timeout_seconds=45)
    runtime_health.register(
        "notification_webhook",
        configured=settings.notification_webhook_enabled,
        progress_timeout_seconds=45,
    )
    runtime_health.ready("database")
    metrics = MetricsRegistry()
    http_client = await resources.enter_async_context(
        httpx.AsyncClient(transport=IntegrationTransport(), trust_env=False)
    )
    ticket_service = TicketService(database)
    if settings.web_api_enabled:
        await ticket_service.validate_web_identity_mode(settings.web_identity_mode)
    durable_work = DurableWorkRepository(database)
    panel_service: PanelService | None = None
    if settings.remnawave_enabled:
        if settings.remnawave_base_url is None or settings.remnawave_api_token is None:
            raise RuntimeError("Remnawave is enabled but base URL or API token is missing")
        panel_service = PanelService(
            RemnawaveClient(
                base_url=settings.remnawave_base_url,
                api_token=settings.remnawave_api_token,
                timeout_seconds=REMNAWAVE_TIMEOUT_SECONDS,
                client=http_client,
                metrics=metrics,
            ),
            database=database,
            reconcile_delay_seconds=REMNAWAVE_RECONCILE_DELAY_SECONDS,
            support_group_id=settings.support_group_id,
            revoke_link_telegram_notification=(
                settings.remnawave_revoke_link_telegram_notification
            ),
        )
        recovered_actions = await panel_service.recover_interrupted_actions()
        runtime_health.ready("panel")
        if recovered_actions:
            logger.error(
                "Recovered interrupted Remnawave actions for durable reconciliation",
                extra={
                    "event": "panel_actions_recovery_required",
                    "recovered_action_count": recovered_actions,
                },
            )
    unresolved_topic_claims = await ticket_service.list_topic_provisioning_ticket_ids()
    for ticket_id in unresolved_topic_claims:
        logger.error(
            "Topic provisioning requires explicit recovery",
            extra={"event": "topic_provisioning_recovery_required", "ticket_id": ticket_id},
        )
    bot = Bot(
        token=settings.support_bot_token.get_secret_value(),
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )
    resources.push_async_callback(bot.session.close)
    await validate_support_group(bot, settings.support_group_id)
    if stop.is_set():
        return
    limiter = TelegramRateLimiter(TELEGRAM_MIN_REQUEST_INTERVAL_SECONDS)
    user_message_limiter = UserMessageRateLimiter(
        per_minute=settings.user_messages_per_minute,
        per_hour=settings.user_messages_per_hour,
    )
    system_topics = TelegramSystemTopicService(
        bot=bot,
        database=database,
        support_group_id=settings.support_group_id,
        limiter=limiter,
    )
    quick_replies_topic_id = await system_topics.ensure(QUICK_REPLIES_TOPIC)
    quick_replies_topic_id = await system_topics.reconcile_name(
        QUICK_REPLIES_TOPIC,
        quick_replies_topic_id,
    )
    quick_reply_service = QuickReplyService(database)
    topic_archive = TopicArchiveRepository(database, settings)
    archive_storage = ArchiveMediaStorage(
        settings.data_dir, reserve_bytes=settings.storage_reserve_bytes
    )
    web_media_storage = LocalMediaStorage(settings.data_dir, capacity=archive_storage)
    web_media_storage.mutation_lock = topic_archive.media_lock
    archive_media = TelegramArchiveMedia(
        topic_archive,
        bot,
        archive_storage,
    )
    topic_archive.prepare_media = archive_media.prepare_archive
    async with database.session() as session:
        legacy_topics = (
            await session.execute(
                select(Ticket.id, Ticket.topic_id).where(Ticket.topic_id.is_not(None))
            )
        ).all()
    for ticket_id, topic_id in legacy_topics:
        await topic_archive.register_topic(ticket_id=ticket_id, topic_id=topic_id)
    bot.session.middleware(TranscriptRequestMiddleware(topic_archive))
    poll_progress = TelegramPollProgress()
    bot.session.middleware(poll_progress)
    dispatcher = Dispatcher()
    ingress_worker = TelegramIngressWorker(
        bot=bot, dispatcher=dispatcher, repository=durable_work, runtime_health=runtime_health
    )
    dispatcher.update.outer_middleware(TraceMiddleware())
    dispatcher.update.outer_middleware(
        DurableTelegramIngressMiddleware(
            durable_work,
            ingress_worker.wake,
            bot=bot,
            inbound_limiter=user_message_limiter,
            outbound_limiter=limiter,
            poll_progress=poll_progress,
        )
    )
    adapter = TelegramSupportAdapter(
        bot=bot,
        ticket_service=ticket_service,
        settings=settings,
        limiter=limiter,
        panel_service=panel_service,
        quick_reply_service=quick_reply_service,
        quick_replies_topic_id=quick_replies_topic_id,
        media_storage=web_media_storage,
    )
    adapter.topic_archive = topic_archive
    resources.push_async_callback(adapter.shutdown_quick_reply_runtime)
    adapter.router.message.outer_middleware(TranscriptIngressMiddleware(topic_archive))
    adapter.router.edited_message.outer_middleware(TranscriptIngressMiddleware(topic_archive))
    adapter.recover_quick_replies_topic = partial(system_topics.recover, QUICK_REPLIES_TOPIC)
    dispatcher.include_router(adapter.router)
    await adapter.recover_waiting_topics_after_restart()
    await adapter.ensure_quick_response_topic()
    await adapter.restore_pending_quick_response_expirations()
    await adapter.ensure_statistics_dashboard()
    quick_response_topic_worker = QuickResponseTopicRefreshWorker(adapter)
    statistics_worker = StatisticsDashboardRefreshWorker(adapter)
    if stop.is_set():
        return

    publish(
        create_app(
            database=database,
            ticket_service=ticket_service,
            settings=settings,
            runtime_health=runtime_health,
            metrics=metrics,
            user_message_limiter=user_message_limiter,
            media_storage=web_media_storage,
        )
    )
    runtime_health.ready("api")

    reconciliation_worker = ReconciliationWorker(
        repository=durable_work,
        reconcile_topic=adapter.reconcile_ticket_topic,
        panel_service=panel_service,
        runtime_health=runtime_health,
    )
    delivery_worker = DeliveryWorker(
        bot=bot,
        ticket_service=ticket_service,
        outbox=ticket_service.outbox,
        settings=settings,
        limiter=limiter,
        heartbeat_path=settings.data_dir / "delivery-worker-heartbeat",
        recover_missing_topic=adapter.recover_missing_topic,
        resolve_system_topic=system_topics.ensure,
        recover_system_topic=system_topics.recover,
        prepare_reopened_customer_topic=adapter.prepare_reopened_customer_topic,
        source_snapshot=topic_archive.source_message,
        runtime_health=runtime_health,
    )
    notification_worker: NotificationWebhookWorker | None = None
    notification_worker_task: asyncio.Task[None] | None = None
    if settings.notification_webhook_enabled:
        notification_worker = NotificationWebhookWorker(
            outbox=ticket_service.outbox,
            settings=settings,
            heartbeat_path=settings.data_dir / "notification-webhook-worker-heartbeat",
            runtime_health=runtime_health,
            client=http_client,
            metrics=metrics,
        )
        notification_worker_task = asyncio.create_task(
            notification_worker.run(), name="notification-webhook-worker"
        )
    rotation_worker = TopicRotationWorker(
        archives=topic_archive,
        bot=bot,
        tickets=ticket_service,
        media=archive_media,
        limiter=limiter,
        customer_card=adapter._customer_card,
        poll_progress=poll_progress,
    )
    rotation_task = asyncio.create_task(rotation_worker.run(), name="topic-rotation-worker")
    maintenance = ArchiveMaintenance(topic_archive, archive_storage)
    maintenance_task = asyncio.create_task(maintenance.run(), name="archive-maintenance-worker")
    general_notices = GeneralNoticeWorker(
        OperationalNoticeRepository(database), bot, settings.support_group_id, limiter
    )
    general_notices_task = asyncio.create_task(general_notices.run(), name="general-notice-worker")
    heartbeat = Heartbeat(settings.data_dir / "heartbeat", progress_probe=runtime_health.is_ready)
    ingress_worker_task = asyncio.create_task(ingress_worker.run(), name="telegram-ingress-worker")
    reconciliation_worker_task = asyncio.create_task(
        reconciliation_worker.run(), name="reconciliation-worker"
    )
    worker_task = asyncio.create_task(delivery_worker.run(), name="delivery-worker")
    heartbeat_task = asyncio.create_task(heartbeat.run(), name="heartbeat")
    statistics_worker_task = asyncio.create_task(
        statistics_worker.run(), name="statistics-dashboard-refresh-worker"
    )
    quick_response_topic_worker_task = asyncio.create_task(
        quick_response_topic_worker.run(), name="quick-response-topic-refresh-worker"
    )
    api_task = None
    polling_task = create_polling_task(
        dispatcher,
        bot,
        allowed_updates=dispatcher.resolve_used_update_types(),
        handle_signals=False,
    )
    stop_task = asyncio.create_task(stop.wait())
    try:
        logger.info("Starting resolvate")
        watched = {
            polling_task,
            stop_task,
            ingress_worker_task,
            reconciliation_worker_task,
            worker_task,
            rotation_task,
            maintenance_task,
            general_notices_task,
            statistics_worker_task,
            quick_response_topic_worker_task,
        }
        if notification_worker_task is not None:
            watched.add(notification_worker_task)
        done, _ = await asyncio.wait(watched, return_when=asyncio.FIRST_COMPLETED)
        for finished in done:
            if finished is not stop_task:
                await finished
        if polling_task.done():
            await polling_task
    finally:
        stop_task.cancel()
        await asyncio.gather(stop_task, return_exceptions=True)
        await shutdown_runtime(
            polling_task=polling_task,
            stop_polling=dispatcher.stop_polling,
            api_task=api_task,
            request_api_stop=None,
            worker_tasks=(
                general_notices_task,
                maintenance_task,
                rotation_task,
                ingress_worker_task,
                reconciliation_worker_task,
                worker_task,
                heartbeat_task,
                statistics_worker_task,
                quick_response_topic_worker_task,
                *((notification_worker_task,) if notification_worker_task is not None else ()),
            ),
            stop_workers=(
                general_notices.stop,
                maintenance.stop,
                rotation_worker.stop,
                ingress_worker.stop,
                reconciliation_worker.stop,
                delivery_worker.stop,
                heartbeat.stop,
                statistics_worker.stop,
                quick_response_topic_worker.stop,
                *((notification_worker.stop,) if notification_worker is not None else ()),
            ),
            close_resources=(),
        )


def _settings_location(field_name: object) -> str:
    return str(field_name).upper()


def format_configuration_error(error: ValidationError) -> str:
    lines = ["Configuration error:"]
    for item in error.errors(include_input=False, include_url=False):
        message = str(item.get("msg", "invalid configuration"))
        if message.startswith("Value error, "):
            message = message.removeprefix("Value error, ")
        location = item.get("loc", ())
        if isinstance(location, tuple) and location:
            message = f"{_settings_location(location[-1])}: {message}"
        lines.append(f"- {message}")
    lines.append("Fix the environment file and restart the service.")
    lines.append("Production env file: /opt/resolvate/.env")
    return "\n".join(lines)


def main() -> None:
    from resolvate.installation import run

    try:
        asyncio.run(run())
    except ValidationError as error:
        print(format_configuration_error(error), file=sys.stderr)
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
