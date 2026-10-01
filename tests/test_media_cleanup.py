from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

import pytest
from project_support import ADMIN_ID, PROJECT_ID, ProjectDatabase

from resolvate import media_cleanup
from resolvate.config import Settings
from resolvate.database import Database
from resolvate.media_cleanup import cleanup_media_files
from resolvate.media_storage import LocalMediaStorage
from resolvate.models import Direction, Project, Ticket, TicketMessage, TranscriptMedia, User
from resolvate.web_models import MediaAsset


def test_media_cleanup_is_dry_run_by_default_and_preserves_references(tmp_path: Path) -> None:
    storage = LocalMediaStorage(tmp_path)
    storage._prepare()
    old = (datetime.now(UTC) - timedelta(days=2)).timestamp()
    temporary = storage.temp_root / "stale.upload"
    temporary.write_bytes(b"temporary")
    orphan = storage.asset_root / "aa" / "orphan.png"
    orphan.parent.mkdir(parents=True)
    orphan.write_bytes(b"orphan")
    linked = storage.asset_root / "bb" / "linked.png"
    linked.parent.mkdir(parents=True)
    linked.write_bytes(b"linked")
    for path in (temporary, orphan, linked):
        os.utime(path, (old, old))

    referenced = {linked.relative_to(tmp_path).as_posix()}
    preview = cleanup_media_files(storage, referenced_paths=referenced, apply=False)
    assert preview.temporary_files == 1
    assert preview.orphan_assets == 1
    assert preview.removed_files == 0
    assert temporary.exists() and orphan.exists() and linked.exists()

    applied = cleanup_media_files(storage, referenced_paths=referenced, apply=True)
    assert applied.removed_files == 2
    assert not temporary.exists() and not orphan.exists()
    assert linked.exists()


@pytest.mark.parametrize("apply", [False, True])
async def test_cleanup_cli_preserves_archive_only_reference(
    migrated_postgres_database_url: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    apply: bool,
) -> None:
    settings = Settings(
        _env_file=None, database_url=migrated_postgres_database_url, data_dir=tmp_path
    )
    monkeypatch.setattr(media_cleanup, "get_settings", lambda: settings)
    storage = LocalMediaStorage(tmp_path / "projects" / PROJECT_ID)
    storage._prepare()
    directory = storage.asset_root / "aa"
    directory.mkdir()
    linked, orphan, live = (
        directory / "archived.png",
        directory / "orphan.png",
        directory / "live.png",
    )
    other_id = "00000000-0000-4000-8000-000000000003"
    other_storage = LocalMediaStorage(tmp_path / "projects" / other_id)
    other_file = other_storage.asset_root / "aa" / "orphan.png"
    other_file.parent.mkdir(parents=True)
    old = (datetime.now(UTC) - timedelta(days=2)).timestamp()
    for path in (linked, orphan, live, other_file):
        path.write_bytes(b"fixture")
        os.utime(path, (old, old))
    database = ProjectDatabase(migrated_postgres_database_url)
    other_database = Database(migrated_postgres_database_url, project_id=other_id)
    try:
        async with database.session() as session:
            session.add(Project(id=other_id, name="Other project", admin_id=ADMIN_ID))
            user = User(display_name="Fixture")
            session.add(user)
            await session.flush()
            ticket = Ticket(user_id=user.id)
            session.add(ticket)
            await session.flush()
            message = TicketMessage(ticket_id=ticket.id, direction=Direction.USER_TO_OPERATOR)
            session.add(message)
            await session.flush()
            session.add(
                MediaAsset(
                    ticket_id=ticket.id,
                    message_id=message.id,
                    storage_path=live.relative_to(storage.data_dir).as_posix(),
                    mime_type="image/png",
                    size_bytes=7,
                    sha256="a" * 64,
                )
            )
            session.add_all(
                [
                    TranscriptMedia(
                        file_unique_id="archived",
                        file_id="dummy",
                        kind="photo",
                        state="stored",
                        storage_path=linked.relative_to(storage.data_dir).as_posix(),
                    ),
                    TranscriptMedia(file_unique_id="not-downloaded", file_id="dummy", kind="photo"),
                ]
            )
            await session.commit()
        async with other_database.session() as session:
            # This path is referenced only in the other project: it must not protect
            # the selected project's orphan, nor may cleanup touch the other file.
            session.add(
                TranscriptMedia(
                    file_unique_id="other",
                    file_id="dummy",
                    kind="photo",
                    state="stored",
                    storage_path=other_file.relative_to(other_storage.data_dir).as_posix(),
                )
            )
            await session.commit()
        result = await media_cleanup.run(apply=apply, project_id=UUID(PROJECT_ID))
        assert result.orphan_assets == 1
        assert result.removed_files == (1 if apply else 0)
        assert linked.exists()
        assert live.exists() and other_file.exists()
        assert orphan.exists() is not apply
    finally:
        await other_database.dispose()
        await database.dispose()


async def test_cleanup_unknown_project_does_not_delete_files(
    migrated_postgres_database_url: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    unknown = UUID("00000000-0000-4000-8000-000000000099")
    settings = Settings(
        _env_file=None, database_url=migrated_postgres_database_url, data_dir=tmp_path
    )
    monkeypatch.setattr(media_cleanup, "get_settings", lambda: settings)
    storage = LocalMediaStorage(tmp_path / "projects" / str(unknown))
    storage._prepare()
    old_file = storage.temp_root / "stale.upload"
    old_file.write_bytes(b"fixture")
    old = (datetime.now(UTC) - timedelta(days=2)).timestamp()
    os.utime(old_file, (old, old))
    with pytest.raises(ValueError, match="Project not found"):
        await media_cleanup.run(apply=True, project_id=unknown)
    assert old_file.exists()
