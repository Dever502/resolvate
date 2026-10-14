import asyncio
import io
import shutil
import subprocess
import zlib
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile, is_zipfile

import pytest
from PIL import Image
from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject,
    DictionaryObject,
    EncodedStreamObject,
    NameObject,
    NumberObject,
    TextStringObject,
)

from resolvate.media_inspect import inspect


@pytest.mark.parametrize(
    "payload",
    [
        b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        b"<!DOCTYPE html><script>alert(1)</script>",
        b"MZ" + bytes(128),
        b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "example">]><x>&a;</x>',
    ],
    ids=["svg-script", "html-script", "executable", "xml-entity"],
)
async def test_disguised_active_files_are_rejected(tmp_path: Path, payload: bytes) -> None:
    from starlette.datastructures import Headers, UploadFile

    from resolvate.media_storage import LocalMediaStorage, MediaValidationError

    storage = LocalMediaStorage(tmp_path)
    upload = UploadFile(
        io.BytesIO(payload), filename="photo.png", headers=Headers({"content-type": "image/png"})
    )
    with pytest.raises(MediaValidationError):
        await storage.save_upload(upload)
    assert not list(storage.temp_root.iterdir())
    assert not list(storage.asset_root.rglob("*.png"))


@pytest.mark.parametrize("kind,mime", [("ogg", "audio/ogg"), ("mp4", "video/mp4")])
async def test_real_codecs_and_appended_payloads(tmp_path: Path, kind: str, mime: str) -> None:
    from starlette.datastructures import Headers, UploadFile

    from resolvate.media_storage import LocalMediaStorage, MediaValidationError

    executable = shutil.which("ffmpeg")
    if executable is None:
        pytest.skip("ffmpeg is required for native media validation")
    path = tmp_path / f"sample.{kind}"
    source = "anullsrc=r=48000:cl=mono" if kind == "ogg" else "color=c=black:s=32x32:r=10"
    codec = ["-c:a", "libopus"] if kind == "ogg" else ["-c:v", "libx264", "-pix_fmt", "yuv420p"]
    await asyncio.to_thread(
        subprocess.run,
        [
            executable,
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            source,
            "-t",
            "0.1",
            *codec,
            str(path),
        ],
        check=True,
        timeout=10,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    storage = LocalMediaStorage(tmp_path / "data")
    content = path.read_bytes()
    accepted = await storage.save_upload(
        UploadFile(io.BytesIO(content), filename=path.name, headers=Headers({"content-type": mime}))
    )
    assert accepted.mime_type == mime
    with pytest.raises(MediaValidationError):
        await storage.save_upload(
            UploadFile(
                io.BytesIO(content + b"PK\x03\x04payload"),
                filename=path.name,
                headers=Headers({"content-type": mime}),
            )
        )
    assert not list(storage.temp_root.iterdir())


def compressed_pdf(path: Path, sizes: list[int]) -> None:
    writer = PdfWriter()
    page = writer.add_blank_page(width=100, height=100)
    streams = ArrayObject()
    for size in sizes:
        compressor = zlib.compressobj()
        chunks = []
        while size:
            count = min(size, 64 * 1024)
            chunks.append(compressor.compress(b" " * count))
            size -= count
        stream = EncodedStreamObject()
        stream._data = b"".join(chunks) + compressor.flush()
        stream[NameObject("/Filter")] = NameObject("/FlateDecode")
        streams.append(writer._add_object(stream))
    page[NameObject("/Contents")] = streams
    writer.write(path)


def test_pdf_compressed_stream_bomb_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "expanded.pdf"
    compressed_pdf(path, [64 * 1024 * 1024 + 1])
    assert path.stat().st_size < 100_000
    with pytest.raises(ValueError):
        inspect(path)


def test_pdf_total_expansion_is_bounded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("resolvate.media_inspect.MAX_PDF_DECODED_BYTES", 100_000, raising=False)
    path = tmp_path / "many-streams.pdf"
    compressed_pdf(path, [60_000, 60_000])
    with pytest.raises(ValueError):
        inspect(path)


def test_regular_compressed_pdf_is_accepted(tmp_path: Path) -> None:
    path = tmp_path / "compressed.pdf"
    compressed_pdf(path, [100, 200])
    assert inspect(path) == "application/pdf"


def test_regular_image_pdf_is_accepted(tmp_path: Path) -> None:
    path = tmp_path / "photo.pdf"
    Image.new("RGB", (64, 32), "blue").save(path, format="PDF")
    assert inspect(path) == "application/pdf"


async def test_legacy_photo_entrypoint_bounds_download(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from typing import BinaryIO

    from resolvate.media_storage import LocalMediaStorage, MediaValidationError

    monkeypatch.setattr("resolvate.media_storage.MAX_WEB_PHOTO_BYTES", 32)
    attempts = 0

    class Downloader:
        async def download(self, file: str, destination: Path | BinaryIO) -> object:
            nonlocal attempts
            output = destination.open("wb") if isinstance(destination, Path) else destination
            try:
                for _ in range(10):
                    attempts += 1
                    output.write(b"x" * 10)
            finally:
                if isinstance(destination, Path):
                    output.close()
            return None

    storage = LocalMediaStorage(tmp_path)
    with pytest.raises(MediaValidationError):
        await storage.save_telegram_photo(Downloader(), file_id="test")
    assert attempts == 4  # Stop during download, not after all bytes reached disk.
    assert not list(storage.temp_root.iterdir())


def test_pdf_external_stream_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "external.pdf"
    writer = PdfWriter()
    page = writer.add_blank_page(width=100, height=100)
    stream = EncodedStreamObject()
    stream._data = b""
    stream[NameObject("/F")] = TextStringObject("external-content")
    page[NameObject("/Contents")] = writer._add_object(stream)
    writer.write(path)
    with pytest.raises(ValueError):
        inspect(path)


@pytest.mark.parametrize("size", [16, 100_000])
def test_pdf_image_raster_budget(tmp_path: Path, size: int) -> None:
    path = tmp_path / "image.pdf"
    writer = PdfWriter()
    page = writer.add_blank_page(width=100, height=100)
    stream = EncodedStreamObject()
    stream._data = zlib.compress(bytes(16 * 16 * 3))
    stream.update(
        {
            NameObject("/Type"): NameObject("/XObject"),
            NameObject("/Subtype"): NameObject("/Image"),
            NameObject("/Width"): NumberObject(size),
            NameObject("/Height"): NumberObject(size),
            NameObject("/BitsPerComponent"): NumberObject(8),
            NameObject("/ColorSpace"): NameObject("/DeviceRGB"),
            NameObject("/Filter"): NameObject("/FlateDecode"),
        }
    )
    page[NameObject("/Resources")] = DictionaryObject(
        {
            NameObject("/XObject"): DictionaryObject(
                {NameObject("/Im0"): writer._add_object(stream)}
            ),
        }
    )
    writer.write(path)
    if size == 16:
        assert inspect(path) == "application/pdf"
    else:
        with pytest.raises(ValueError, match="size limit"):
            inspect(path)


async def test_pdf_bomb_is_rejected_at_upload_boundary(tmp_path: Path) -> None:
    from starlette.datastructures import Headers, UploadFile

    from resolvate.media_storage import LocalMediaStorage, MediaValidationError

    path = tmp_path / "bomb.pdf"
    compressed_pdf(path, [64 * 1024 * 1024 + 1])
    storage = LocalMediaStorage(tmp_path / "data")
    with path.open("rb") as source:
        upload = UploadFile(
            source, filename="safe.pdf", headers=Headers({"content-type": "application/pdf"})
        )
        with pytest.raises(MediaValidationError):
            await storage.save_upload(upload)
    assert not list(storage.temp_root.iterdir())
    assert not list(storage.asset_root.rglob("*.pdf"))


def test_image_with_disguised_zip_trailer_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "polyglot.png"
    Image.new("RGB", (16, 16), "blue").save(path)
    with ZipFile(path, "a", compression=ZIP_STORED) as archive:
        archive.writestr("payload.txt", "not an image")
        archive.comment = b"IEND\xaeB`\x82"
    assert is_zipfile(path)
    with pytest.raises(ValueError):
        inspect(path)


@pytest.mark.parametrize("action", ["/JavaScript", "/Launch", "/SubmitForm"])
@pytest.mark.parametrize("indirect", [False, True])
def test_pdf_annotation_actions_are_rejected(tmp_path: Path, action: str, indirect: bool) -> None:
    path = tmp_path / "active.pdf"
    writer = PdfWriter()
    page = writer.add_blank_page(width=100, height=100)
    page[NameObject("/Annots")] = ArrayObject(
        [
            DictionaryObject(
                {
                    NameObject("/Type"): NameObject("/Annot"),
                    NameObject("/Subtype"): NameObject("/Link"),
                    NameObject("/Rect"): ArrayObject([NumberObject(n) for n in (0, 0, 50, 50)]),
                    NameObject("/A"): DictionaryObject(
                        {
                            NameObject("/S"): writer._add_object(NameObject(action))
                            if indirect
                            else NameObject(action),
                            NameObject("/F"): TextStringObject("test-target"),
                        }
                    ),
                }
            )
        ]
    )
    writer.write(path)
    with pytest.raises(ValueError, match="active PDF"):
        inspect(path)


def test_plain_pdf_is_preserved(tmp_path: Path) -> None:
    path = tmp_path / "plain.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    # The catalog's /URI base dictionary is metadata, not a URI action.
    writer.root_object[NameObject("/URI")] = DictionaryObject(
        {
            NameObject("/Base"): TextStringObject("https://example.com/"),
        }
    )
    writer.write(path)
    assert inspect(path) == "application/pdf"


@pytest.mark.parametrize(
    "uri",
    [
        "https://example.com",
        "mailto:support@example.com",
        "javascript:alert(1)",
        "file:///etc/passwd",
    ],
)
def test_pdf_links_allow_only_web_and_mail(tmp_path: Path, uri: str) -> None:
    from pypdf.annotations import Link

    path = tmp_path / "link.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.add_annotation(0, Link(rect=(0, 0, 50, 50), url=uri))
    writer.write(path)
    if uri.startswith(("https:", "mailto:")):
        assert inspect(path) == "application/pdf"
    else:
        with pytest.raises(ValueError, match="active PDF"):
            inspect(path)
