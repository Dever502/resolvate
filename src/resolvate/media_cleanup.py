from __future__ import annotations

import argparse
import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from resolvate.config import get_settings
from resolvate.database import Database
from resolvate.media_storage import LocalMediaStorage
from resolvate.models import Project, TranscriptMedia
from resolvate.web_models import MediaAsset


@dataclass(frozen=True)
class CleanupResult:
    temporary_files: int
    orphan_assets: int
    removed_files: int


async def referenced_media_paths(session: AsyncSession) -> set[str]:
    """Protect both canonical and archive references in the session's project scope."""
    referenced = set((await session.scalars(select(MediaAsset.storage_path))).all())
    referenced.update(
        path
        for path in await session.scalars(
            select(TranscriptMedia.storage_path).where(TranscriptMedia.storage_path.is_not(None))
        )
        if path is not None
    )
    return referenced


def cleanup_media_files(
    storage: LocalMediaStorage,
    *,
    referenced_paths: set[str],
    apply: bool,
    now: datetime | None = None,
) -> CleanupResult:
    current = (now or datetime.now(UTC)).timestamp()
    temporary_cutoff = current - timedelta(hours=1).total_seconds()
    orphan_cutoff = current - timedelta(hours=24).total_seconds()
    temporary = (
        [
            path
            for path in storage.temp_root.glob("*")
            if path.is_file() and path.stat().st_mtime < temporary_cutoff
        ]
        if storage.temp_root.is_dir()
        else []
    )
    orphans = (
        [
            path
            for path in storage.asset_root.glob("**/*")
            if path.is_file()
            and path.relative_to(storage.data_dir).as_posix() not in referenced_paths
            and path.stat().st_mtime < orphan_cutoff
        ]
        if storage.asset_root.is_dir()
        else []
    )
    candidates = temporary + orphans
    if apply:
        for path in candidates:
            path.unlink(missing_ok=True)
    return CleanupResult(
        temporary_files=len(temporary),
        orphan_assets=len(orphans),
        removed_files=len(candidates) if apply else 0,
    )


async def run(*, apply: bool, project_id: UUID) -> CleanupResult:
    """Offline maintenance: stop application writers before applying deletions."""
    settings = get_settings()
    assert settings.database_url is not None
    database = Database(settings.database_url, project_id=str(project_id))
    try:
        async with database.session() as session:
            if await session.get(Project, str(project_id)) is None:
                raise ValueError("Project not found; no files changed")
            referenced_paths = await referenced_media_paths(session)
        return cleanup_media_files(
            LocalMediaStorage(settings.data_dir / "projects" / str(project_id)),
            referenced_paths=referenced_paths,
            apply=apply,
        )
    finally:
        await database.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Find stale temporary and unreferenced Web media files."
    )
    parser.add_argument(
        "--project", type=UUID, required=True, help="Project UUID from the operator panel."
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Delete candidates; stop the application first. Without this flag, only preview.",
    )
    arguments = parser.parse_args()
    result = asyncio.run(run(apply=arguments.apply, project_id=arguments.project))
    mode = "removed" if arguments.apply else "found"
    print(
        f"{mode}: temporary={result.temporary_files}, "
        f"orphan_assets={result.orphan_assets}, removed={result.removed_files}"
    )


if __name__ == "__main__":
    main()
