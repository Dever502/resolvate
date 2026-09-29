"""Validate a single bounded Ogg/Opus voice recording, never a playlist or archive."""

from __future__ import annotations

import math
from pathlib import Path

from resolvate.archive_compressor import probe


def inspect_voice(path: Path) -> str:
    # Consume the complete container: reject truncated, chained and appended files.
    serial: bytes | None = None
    sequence = 0
    ended = False
    with path.open("rb") as source:
        while header := source.read(27):
            if len(header) != 27 or header[:5] != b"OggS\x00" or ended:
                raise ValueError("invalid Ogg page")
            flags = header[5]
            if flags & ~7 or bool(flags & 2) != (sequence == 0):
                raise ValueError("invalid Ogg stream boundaries")
            if int.from_bytes(header[18:22], "little") != sequence:
                raise ValueError("invalid Ogg sequence")
            if serial is not None and header[14:18] != serial:
                raise ValueError("multiple Ogg streams")
            serial = header[14:18]
            segments = source.read(header[26])
            if len(segments) != header[26]:
                raise ValueError("truncated Ogg segments")
            body = source.read(sum(segments))
            if len(body) != sum(segments):
                raise ValueError("truncated Ogg payload")
            if sequence == 0 and (
                len(body) != 19
                or body[:8] != b"OpusHead"
                or body[8] != 1
                or body[9] not in {1, 2}
                or body[18] != 0
            ):
                raise ValueError("unsupported voice header")
            ended = bool(flags & 4)
            sequence += 1
    if not ended or sequence < 3:
        raise ValueError("incomplete voice recording")
    result = probe(path, format_whitelist="ogg")
    streams = result.get("streams", [])
    duration = float(result.get("format", {}).get("duration", 0))
    if (
        len(streams) != 1
        or streams[0].get("codec_type") != "audio"
        or streams[0].get("codec_name") != "opus"
        or streams[0].get("channels") not in {1, 2}
        or not math.isfinite(duration)
        or not 0 < duration <= 3600
    ):
        raise ValueError("unsupported voice recording")
    return "audio/ogg"
