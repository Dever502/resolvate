from __future__ import annotations

import uuid
from typing import Any

from test_console import console as console
from test_console import customer

from resolvate.models import ConsoleSend, DeliveryOutbox, DeliveryStatus


async def test_history_delivery_projection_preserves_failures_and_revisions(console: Any) -> None:
    client, database, tickets, _, _, _ = console
    ticket_id = await customer(tickets)
    key = str(uuid.uuid4())
    sent = await client.post(
        f"/console/tickets/{ticket_id}/send",
        data={"text": "Answer"},
        headers={"X-Idempotency-Key": key},
    )
    assert sent.status_code == 200
    path = f"/console/tickets/{ticket_id}/sync"
    initial = (await client.post(path, json={})).json()
    known = {item["id"]: item["revision"] for item in initial["items"]}
    async with database.session() as session:
        command = await session.get(ConsoleSend, key)
        assert command is not None
        message_id = command.message_id
        ids = list(command.deliveries)
        assert len(ids) == 2
        # Bodies are durable retry snapshots, not part of a history status response.
        command.deliveries = {ident: {"text": "snapshot" * 1000} for ident in ids}
        first = await session.get(DeliveryOutbox, ids[0])
        second = await session.get(DeliveryOutbox, ids[1])
        assert first is not None and second is not None
        first.status, first.last_error = DeliveryStatus.FAILED, "definite refusal"
        second.status, second.last_error = DeliveryStatus.FAILED, "outcome_unknown"
        await session.commit()
    changed = (await client.post(path, json={"known": known})).json()
    assert len(changed["items"]) == 1
    item = changed["items"][0]
    assert item["id"] == message_id and item["command"] == key
    assert item["failed"] == [ids[0]] and item["uncertain"] is True
    assert item["text"] == "Answer"
    known[item["id"]] = item["revision"]
    assert (await client.post(path, json={"known": known})).json()["items"] == []
    async with database.session() as session:
        for ident in ids:
            job = await session.get(DeliveryOutbox, ident)
            assert job is not None
            job.status, job.last_error = DeliveryStatus.DELIVERED, None
        await session.commit()
    restored = (await client.post(path, json={"known": known})).json()["items"]
    assert len(restored) == 1
    assert restored[0]["failed"] == [] and restored[0]["uncertain"] is False
