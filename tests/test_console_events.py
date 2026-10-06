from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy import delete, select, update
from test_console import console as console
from test_console import customer

from resolvate.console_events import ConsoleEvents, Subscription
from resolvate.models import DeliveryOutbox, DeliveryStatus, ProjectMember, Ticket, TicketMessage
from resolvate.outbox_repository import OutboxRepository


async def test_events_coalesce_isolate_and_release() -> None:
    hub = ConsoleEvents()
    first = hub.subscribe("one", "operator")
    other = hub.subscribe("two", "operator")

    async def authorize() -> None:
        return None

    stream = hub.stream(first, authorize, heartbeat=0.01, debounce=0)
    assert "event: ready" in await anext(stream)
    for _ in range(100):
        hub.publish("one")
    assert first.changed.is_set() and not other.changed.is_set()
    assert await anext(stream) == "event: change\ndata: {}\n\n"
    assert not first.changed.is_set()
    assert await anext(stream) == ": heartbeat\n\n"
    await stream.aclose()
    assert first not in hub.listeners


@pytest.mark.parametrize("changed", [True, False])
async def test_stream_rechecks_access_before_changes_and_heartbeat(changed: bool) -> None:
    hub = ConsoleEvents()
    item = hub.subscribe("project", "account")
    allowed = True

    async def authorize() -> None:
        if not allowed:
            raise HTTPException(403)

    stream = hub.stream(item, authorize, heartbeat=0.001, debounce=0)
    await anext(stream)
    allowed = False
    if changed:
        hub.publish("project")
    assert 'event: revoked\ndata: {"status":403}' in await anext(stream)
    with pytest.raises(StopAsyncIteration):
        await anext(stream)
    assert not hub.listeners


async def test_connection_limits_and_cancellation() -> None:
    hub = ConsoleEvents()
    for _ in range(4):
        hub.subscribe("project", "account")
    with pytest.raises(HTTPException) as error:
        hub.subscribe("other-project", "account")
    assert error.value.status_code == 429
    hub.listeners.clear()
    for index in range(256):
        hub.subscribe("project", str(index))
    with pytest.raises(HTTPException):
        hub.subscribe("project", "extra")
    hub.listeners.clear()
    item = hub.subscribe("project", "account")

    async def authorize() -> None:
        pass

    stream = hub.stream(item, authorize)
    await anext(stream)
    waiting = asyncio.create_task(anext(stream))
    await asyncio.sleep(0)
    waiting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiting
    assert not hub.listeners


async def test_changes_publish_only_after_commit_and_do_not_echo_receipts(console: Any) -> None:
    client, database, tickets, _, actor, _ = console
    hub = database.console_events
    own = hub.subscribe(database.project_id, actor.id)
    other = hub.subscribe("another-project", actor.id)
    assert database.for_project(database.project_id).console_events is hub
    ticket_id = await customer(tickets)
    assert own.changed.is_set() and not other.changed.is_set()
    own.changed.clear()
    async with database.session() as session:
        ticket = await session.get(Ticket, ticket_id)
        ticket.topic_id = 200
        await session.flush()
        assert not own.changed.is_set()
        await session.rollback()
        await session.commit()
        assert not own.changed.is_set()
        await session.execute(update(Ticket).where(Ticket.id == ticket_id).values(topic_id=201))
        assert not own.changed.is_set()
        await session.commit()
        assert own.changed.is_set()
    own.changed.clear()
    messages = (await client.post(f"/console/tickets/{ticket_id}/sync", json={})).json()
    assert not own.changed.is_set()
    await client.post(f"/console/tickets/{ticket_id}/read/{messages['items'][0]['id']}")
    assert not own.changed.is_set()
    async with database.session() as session:
        job = await session.scalar(select(DeliveryOutbox.id))
        await session.execute(
            update(DeliveryOutbox)
            .where(DeliveryOutbox.id == job)
            .values(status=DeliveryStatus.PROCESSING, claim_token="test-claim", attempt_count=8)
        )
        await session.commit()
        assert not own.changed.is_set()
    assert await OutboxRepository(database).mark_delivery_retry(
        job,
        claim_token="test-claim",
        error="test failure",
        retry_after_seconds=1,
        max_attempts=8,
    )
    assert own.changed.is_set()
    own.changed.clear()
    async with database.session() as session:
        await session.execute(
            update(TicketMessage)
            .where(TicketMessage.ticket_id == ticket_id)
            .values(content="Edited")
        )
        await session.commit()
    assert own.changed.is_set()


async def test_sse_http_headers_auth_and_live_membership_revocation(
    console: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, database, _, _, actor, _ = console
    original = ConsoleEvents.stream

    async def finite(self: ConsoleEvents, item: Subscription, authorize: Any) -> AsyncIterator[str]:
        stream = original(self, item, authorize, heartbeat=0.001, debounce=0)
        try:
            yield await anext(stream)
            async with database.session() as session:
                await session.execute(
                    delete(ProjectMember).where(ProjectMember.account_id == actor.id)
                )
                await session.commit()
            yield await anext(stream)
        finally:
            await stream.aclose()

    monkeypatch.setattr(ConsoleEvents, "stream", finite)
    assert (
        await client.get("/console/events", headers={"Origin": "https://foreign.example"})
    ).status_code == 403
    response = await client.get("/console/events")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["x-accel-buffering"] == "no"
    assert response.headers["cache-control"] == "no-store"
    assert "event: ready" in response.text and '"status":403' in response.text
    assert not database.console_events.listeners
    assert (await client.get("/console/events")).status_code == 403
    client.cookies.clear()
    assert (await client.get("/console/events")).status_code == 401
