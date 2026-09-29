"""Offline, resource-bounded normalization of project logos to metadata-free PNG."""

import resource
import sys
from pathlib import Path

from PIL import Image, ImageOps

from resolvate.media_inspect import inspect


def normalize(path: Path) -> bytes:
    import io

    with path.open("rb") as source:
        header = source.read(12)
    if not (
        header.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff"))
        or (header[:4] == b"RIFF" and header[8:12] == b"WEBP")
    ):
        raise ValueError("unsupported logo")
    if inspect(path) not in {"image/jpeg", "image/png", "image/webp"}:
        raise ValueError("unsupported logo")
    with Image.open(path, formats=("JPEG", "PNG", "WEBP")) as source:
        picture = ImageOps.exif_transpose(source).convert("RGBA")
        picture.thumbnail((512, 512), Image.Resampling.LANCZOS)
        picture.info.clear()
        output = io.BytesIO()
        picture.save(output, format="PNG")
        return output.getvalue()


def main() -> None:
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    try:
        sys.stdout.buffer.write(normalize(Path(sys.argv[1])))
    except Exception:
        sys.exit(1)


if __name__ == "__main__":
    main()
