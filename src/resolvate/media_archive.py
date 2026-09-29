from __future__ import annotations

import argparse
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from uuid import UUID

from resolvate.config import get_settings

MAX_ARCHIVE_BYTES = 100 * 1024 * 1024 * 1024
MEDIA_NAMES = ("web-media", "transcript-media")


def _project_id(value: str) -> bool:
    try:
        return str(UUID(value)) == value
    except ValueError:
        return False


def _media_roots(data_dir: Path) -> list[Path]:
    roots = [data_dir / name for name in MEDIA_NAMES]
    projects = data_dir / "projects"
    if projects.is_dir() and not projects.is_symlink():
        for project in sorted(projects.iterdir()):
            if project.is_dir() and not project.is_symlink() and _project_id(project.name):
                roots.extend(project / name for name in MEDIA_NAMES)
    return roots


def export_media(data_dir: Path) -> None:
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|gz", format=tarfile.PAX_FORMAT) as archive:
        for root in _media_roots(data_dir):
            if not root.is_dir() or root.is_symlink():
                continue
            for path in (root, *sorted(root.rglob("*"))):
                if path.is_symlink() or not (path.is_dir() or path.is_file()):
                    continue
                archive.add(path, arcname=path.relative_to(data_dir), recursive=False)


def _safe_member(member: tarfile.TarInfo) -> PurePosixPath:
    path = PurePosixPath(member.name)
    allowed = bool(path.parts) and (
        path.parts[0] in MEDIA_NAMES
        or (
            len(path.parts) >= 3
            and path.parts[0] == "projects"
            and _project_id(path.parts[1])
            and path.parts[2] in MEDIA_NAMES
        )
    )
    if (
        path.is_absolute()
        or not allowed
        or ".." in path.parts
        or member.size < 0
        or not (member.isdir() or member.isfile())
    ):
        raise ValueError("media archive contains an unsafe entry")
    return path


def _replace_media(data_dir: Path, temporary_root: Path) -> None:
    # The application is stopped by restore.sh. Preserve project runtime files;
    # replace only media directories and roll back all replacements on failure.
    roots = {path.relative_to(data_dir) for path in _media_roots(data_dir)}
    roots.update(path.relative_to(temporary_root) for path in _media_roots(temporary_root))
    replacements: list[tuple[Path, Path, bool]] = []
    try:
        for relative in sorted(roots):
            restored, current = temporary_root / relative, data_dir / relative
            if current.is_symlink() or any(
                parent.is_symlink() for parent in current.parents if parent != data_dir
            ):
                raise ValueError("media destination contains a symlink")
            restored.mkdir(parents=True, exist_ok=True)
            current.parent.mkdir(parents=True, exist_ok=True)
            previous = temporary_root / "previous" / relative
            previous.parent.mkdir(parents=True, exist_ok=True)
            existed = current.exists()
            if existed:
                current.replace(previous)
            replacements.append((current, previous, existed))
            restored.replace(current)
    except Exception:
        for current, previous, existed in reversed(replacements):
            if current.exists():
                shutil.rmtree(current)
            if existed:
                previous.replace(current)
        raise


def import_media(data_dir: Path, *, apply: bool) -> int:
    temporary_root: Path | None = None
    total_size = 0
    if apply:
        data_dir.mkdir(parents=True, exist_ok=True)
        temporary_root = Path(tempfile.mkdtemp(prefix=".web-media-restore-", dir=data_dir))
    try:
        with tarfile.open(fileobj=sys.stdin.buffer, mode="r|gz") as archive:
            for member in archive:
                path = _safe_member(member)
                total_size += member.size
                if total_size > MAX_ARCHIVE_BYTES:
                    raise ValueError("media archive exceeds the safety limit")
                if not apply:
                    continue
                assert temporary_root is not None
                destination = temporary_root.joinpath(*path.parts)
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                if source is None:
                    raise ValueError("media archive file cannot be read")
                with source, destination.open("xb") as output:
                    shutil.copyfileobj(source, output, length=64 * 1024)
        if apply:
            assert temporary_root is not None
            _replace_media(data_dir, temporary_root)
        return total_size
    finally:
        if temporary_root is not None and temporary_root.exists():
            shutil.rmtree(temporary_root)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export, validate, or restore project media.")
    parser.add_argument("operation", choices=("export", "validate", "restore"))
    arguments = parser.parse_args()
    settings = get_settings()
    if arguments.operation == "export":
        export_media(settings.data_dir)
        return
    size = import_media(settings.data_dir, apply=arguments.operation == "restore")
    print(f"Validated media archive: {size} bytes", file=sys.stderr)


if __name__ == "__main__":
    main()
