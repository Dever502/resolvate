from __future__ import annotations

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message

from resolvate.models import TicketMessage
from resolvate.service_types import TicketView
from resolvate.system_messages import rating_data, rating_text
from resolvate.telegram_constants import TICKET_CLOSED_SUMMARY_TEXT
from resolvate.telegram_formatting import ticket_topic_link

RATING_CALLBACK_PREFIX = "resolvate_rating"


def message_command(message: Message) -> str:
    text = message.text or message.caption or ""
    parts = text.split(maxsplit=1)
    return parts[0].lower().split("@", maxsplit=1)[0] if parts else ""


def command_argument(message: Message) -> str:
    text = message.text or message.caption or ""
    return text.split(maxsplit=1)[1].strip() if len(text.split(maxsplit=1)) == 2 else ""


def message_text(message: Message) -> str | None:
    return message.text or message.caption


def metadata_fields(source: object, fields: tuple[str, ...]) -> dict[str, object]:
    return {field: value for field in fields if (value := getattr(source, field, None)) is not None}


def attachment_metadata(message: Message, content_type: str) -> dict[str, object]:
    fields = (
        "file_id",
        "file_unique_id",
        "file_size",
        "file_name",
        "mime_type",
        "width",
        "height",
        "duration",
        "performer",
        "title",
        "emoji",
        "set_name",
        "is_animated",
        "is_video",
    )
    if content_type == "photo":
        photos = message.photo or []
        if not photos:
            return {}
        metadata = metadata_fields(photos[-1], fields)
        metadata["photo_size_count"] = len(photos)
        return metadata
    attachment = getattr(message, content_type, None)
    return metadata_fields(attachment, fields) if attachment is not None else {}


def media_metadata(message: Message) -> dict[str, object] | None:
    content_type = getattr(message.content_type, "value", str(message.content_type))
    if content_type == "text":
        return None
    metadata = {"telegram_content_type": content_type}
    metadata.update(attachment_metadata(message, content_type))
    return metadata


def reply_presentation(message: Message) -> dict[str, object]:
    """Persist formatting with the authorized content, never read it from a live copy."""
    entities = getattr(
        message, "entities" if message.text is not None else "caption_entities", None
    )
    return {
        "telegram_entities": [
            entity.model_dump(mode="json", exclude_none=True) for entity in entities or []
        ],
        "has_media_spoiler": bool(getattr(message, "has_media_spoiler", False)),
        "show_caption_above_media": bool(getattr(message, "show_caption_above_media", False)),
    }


def operator_reply_snapshot(message: TicketMessage) -> dict[str, object]:
    """Reconstruct only the accepted revision, including pre-upgrade queued replies."""
    metadata = message.media or {}
    snapshot: dict[str, object] = {
        "message_id": message.source_message_id,
        "date": int(message.created_at.timestamp()),
        "chat": {"id": message.source_chat_id, "type": "supergroup"},
    }
    kind = metadata.get("telegram_content_type", "text")
    entities = metadata.get("telegram_entities", [])
    if kind == "text":
        if not message.content:
            raise ValueError("Accepted operator reply has no text")
        snapshot.update(text=message.content, entities=entities)
    elif kind in {"photo", "video", "document", "voice", "sticker"}:
        if not metadata.get("file_id"):
            raise ValueError("Accepted operator reply has no Telegram file")
        attachment = {
            field: metadata[field]
            for field in (
                "file_id",
                "file_unique_id",
                "file_size",
                "file_name",
                "mime_type",
                "width",
                "height",
                "duration",
                "is_animated",
                "is_video",
                "emoji",
            )
            if field in metadata
        }
        snapshot[kind] = [attachment] if kind == "photo" else attachment
        if kind == "sticker":
            attachment["type"] = "regular"
        snapshot.update(
            caption=message.content,
            caption_entities=entities,
            has_media_spoiler=metadata.get("has_media_spoiler", False),
            show_caption_above_media=metadata.get("show_caption_above_media", False),
        )
    else:
        raise ValueError("Unsupported accepted operator reply")
    return snapshot


def rating_keyboard(ticket_id: str, close_cycle: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text=f"⭐ {score}",
                    callback_data=f"{RATING_CALLBACK_PREFIX}:{ticket_id}:{close_cycle}:{score}",
                )
                for score in range(1, 6)
            ]
        ]
    )


def rating_report(ticket: TicketView, score: int, *, support_group_id: int) -> str:
    ticket_link = ticket_topic_link(support_group_id, ticket.topic_id)
    ticket_link_suffix = f"\n\n{ticket_link}" if ticket_link else ""
    return rating_text(rating_data(ticket, score), telegram=True) + ticket_link_suffix


def rated_ticket_closed_text(score: int) -> str:
    return f"{TICKET_CLOSED_SUMMARY_TEXT}\n\n⭐ <b>Ваша оценка: {'⭐' * score} {score}/5</b>"


def command_key(message: Message, command: str) -> str:
    return f"telegram:{message.chat.id}:{message.message_id}:{command}"
