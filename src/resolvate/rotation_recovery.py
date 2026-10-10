"""Offline, explicitly verified recovery of uncertain Telegram topic rotation."""

from __future__ import annotations

import argparse
import asyncio
import json
import uuid
from typing import Any

from sqlalchemy import exists, select
from sqlalchemy.exc import IntegrityError

from resolvate.config import get_settings
from resolvate.database import Database
from resolvate.models import AccessAudit, Project, Ticket, TopicArchive, TranscriptMessage, utcnow
from resolvate.rotation_gate import lock_rotation_gate


class RotationRecovery:
    def __init__(self, database: Database) -> None:
        if database.project_id is None:
            raise ValueError("A project-scoped database is required")
        self.database = database

    async def inspect(self) -> list[dict[str, Any]]:
        async with self.database.session() as session:
            rows = await session.scalars(
                select(TopicArchive)
                .where(TopicArchive.state.not_in(("live", "archived")))
                .order_by(TopicArchive.created_at, TopicArchive.id)
            )
            return [
                {
                    key: getattr(row, key)
                    for key in (
                        "id",
                        "state",
                        "chat_id",
                        "topic_id",
                        "replacement_topic_id",
                        "replacement_token",
                        "revision",
                        "pending_writes",
                        "error_code",
                    )
                }
                for row in rows
            ]

    async def recover(
        self,
        archive_id: str,
        *,
        token: str,
        revision: int,
        empty_topic_id: int | None,
        confirmed_stopped: bool,
        confirmed_outcome: bool,
    ) -> None:
        """None means verified creation absence; an ID means verified empty replacement.

        Telegram cannot expose arbitrary topic history to bots. The caller must
        stop writers and verify the outcome manually; no Telegram request is made.
        """
        if not confirmed_stopped or not confirmed_outcome:
            raise ValueError("Stop application writers and verify the Telegram outcome first")
        if empty_topic_id is not None and empty_topic_id <= 0:
            raise ValueError("Replacement topic ID must be positive")
        async with self.database.session() as session:
            await lock_rotation_gate(session)
            archive = await session.get(TopicArchive, archive_id, with_for_update=True)
            if archive is None:
                raise ValueError("Archive not found in this project")
            if (
                archive.state not in {"uncertain", "creating"}
                or archive.replacement_token != token
                or archive.revision != revision
            ):
                raise ValueError("Recovery state changed; inspect again")
            ticket = await session.get(Ticket, archive.ticket_id, with_for_update=True)
            if (
                ticket is None
                or ticket.topic_id != archive.topic_id
                or not archive.complete
                or archive.pending_writes
            ):
                raise ValueError("Source is no longer current or its archive is incomplete")
            if empty_topic_id is None:
                if archive.replacement_topic_id is not None:
                    raise ValueError("A replacement is already registered; verify that topic")
            else:
                if empty_topic_id == archive.topic_id or archive.replacement_topic_id not in {
                    None,
                    empty_topic_id,
                }:
                    raise ValueError("Replacement does not match this rotation")
                if await session.scalar(select(exists().where(Ticket.topic_id == empty_topic_id))):
                    raise ValueError("Replacement is already a current ticket topic")
                replacement = await session.scalar(
                    select(TopicArchive)
                    .where(
                        TopicArchive.chat_id == archive.chat_id,
                        TopicArchive.topic_id == empty_topic_id,
                    )
                    .with_for_update()
                )
                if replacement is not None:
                    # Never adopt another archive, erase history, or clear arbitrary
                    # in-flight writes. Only the single uncertain setup send is recoverable.
                    if (
                        archive.replacement_topic_id != empty_topic_id
                        or replacement.ticket_id != archive.ticket_id
                        or replacement.state != "live"
                        or not replacement.complete
                        or replacement.pending_writes > 1
                        or await session.scalar(
                            select(
                                exists().where(
                                    TranscriptMessage.archive_id == replacement.id,
                                )
                            )
                        )
                    ):
                        raise ValueError("Replacement has history or is not an empty setup target")
                    replacement.pending_writes = 0
                else:
                    session.add(
                        TopicArchive(
                            ticket_id=archive.ticket_id,
                            chat_id=archive.chat_id,
                            topic_id=empty_topic_id,
                            complete=True,
                        )
                    )
                archive.replacement_topic_id = empty_topic_id
            # Re-run close-delay, media, queue and summary checks. A resumed
            # conversation stays on the source until the next eligible rotation.
            archive.state = "preparing"
            archive.mode = "replace"
            archive.prepared_revision = archive.revision
            archive.prepared_close_cycle = ticket.close_cycle
            archive.replacement_token = str(uuid.uuid4())
            archive.setup_message_id = None
            archive.error_code = None
            archive.next_attempt_at = utcnow()
            session.add(
                AccessAudit(
                    project_id=self.database.project_id,
                    action="rotation_recovered_empty"
                    if empty_topic_id
                    else "rotation_recovered_absent",
                    target_id=archive.id,
                )
            )
            try:
                await session.commit()
            except IntegrityError:
                raise ValueError("Topic is already registered; nothing changed") from None


async def run(arguments: argparse.Namespace) -> list[dict[str, Any]]:
    settings = get_settings()
    assert settings.database_url is not None
    database = Database(settings.database_url, project_id=str(arguments.project))
    try:
        async with database.session() as session:
            if await session.get(Project, str(arguments.project)) is None:
                raise ValueError("Project not found")
        recovery = RotationRecovery(database)
        if arguments.archive:
            if not arguments.token or arguments.revision is None:
                raise ValueError("Recovery requires --token and --revision from inspection")
            if not arguments.creation_absent and arguments.empty_topic is None:
                raise ValueError("Choose --creation-absent or --empty-topic")
            await recovery.recover(
                str(arguments.archive),
                token=str(arguments.token),
                revision=arguments.revision,
                empty_topic_id=arguments.empty_topic,
                confirmed_stopped=arguments.confirm_stopped,
                confirmed_outcome=arguments.confirm_verified,
            )
        return await recovery.inspect()
    finally:
        await database.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=uuid.UUID, required=True)
    parser.add_argument("--archive", type=uuid.UUID, help="Omit for read-only inspection")
    parser.add_argument("--token", type=uuid.UUID)
    parser.add_argument("--revision", type=int)
    choice = parser.add_mutually_exclusive_group()
    choice.add_argument("--creation-absent", action="store_true")
    choice.add_argument("--empty-topic", type=int, help="Verified empty topic in the SAME group")
    parser.add_argument("--confirm-stopped", action="store_true")
    parser.add_argument("--confirm-verified", action="store_true")
    arguments = parser.parse_args()
    if not arguments.archive and any(
        (
            arguments.token,
            arguments.revision is not None,
            arguments.creation_absent,
            arguments.empty_topic is not None,
            arguments.confirm_stopped,
            arguments.confirm_verified,
        )
    ):
        parser.error("Recovery flags require --archive")
    try:
        result = asyncio.run(run(arguments))
    except ValueError as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
