"""Small immutable logo files, authorized independently of project runtime state."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from fastapi import HTTPException
from starlette.datastructures import UploadFile

from resolvate.archive_media_storage import ArchiveStorageFull
from resolvate.models import ConsoleAccount
from resolvate.projects import ProjectService, membership

MAX_LOGO_BYTES = 2 * 1024 * 1024
logger = logging.getLogger(__name__)


class ProjectBranding:
    def __init__(self, projects: ProjectService) -> None:
        self.projects = projects
        self.slots = asyncio.Semaphore(2)
        # Single application instance: serialize publishing and old-file cleanup.
        self.mutations = asyncio.Lock()

    def _root(self, project_id: str) -> Path:
        return self.projects.settings.data_dir / "projects" / project_id / "branding"

    async def authorize(self, actor: ConsoleAccount, project_id: str) -> None:
        async with self.projects.database.session() as session:
            await self.projects._project(session, actor, project_id)

    async def upload(self, actor: ConsoleAccount, project_id: str, upload: UploadFile) -> str:
        try:
            await self.authorize(actor, project_id)
            if upload.content_type not in {"image/png", "image/jpeg", "image/webp"}:
                raise HTTPException(422, "Логотип: PNG, JPEG или WebP до 2 МБ.")
            content = await upload.read(MAX_LOGO_BYTES + 1)
            if not content or len(content) > MAX_LOGO_BYTES:
                raise HTTPException(422, "Логотип пустой или больше 2 МБ.")
            async with self.slots:
                png = await asyncio.to_thread(self._normalize, content)
            sha256 = hashlib.sha256(png).hexdigest()
            await self._replace(actor, project_id, sha256, png)
            return sha256
        finally:
            await upload.close()

    @staticmethod
    def _normalize(content: bytes) -> bytes:
        try:
            with tempfile.TemporaryDirectory(prefix="resolvate-logo-") as directory:
                path = Path(directory) / "input"
                path.write_bytes(content)
                result = subprocess.run(
                    [sys.executable, "-m", "resolvate.logo_inspect", str(path)],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    timeout=15,
                    check=True,
                    env={
                        "PATH": os.defpath,
                        "PYTHONPATH": str(Path(__file__).parent.parent),
                        "PYTHONDONTWRITEBYTECODE": "1",
                    },
                )
            if (
                not result.stdout.startswith(b"\x89PNG\r\n\x1a\n")
                or len(result.stdout) > MAX_LOGO_BYTES
            ):
                raise ValueError("invalid normalized logo")
            return result.stdout
        except (subprocess.SubprocessError, ValueError, OSError):
            raise HTTPException(
                422, "Изображение не прошло проверку. Используйте PNG, JPEG или WebP."
            ) from None

    async def remove(self, actor: ConsoleAccount, project_id: str) -> None:
        await self._replace(actor, project_id, None, None)

    async def _replace(
        self, actor: ConsoleAccount, project_id: str, digest: str | None, png: bytes | None
    ) -> None:
        async with self.mutations:
            async with self.projects.database.session() as session:
                project = await self.projects._project(session, actor, project_id)
                old = project.logo_sha256
                if png is not None and digest is not None:
                    try:
                        await asyncio.to_thread(self._publish, project_id, digest, png)
                    except ArchiveStorageFull:
                        raise HTTPException(503, "Недостаточно места для логотипа.") from None
                project.logo_sha256 = digest
                self.projects._audit(session, actor, "project_logo_changed", project_id)
                await session.commit()
            if old and old != digest:
                try:
                    await asyncio.to_thread(self._path(project_id, old).unlink, missing_ok=True)
                except OSError:
                    logger.warning(
                        "Old project logo cleanup deferred", extra={"project_id": project_id}
                    )

    def _path(self, project_id: str, digest: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise HTTPException(404, "Логотип не найден.")
        return self._root(project_id) / f"{digest}.png"

    def _publish(self, project_id: str, digest: str, png: bytes) -> None:
        path = self._path(project_id, digest)
        path.parent.mkdir(parents=True, exist_ok=True)
        # Logos live outside message-media retention; replacing a logo removes its old file.
        if not path.exists():
            if (
                shutil.disk_usage(path.parent).free - len(png)
                < self.projects.settings.storage_reserve_bytes
            ):
                raise ArchiveStorageFull("insufficient disk reserve")
            with tempfile.NamedTemporaryFile(
                dir=path.parent, suffix=".tmp", delete=False
            ) as temporary:
                try:
                    temporary.write(png)
                    temporary.flush()
                    os.fsync(temporary.fileno())
                    os.replace(temporary.name, path)
                finally:
                    Path(temporary.name).unlink(missing_ok=True)

    async def read(self, actor: ConsoleAccount, project_id: str) -> bytes:
        async with self.mutations:
            project = await membership(
                self.projects.database.for_project(project_id), actor, active=False
            )
            if not project.logo_sha256:
                raise HTTPException(404, "Логотип не задан.")
            try:
                return await asyncio.to_thread(
                    self._path(project_id, project.logo_sha256).read_bytes
                )
            except FileNotFoundError:
                raise HTTPException(404, "Логотип не найден.") from None
