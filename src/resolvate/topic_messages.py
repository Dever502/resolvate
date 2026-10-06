"""Presentation of mirrored messages, never the content sent to a customer."""

from __future__ import annotations

import html
import uuid
from datetime import timedelta

from resolvate.models import DeliveryOutbox, DeliveryStatus, Direction, utcnow


def _units(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def topic_deliveries(
    *,
    ticket_id: str,
    key: str,
    payload: dict[str, object],
    content: str | None,
    author: str | None,
    operator: bool = False,
) -> list[DeliveryOutbox]:
    """Escape HTML and split without dropping text or exceeding Telegram limits."""
    label = "👤 ПОДДЕРЖКА" if operator else "👤 КЛИЕНТ"
    name = " ".join((author or "").split())[:80]
    heading = f"{label} · {name}" if name else label
    header = f"<b>{html.escape(heading)}</b>\n\n"
    remaining = content or ""
    jobs: list[DeliveryOutbox] = []
    now = utcnow()
    if payload.get("kind") == "send_sticker":
        # Stickers cannot carry captions: preserve the author as an ordered header.
        headers = topic_deliveries(
            ticket_id=ticket_id,
            key=key,
            payload={**payload, "kind": "send_text"},
            content=None,
            author=author,
            operator=operator,
        )
        sticker_payload = dict(payload)
        sticker_payload.pop("prepare_reopened_context", None)
        return [
            *headers,
            DeliveryOutbox(
                id=str(uuid.uuid4()),
                ticket_id=ticket_id,
                direction=Direction.USER_TO_OPERATOR,
                idempotency_key=f"{key}:sticker",
                payload=sticker_payload,
                status=headers[0].status,
                created_at=headers[-1].created_at + timedelta(microseconds=1),
            ),
        ]
    while remaining or not jobs:
        part_payload = dict(payload)
        if jobs:
            part_payload["kind"] = "send_text"
            for field in ("storage_path", "prepare_reopened_context"):
                part_payload.pop(field, None)
        limit = 4096 if part_payload.get("kind") == "send_text" else 1024
        budget = limit - _units(heading) - 2
        end = 0
        for char in remaining:
            cost = 2 if ord(char) > 0xFFFF else 1
            if cost > budget:
                break
            budget -= cost
            end += 1
        part, remaining = remaining[:end], remaining[end:]
        body = html.escape(part)
        part_payload.update(text=header + body, parse_mode="HTML")
        jobs.append(
            DeliveryOutbox(
                id=str(uuid.uuid4()),
                ticket_id=ticket_id,
                direction=Direction.USER_TO_OPERATOR,
                idempotency_key=key if not jobs else f"{key}:part:{len(jobs)}",
                payload=part_payload,
                status=DeliveryStatus.PENDING
                if payload.get("target_thread_id") is not None
                else DeliveryStatus.WAITING_TOPIC,
                created_at=now + timedelta(microseconds=len(jobs)),
            )
        )
    return jobs
