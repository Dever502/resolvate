"""Resource-bounded, offline attachment validation subprocess."""

from __future__ import annotations

import math
import resource
import sys
from pathlib import Path


def inspect(path: Path) -> str:
    from pypdf import PdfReader

    from resolvate.archive_compressor import probe
    from resolvate.media_storage import _decoded_photo_mime, _detected_mime

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
        if any(key in root for key in ("/OpenAction", "/AA", "/AcroForm")):
            raise ValueError("active PDF content")
        names = root.get("/Names", {})
        if hasattr(names, "get_object"):
            names = names.get_object()
        if any(key in names for key in ("/JavaScript", "/EmbeddedFiles")):
            raise ValueError("active PDF content")
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
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    try:
        print(inspect(Path(sys.argv[1])))
    except Exception:
        sys.exit(1)


if __name__ == "__main__":
    main()
