"""Resource-bounded, offline attachment validation subprocess."""

from __future__ import annotations

import math
import resource
import sys
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import is_zipfile

MAX_PDF_STREAM_BYTES = 64 * 1024 * 1024
MAX_PDF_DECODED_BYTES = 128 * 1024 * 1024


def _pdf_stream_size(stream: object, remaining: int) -> int:
    from pypdf import apply_configuration
    from pypdf.filters import decode_stream_data
    from pypdf.generic import ArrayObject, NameObject, NullObject, NumberObject, StreamObject

    assert isinstance(stream, StreamObject)
    if "/F" in stream:
        raise ValueError("external PDF stream")
    filters = stream.get("/Filter", ArrayObject()).get_object()
    filters = filters if isinstance(filters, list) else [filters]
    filters = [item.get_object() for item in filters]
    if len(filters) > 8 or any(not isinstance(item, str) for item in filters):
        raise ValueError("PDF filter chain")
    params = stream.get("/DecodeParms", NullObject()).get_object()
    if isinstance(params, NullObject):
        params = [NullObject() for _ in filters]
    elif not isinstance(params, list):
        params = [params]
    if len(params) != len(filters):
        raise ValueError("PDF filter parameters")
    # Inspect compression envelopes, not image codecs: do not invoke jbig2dec or
    # render arbitrary PDF content. Image raster sizes have a separate budget.
    image_filters = {"/DCTDecode", "/DCT", "/JPXDecode", "/CCITTFaxDecode", "/CCF", "/JBIG2Decode"}
    if any(item in image_filters for item in filters[:-1]):
        raise ValueError("PDF image filter order")
    raster_bytes = 0
    if stream.get("/Subtype") == "/Image":
        width, height = stream.get("/Width"), stream.get("/Height")
        if width is not None and hasattr(width, "get_object"):
            width = width.get_object()
        if height is not None and hasattr(height, "get_object"):
            height = height.get_object()
        if not isinstance(width, int) or not isinstance(height, int) or min(width, height) <= 0:
            raise ValueError("PDF image dimensions")
        bits = stream.get("/BitsPerComponent", NumberObject(8)).get_object()
        if bits not in {1, 2, 4, 8, 16}:
            raise ValueError("PDF image bit depth")
        raster_bytes = width * height * 4 * (2 if bits == 16 else 1)
    if filters and filters[-1] in image_filters:
        if not raster_bytes:
            raise ValueError("PDF image filter outside image")
        filters, params = filters[:-1], params[:-1]
    limit = min(MAX_PDF_STREAM_BYTES, remaining)
    if limit <= 0 or raster_bytes > limit:
        raise ValueError("PDF decoded size limit")
    # A temporary stream avoids caching all decompressed bytes on the reader.
    envelope = StreamObject()
    envelope._data = stream._data
    envelope[NameObject("/Filter")] = ArrayObject(filters)
    envelope[NameObject("/DecodeParms")] = ArrayObject(params)
    with apply_configuration(
        zlib_maximum_output_length=limit + 1,
        lzw_maximum_output_length=limit + 1,
        run_length_maximum_output_length=limit + 1,
        image_maximum_buffer_size=limit + 1,
        jbig2dec_binary=None,
    ):
        size = max(len(decode_stream_data(envelope)), raster_bytes)
    if size > limit:
        raise ValueError("PDF decoded size limit")
    return size


def _reject_active_pdf(root: object) -> None:
    from pypdf.generic import IndirectObject, StreamObject

    pending = [root]
    visited: set[tuple[int, int] | int] = set()
    examined = 0
    decoded_bytes = 0
    while pending:
        examined += 1
        if examined > 100_000:
            raise ValueError("PDF object limit")
        value = pending.pop()
        if isinstance(value, IndirectObject):
            key = (value.idnum, value.generation)
            if key in visited:
                continue
            visited.add(key)
            pending.append(value.get_object())
        elif isinstance(value, dict):
            if id(value) in visited:
                continue
            visited.add(id(value))
            action = value.get("/S", "")
            if hasattr(action, "get_object"):
                action = action.get_object()
            if any(
                key in value
                for key in (
                    "/OpenAction",
                    "/AA",
                    "/AcroForm",
                    "/JavaScript",
                    "/JS",
                    "/EmbeddedFiles",
                    "/EF",
                    "/RichMediaContent",
                )
            ) or str(action) in {
                "/JavaScript",
                "/Launch",
                "/SubmitForm",
                "/ImportData",
                "/GoToR",
                "/GoToE",
                "/Rendition",
                "/Movie",
                "/Sound",
            }:
                raise ValueError("active PDF content")
            if str(action) == "/URI":
                uri = value.get("/URI", "")
                if hasattr(uri, "get_object"):
                    uri = uri.get_object()
                if not isinstance(uri, str) or urlsplit(uri).scheme.lower() not in {
                    "http",
                    "https",
                    "mailto",
                }:
                    raise ValueError("active PDF URI")
            if isinstance(value, StreamObject):
                decoded_bytes += _pdf_stream_size(value, MAX_PDF_DECODED_BYTES - decoded_bytes)
            pending.extend(value.values())
        elif isinstance(value, list):
            if id(value) not in visited:
                visited.add(id(value))
                pending.extend(value)


def inspect(path: Path) -> str:
    from pypdf import PdfReader
    from pypdf.errors import PyPdfError

    from resolvate.archive_compressor import probe
    from resolvate.media_storage import _decoded_photo_mime, _detected_mime

    # A ZIP comment can imitate a valid image/PDF terminator. Tail checks alone
    # do not exclude an appended, independently readable archive.
    if is_zipfile(path):
        raise ValueError("archive attachment")
    with path.open("rb") as source:
        header = source.read(16)
        source.seek(max(0, path.stat().st_size - 32))
        tail = source.read()
    mime = _detected_mime(header)
    if header.startswith(b"OggS"):
        from resolvate.voice_inspect import inspect_voice

        return inspect_voice(path)
    if mime in {"image/jpeg", "image/png", "image/webp"}:
        if mime == "image/jpeg" and not tail.endswith(b"\xff\xd9"):
            raise ValueError("trailing image data")
        if mime == "image/png" and not tail.endswith(b"IEND\xaeB`\x82"):
            raise ValueError("trailing image data")
        if (
            mime == "image/webp"
            and int.from_bytes(header[4:8], "little") + 8 != path.stat().st_size
        ):
            raise ValueError("trailing image data")
        return _decoded_photo_mime(path)
    if header.startswith(b"%PDF-") and tail.rstrip().endswith(b"%%EOF"):
        pdf = PdfReader(path, strict=True)
        if pdf.is_encrypted or not 1 <= len(pdf.pages) <= 1000:
            raise ValueError("unsupported PDF")
        root = pdf.trailer["/Root"]
        if not isinstance(root, dict):
            raise ValueError("invalid PDF root")
        try:
            _reject_active_pdf(root)
        except PyPdfError as error:
            raise ValueError("invalid or excessive PDF stream") from error
        return "application/pdf"
    if header[4:8] == b"ftyp":
        # ISO media boxes must occupy the whole file, not hide an appended archive.
        size = path.stat().st_size
        with path.open("rb") as source:
            offset = 0
            while offset < size:
                source.seek(offset)
                box = source.read(8)
                if len(box) != 8:
                    raise ValueError("truncated video")
                length = int.from_bytes(box[:4], "big")
                if length == 1:
                    length = int.from_bytes(source.read(8), "big")
                if length == 0:
                    length = size - offset
                if length < 8 or offset + length > size:
                    raise ValueError("invalid video box")
                offset += length
        result = probe(path)
        streams = result.get("streams", [])
        duration = float(result.get("format", {}).get("duration", 0))
        videos = [stream for stream in streams if stream.get("codec_type") == "video"]
        if (
            len(videos) != 1
            or len(streams) > 2
            or not math.isfinite(duration)
            or not 0 < duration <= 3600
        ):
            raise ValueError("unsupported video")
        if not 0 < videos[0].get("width", 0) * videos[0].get("height", 0) <= 3840 * 2160:
            raise ValueError("video dimensions")
        return "video/quicktime" if header[8:12] == b"qt  " else "video/mp4"
    raise ValueError("unsupported attachment")


def main() -> None:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    try:
        if len(sys.argv) == 3:
            from resolvate.sticker_inspect import inspect_sticker

            print(inspect_sticker(Path(sys.argv[1]), sys.argv[2]))
        else:
            print(inspect(Path(sys.argv[1])))
    except Exception:
        sys.exit(1)


if __name__ == "__main__":
    main()
