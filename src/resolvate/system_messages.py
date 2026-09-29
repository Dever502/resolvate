"""Channel-independent system events; Telegram HTML is only a presentation format."""

from __future__ import annotations

import html
from html.parser import HTMLParser
from typing import Any

from resolvate.service_types import TicketView
from resolvate.telegram_constants import TICKET_CLOSED_SUMMARY_TEXT, TICKET_CLOSED_TEXT


class _PlainText(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "br":
            self.parts.append("\n")


def plain_system_text(value: str) -> str:
    """For explicitly HTML-formatted system messages, never for user content."""
    parser = _PlainText()
    parser.feed(value)
    parser.close()
    return "".join(parser.parts)


def operator_system_text(content: str, metadata: dict[str, Any]) -> str:
    if metadata.get("system_event") == "ticket_closed" or content in {
        TICKET_CLOSED_TEXT,
        TICKET_CLOSED_SUMMARY_TEXT,
    }:
        return "✅ Обращение закрыто"
    return content


def rating_data(ticket: TicketView, score: int) -> dict[str, Any]:
    return {
        "ticket_id": ticket.id,
        "score": score,
        "display_name": ticket.display_name,
        "username": ticket.username,
        "telegram_user_id": ticket.telegram_user_id,
        "email": getattr(ticket, "email", None),
        "identity_value": getattr(ticket, "identity_value", None),
    }


def rating_text(data: dict[str, Any], *, telegram: bool = False) -> str:
    def safe(value: object) -> str:
        return html.escape(str(value)) if telegram else str(value)

    def bold(value: object) -> str:
        return f"<b>{safe(value)}</b>" if telegram else safe(value)

    score = int(data["score"])
    if score not in range(1, 6):
        raise ValueError("score must be between 1 and 5")
    name, username = data.get("display_name"), data.get("username")
    identity = " · ".join(
        str(part) for part in (name, f"@{username}" if username else None) if part
    )
    if not identity:
        identity = str(data.get("email") or data.get("identity_value") or "Клиент")
    text = (
        f"⭐ {bold('Оценка поддержки')}\n\n"
        f"Оценка: {'⭐' * score} {bold(f'{score}/5')}\n\n"
        f"👤 {bold('Клиент')}\n\n{bold(identity)}"
    )
    if data.get("telegram_user_id") is not None:
        value = safe(data["telegram_user_id"])
        text += f"\nTelegram ID: {f'<code>{value}</code>' if telegram else value}"
    else:
        for title, key in (("Email", "email"), ("ID клиента", "identity_value")):
            if data.get(key):
                text += f"\n{title}: {safe(data[key])}"
    return text
