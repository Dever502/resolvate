"""Bounded, process-local change hints; canonical data always comes from authorized APIs."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field

from fastapi import HTTPException


@dataclass(eq=False)
class Subscription:
    project_id: str
    account_id: str
    changed: asyncio.Event = field(default_factory=asyncio.Event)


class ConsoleEvents:
    def __init__(self) -> None:
        self.listeners: set[Subscription] = set()

    def subscribe(self, project_id: str, account_id: str) -> Subscription:
        if (
            len(self.listeners) >= 256
            or sum(item.account_id == account_id for item in self.listeners) >= 4
        ):
            raise HTTPException(429, "Слишком много открытых панелей.")
        item = Subscription(project_id, account_id)
        self.listeners.add(item)
        return item

    def publish(self, project_id: str) -> None:
        for item in self.listeners:
            if item.project_id == project_id:
                item.changed.set()  # Coalesce instead of accumulating an unbounded queue.

    async def unsubscribe(self, item: Subscription) -> None:
        # StreamingResponse background cleanup must stay on the event loop, not a worker thread.
        self.listeners.discard(item)

    async def stream(
        self,
        item: Subscription,
        authorize: Callable[[], Awaitable[None]],
        *,
        heartbeat: float = 10,
        debounce: float = 0.5,
    ) -> AsyncIterator[str]:
        try:
            # Revalidate after subscribing to close the connection-establishment race.
            await authorize()
            yield "event: ready\ndata: {}\n\n"
            while True:
                try:
                    await asyncio.wait_for(item.changed.wait(), heartbeat)
                except TimeoutError:
                    await authorize()
                    yield ": heartbeat\n\n"
                    continue
                await asyncio.sleep(debounce)
                item.changed.clear()
                await authorize()
                yield "event: change\ndata: {}\n\n"
        except HTTPException as error:
            yield f'event: revoked\ndata: {{"status":{error.status_code}}}\n\n'
        finally:
            self.listeners.discard(item)


# Ignore receipts/queue claims: broadcasting them would create refresh feedback loops.
VISIBLE_TABLES = frozenset(
    {"tickets", "ticket_messages", "ticket_folders", "users", "media_assets", "quick_responses"}
)
