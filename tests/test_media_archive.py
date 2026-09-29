from __future__ import annotations

import io
import sys
import tarfile
from pathlib import Path

import pytest

from resolvate.media_archive import export_media, import_media


class BinaryInput:
    def __init__(self, payload: bytes) -> None:
        self.buffer = io.BytesIO(payload)


def archive(entries: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as tar:
        for name, content in entries.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            tar.addfile(info, io.BytesIO(content))
    return output.getvalue()


def test_media_archive_restore_replaces_media_atomically(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    current = tmp_path / "web-media" / "assets" / "old.jpg"
    current.parent.mkdir(parents=True)
    current.write_bytes(b"old")
    payload = archive({"web-media/assets/aa/new.png": b"new"})
    monkeypatch.setattr(sys, "stdin", BinaryInput(payload))

    size = import_media(tmp_path, apply=True)

    assert size == 3
    assert not current.exists()
    assert (tmp_path / "web-media" / "assets" / "aa" / "new.png").read_bytes() == b"new"


def test_media_archive_rejects_path_traversal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "stdin", BinaryInput(archive({"../outside": b"unsafe"})))
    with pytest.raises(ValueError, match="unsafe"):
        import_media(tmp_path, apply=True)
    assert not (tmp_path.parent / "outside").exists()


def test_project_media_round_trip_preserves_runtime_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source, destination = tmp_path / "source", tmp_path / "destination"
    first = "11111111-1111-1111-1111-111111111111"
    second = "22222222-2222-2222-2222-222222222222"
    files = {
        f"projects/{first}/web-media/assets/a.jpg": b"first",
        f"projects/{second}/transcript-media/b.mp4": b"second",
    }
    for relative, contents in files.items():
        path = source / relative
        path.parent.mkdir(parents=True)
        path.write_bytes(contents)
    (source / "projects" / first / "heartbeat").write_text("not media")
    link = source / "projects" / first / "web-media" / "escape"
    link.symlink_to(source / "projects" / first / "heartbeat")
    output = BinaryInput(b"")
    monkeypatch.setattr(sys, "stdout", output)
    export_media(source)
    payload = output.buffer.getvalue()
    with tarfile.open(fileobj=io.BytesIO(payload)) as tar:
        names = tar.getnames()
        assert not any("heartbeat" in name or "escape" in name for name in names)
    heartbeat = destination / "projects" / first / "heartbeat"
    heartbeat.parent.mkdir(parents=True)
    heartbeat.write_text("keep")
    monkeypatch.setattr(sys, "stdin", BinaryInput(payload))
    assert import_media(destination, apply=True) == 11
    assert heartbeat.read_text() == "keep"
    for relative, contents in files.items():
        assert (destination / relative).read_bytes() == contents


@pytest.mark.parametrize(
    "name",
    [
        "projects/not-a-project/web-media/test",
        "projects/11111111-1111-1111-1111-111111111111/heartbeat",
        "projects/11111111-1111-1111-1111-111111111111/web-media/../../../escape",
    ],
)
def test_project_archive_rejects_non_media_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    monkeypatch.setattr(sys, "stdin", BinaryInput(archive({name: b"unsafe"})))
    with pytest.raises(ValueError, match="unsafe"):
        import_media(tmp_path, apply=True)
