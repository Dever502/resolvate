from __future__ import annotations

from pathlib import Path

from aiogram import Bot
from aiogram.types import Message
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from resolvate.database import Database
from resolvate.media_storage import (
    MAX_WEB_PHOTO_BYTES,
    LocalMediaStorage,
    MediaValidationError,
    StoredMedia,
)
from resolvate.models import Ticket, TicketMessage, TranscriptMedia
from resolvate.rotation_gate import lock_rotation_gate
from resolvate.telegram_message_utils import media_metadata, message_text
from resolvate.web_models import MediaAsset

UNSUPPORTED_ATTACHMENT = (
    "⚠️ Этот тип файла не поддерживается. "
    "Отправьте фото, видео, PDF или голосовое OGG/Opus до 20 МБ."
)


async def save_attachment(
    message: Message, bot: Bot, storage: LocalMediaStorage
) -> StoredMedia | None:
    if message.content_type == "text":
        return None
    attachment = (
        message.photo[-1]
        if message.photo
        else message.video or message.document or getattr(message, "voice", None)
    )
    if attachment is None:
        raise MediaValidationError(UNSUPPORTED_ATTACHMENT)
    mime = "image/jpeg" if message.photo else getattr(attachment, "mime_type", None)
    filename = getattr(attachment, "file_name", None)
    if message.document and (
        mime
        not in {
            "application/pdf",
            "image/jpeg",
            "image/png",
            "image/webp",
            "video/mp4",
            "video/quicktime",
            "audio/ogg",
            "application/ogg",
            "audio/opus",
        }
        or (
            filename
            and Path(filename).suffix.lower()
            not in {".pdf", ".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov", ".ogg", ".opus"}
        )
    ):
        raise MediaValidationError(UNSUPPORTED_ATTACHMENT)
    if attachment.file_size is None:
        raise MediaValidationError("⚠️ Не удалось определить размер файла. Отправьте его заново.")
    if attachment.file_size > MAX_WEB_PHOTO_BYTES:
        raise MediaValidationError("⚠️ Файл больше 20 МБ. Отправьте файл меньшего размера.")
    return await storage.save_telegram_file(
        bot, file_id=attachment.file_id, declared_mime=mime, filename=filename
    )


async def attach_media(
    session: AsyncSession, message: TicketMessage, media: StoredMedia | None
) -> None:
    session.add(message)
    if media is None:
        return
    message.media = {**(message.media or {}), **media.message_metadata()}
    await session.flush()
    unique_id = (message.media or {}).get("file_unique_id")
    if isinstance(unique_id, str):
        archived = await session.scalar(
            select(TranscriptMedia)
            .where(TranscriptMedia.file_unique_id == unique_id)
            .with_for_update()
        )
        if archived is not None:
            archived.state = "stored"
            archived.storage_path = media.storage_path
            archived.size_bytes = media.size_bytes
            archived.sha256 = media.sha256
            archived.deleted_at = None
            archived.compressed_at = None
    session.add(
        MediaAsset(
            id=media.id,
            message_id=message.id,
            ticket_id=message.ticket_id,
            storage_path=media.storage_path,
            mime_type=media.mime_type,
            size_bytes=media.size_bytes,
            sha256=media.sha256,
            original_filename=media.original_filename,
        )
    )


async def record_edit(
    message: Message, bot: Bot, storage: LocalMediaStorage, database: Database
) -> None:
    """Update an already accepted source message; edits never create or reopen a ticket."""
    async with database.session() as session:
        original = await session.scalar(
            select(TicketMessage).where(
                TicketMessage.source_chat_id == message.chat.id,
                TicketMessage.source_message_id == message.message_id,
            )
        )
    if original is None:
        return
    raw = media_metadata(message) or {}
    old = original.media or {}
    changed_file = raw.get("file_unique_id") != old.get("file_unique_id")
    async with storage.transaction(changed_file):
        saved = await save_attachment(message, bot, storage) if changed_file else None
        async with database.session() as session:
            await lock_rotation_gate(session)
            await session.scalar(
                select(Ticket).where(Ticket.id == original.ticket_id).with_for_update()
            )
            current = await session.get(TicketMessage, original.id, with_for_update=True)
            if current is None:
                return
            metadata = current.media or {}
            edit_date = message.edit_date or message.date
            edited_at = int(edit_date if isinstance(edit_date, int) else edit_date.timestamp())
            previous_edit = metadata.get("edited_at", 0)
            if isinstance(previous_edit, int) and previous_edit > edited_at:
                return
            if changed_file:
                await session.execute(delete(MediaAsset).where(MediaAsset.message_id == current.id))
                current.media = {**raw, "operator_name": metadata.get("operator_name")}
                await attach_media(session, current, saved)
            current.content = message_text(message)
            current.media = {**(current.media or {}), "edited_at": edited_at}
            await session.commit()
