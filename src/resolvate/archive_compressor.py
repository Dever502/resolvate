"""Bounded subprocess entry point. Never run untrusted decoders in the bot process."""

from __future__ import annotations

import json
import os
import resource
import subprocess
import sys
import warnings
from pathlib import Path
from typing import Any, cast

from PIL import Image, ImageOps


def photo(source: Path, target: Path) -> None:
    Image.MAX_IMAGE_PIXELS = 16_000_000
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(source, formats=("JPEG", "PNG", "WEBP")) as image:
            if getattr(image, "is_animated", False) or image.mode not in {"RGB", "RGBA", "L", "P"}:
                raise ValueError("unsupported photo")
            oriented = ImageOps.exif_transpose(image)
            converted = oriented.convert(
                "RGBA" if "A" in oriented.getbands() or "transparency" in oriented.info else "RGB"
            )
            converted.save(
                target,
                format="WEBP",
                lossless=True,
                method=3,
                icc_profile=image.info.get("icc_profile", b""),
            )
            with Image.open(target) as result:
                result.load()
                if (
                    result.size != converted.size
                    or result.convert(converted.mode).tobytes() != converted.tobytes()
                ):
                    raise ValueError("photo verification failed")


def probe(path: Path, *, format_whitelist: str = "mov") -> dict[str, Any]:
    # Video compression compares the original/output stream descriptions; adding
    # codec names there would incorrectly reject an intentional H.264 conversion.
    stream_fields = (
        "codec_type,codec_name,channels,sample_rate"
        if format_whitelist == "ogg"
        else "codec_type,width,height"
    )
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            format_whitelist,
            "-show_entries",
            f"stream={stream_fields}:format=duration",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=10,
    )
    return cast(dict[str, Any], json.loads(result.stdout))


def video(source: Path, target: Path) -> None:
    info = probe(source)
    streams = info["streams"]
    videos = [s for s in streams if s["codec_type"] == "video"]
    audios = [s for s in streams if s["codec_type"] == "audio"]
    duration = float(info["format"]["duration"])
    if (
        len(videos) != 1
        or len(audios) > 1
        or len(streams) != len(videos) + len(audios)
        or videos[0]["width"] * videos[0]["height"] > 3840 * 2160
        or not 0 < duration <= 600
    ):
        raise ValueError("video is outside compression limits")
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-nostdin",
            "-n",
            "-threads",
            "1",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            "mov",
            "-i",
            str(source),
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "23",
            "-threads",
            "1",
            "-c:a",
            "copy",
            "-f",
            "mp4",
            str(target),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=90,
    )
    output = probe(target)
    if abs(float(output["format"]["duration"]) - duration) > 0.25 or output["streams"] != streams:
        raise ValueError("video verification failed")


def main() -> None:
    kind, original, destination, max_size = sys.argv[1:]
    # Inherited by ffmpeg/ffprobe. Parent also enforces a wall-clock timeout and kills the group.
    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024**2, 768 * 1024**2))
    resource.setrlimit(resource.RLIMIT_CPU, (100, 100))
    resource.setrlimit(resource.RLIMIT_FSIZE, (int(max_size), int(max_size)))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.nice(10)
    if kind == "photo":
        photo(Path(original), Path(destination))
    elif kind == "video":
        video(Path(original), Path(destination))
    else:
        raise ValueError("unsupported media kind")


if __name__ == "__main__":
    main()
