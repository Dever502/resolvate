import uuid
from typing import Any

import pytest
import test_console

from resolvate.models import Direction, TicketMessage

console = test_console.console
customer = test_console.customer


async def history(client: Any, ticket_id: str) -> list[dict[str, Any]]:
    return (await client.post(f"/console/tickets/{ticket_id}/sync", json={})).json()["items"]


async def rows(client: Any) -> dict[str, Any]:
    return (await client.post("/console/tickets/sync", json={})).json()


async def telegram_note(
    tickets: Any, ticket_id: str, text: str, *, display: str | None, username: str | None
) -> None:
    assert await tickets.add_internal_note(
        ticket_id=ticket_id,
        operator_telegram_id=7,
        operator_display_name=display,
        operator_username=username,
        note=text,
        source_chat_id=-100123456,
        source_message_id=55,
        idempotency_key=str(uuid.uuid4()),
    )


async def command(client: Any, ticket_id: str, name: str, arguments: str = "") -> str:
    response = await client.post(
        f"/console/tickets/{ticket_id}/commands/{name}",
        json={"arguments": arguments},
        headers={"X-Idempotency-Key": str(uuid.uuid4())},
    )
    assert response.status_code == 200, response.text
    return str(response.json()["message"])


async def test_console_note_names_its_operator_in_history_and_in_notes(console: Any) -> None:
    client, _, tickets, _, actor, _ = console
    ticket_id = await customer(tickets)
    await command(client, ticket_id, "note", "Передать бухгалтерии")
    note = (await history(client, ticket_id))[-1]
    assert note["channel"] == "internal_note"
    assert note["author"] == actor.display_name
    assert note["text"] == "Передать бухгалтерии"
    assert note["system"] is False
    notes = await command(client, ticket_id, "notes")
    assert actor.display_name in notes
    assert "Передать бухгалтерии" in notes


@pytest.mark.parametrize(
    ("display", "username", "author"),
    [
        ("Ирина Соколова", "irina", "Ирина Соколова"),
        (None, "irina", "@irina"),
        ("   ", "irina", "@irina"),
    ],
)
async def test_telegram_note_author_is_its_display_name_then_username(
    console: Any, display: str | None, username: str | None, author: str
) -> None:
    client, _, tickets, _, _, _ = console
    ticket_id = await customer(tickets)
    await telegram_note(
        tickets, ticket_id, "Клиент ждёт звонка", display=display, username=username
    )
    assert (await history(client, ticket_id))[-1]["author"] == author


@pytest.mark.parametrize(
    ("media", "author"),
    [
        ({"operator_name": "Пётр из Telegram"}, "Пётр из Telegram"),
        ({"operator_telegram_id": 7}, "Оператор"),
        (None, "Оператор"),
    ],
)
async def test_older_notes_keep_a_stored_name_or_a_neutral_author(
    console: Any, media: dict[str, Any] | None, author: str
) -> None:
    client, database, tickets, _, _, _ = console
    ticket_id = await customer(tickets)
    async with database.session() as session:
        session.add(
            TicketMessage(
                ticket_id=ticket_id,
                direction=Direction.OPERATOR_TO_USER,
                channel="internal_note",
                content="Старая заметка",
                media=media,
            )
        )
        await session.commit()
    note = (await history(client, ticket_id))[-1]
    assert (note["text"], note["author"]) == ("Старая заметка", author)


async def test_customer_and_operator_messages_keep_their_authors(console: Any) -> None:
    client, _, tickets, _, actor, _ = console
    ticket_id = await customer(tickets)
    sent = await client.post(
        f"/console/tickets/{ticket_id}/send",
        data={"text": "Здравствуйте"},
        headers={"X-Idempotency-Key": str(uuid.uuid4())},
    )
    assert sent.status_code == 200, sent.text
    await telegram_note(tickets, ticket_id, "Внутренний контекст", display="Ирина", username=None)
    items = await history(client, ticket_id)
    assert [(item["channel"], item["author"]) for item in items] == [
        ("telegram", "Клиент"),
        ("console", actor.display_name),
        ("internal_note", "Ирина"),
    ]


async def test_list_names_a_latest_note_and_keeps_other_previews_and_order(console: Any) -> None:
    client, _, tickets, _, _, _ = console
    first = await customer(tickets)
    second = await tickets.accept_customer_message(
        telegram_user_id=10002,
        display_name="Второй клиент",
        username="second",
        source_chat_id=10002,
        source_message_id=1,
        target_chat_id=-100123456,
        content="Второй вопрос",
        media=None,
    )
    assert second.ticket
    listed = await rows(client)
    assert listed["order"] == [second.ticket.id, first]
    previews = {item["id"]: item["preview"] for item in listed["items"]}
    assert previews == {first: "Нужна помощь", second.ticket.id: "Второй вопрос"}

    await telegram_note(tickets, first, "Секрет для команды", display="Ирина", username=None)
    listed = await rows(client)
    # The note still counts as the dialogue's latest activity: the order follows it, as before.
    assert listed["order"] == [first, second.ticket.id]
    item = next(item for item in listed["items"] if item["id"] == first)
    assert item["preview"] == "Внутренняя заметка"
    assert "Секрет" not in str(listed)
    assert item["unread"] == 1

    # A later customer message is the preview again.
    await tickets.accept_customer_message(
        telegram_user_id=10001,
        display_name="Клиент",
        username="customer",
        source_chat_id=10001,
        source_message_id=2,
        target_chat_id=-100123456,
        content="Ещё вопрос",
        media=None,
    )
    item = next(item for item in (await rows(client))["items"] if item["id"] == first)
    assert item["preview"] == "Ещё вопрос"


async def test_a_system_notice_on_the_notes_channel_keeps_its_own_preview(console: Any) -> None:
    client, _, tickets, _, _, _ = console
    ticket_id = await customer(tickets)
    await tickets.record_rate_limit_notice(
        provider="telegram",
        identity="10001",
        key="rate-limit:telegram:notes",
        target_chat_id=-100123456,
    )
    item = next(item for item in (await rows(client))["items"] if item["id"] == ticket_id)
    assert "защита от спама" in item["preview"]
    assert (await history(client, ticket_id))[-1]["author"] == "Система"
