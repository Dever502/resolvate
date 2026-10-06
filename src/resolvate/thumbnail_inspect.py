"""Offline, resource-bounded thumbnail decoder. Never run in the HTTP process."""

import io
import resource
import sys
import warnings
from pathlib import Path

from PIL import Image, ImageOps

MAX_THUMBNAIL_BYTES = 256 * 1024


def thumbnail(path: Path) -> bytes:
    if not 0 < path.stat().st_size <= 20 * 1024 * 1024:
        raise ValueError("invalid original size")
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(path, formats=("JPEG", "PNG", "WEBP")) as source:
            if getattr(source, "n_frames", 1) != 1:
                raise ValueError("animated image")
            source.draft("RGB", (768, 768))
            picture = ImageOps.exif_transpose(source)
            picture.thumbnail((768, 768), Image.Resampling.LANCZOS)
            alpha = "A" in picture.getbands() or "transparency" in picture.info
            picture = picture.convert("RGBA" if alpha else "RGB")
            picture.info.clear()
            output = io.BytesIO()
            picture.save(output, format="WEBP", quality=75, method=3)
    content = output.getvalue()
    if len(content) > MAX_THUMBNAIL_BYTES:
        raise ValueError("thumbnail too large")
    return content


def main() -> None:
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    try:
        sys.stdout.buffer.write(thumbnail(Path(sys.argv[1])))
    except Exception:
        sys.exit(1)


if __name__ == "__main__":
    main()
