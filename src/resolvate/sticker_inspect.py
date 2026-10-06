"""Offline validation for Telegram stickers, invoked only in the bounded media process."""

from __future__ import annotations

import json
import math
import zlib
from pathlib import Path
from typing import Any

from PIL import Image

from resolvate.archive_compressor import probe

TGS_MIME = "application/x-tgsticker"
STICKER_LIMITS = {"static": 512 * 1024, "animated": 64 * 1024, "video": 256 * 1024}
MAX_TGS_JSON_BYTES = 2 * 1024 * 1024


def _number(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("invalid animation number")
    if not math.isfinite(value) or abs(value) > 1_000_000:
        raise ValueError("animation number out of bounds")
    return float(value)


def validate_tgs(data: bytes) -> dict[str, Any]:
    if not 0 < len(data) <= STICKER_LIMITS["animated"]:
        raise ValueError("TGS size")
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    try:
        raw = decoder.decompress(data, MAX_TGS_JSON_BYTES + 1)
    except zlib.error as error:
        raise ValueError("invalid TGS compression") from error
    if len(raw) > MAX_TGS_JSON_BYTES or not decoder.eof or decoder.unused_data:
        raise ValueError("oversized, incomplete or concatenated TGS")
    animation = json.loads(raw)
    if not isinstance(animation, dict):
        raise ValueError("invalid TGS root")
    if animation.get("w") != 512 or animation.get("h") != 512:
        raise ValueError("TGS dimensions")
    frames = _number(animation.get("op")) - _number(animation.get("ip"))
    fps = _number(animation.get("fr"))
    if not 0 < fps <= 60 or not 0 < frames <= fps * 3:
        raise ValueError("TGS duration")
    # No images, fonts, expressions or effects: this is vector sticker data, not
    # an arbitrary Lottie document. Bound work before passing data to the browser.
    pending: list[tuple[Any, int]] = [(animation, 0)]
    count = 0
    while pending:
        value, depth = pending.pop()
        count += 1
        if count > 100_000 or depth > 40:
            raise ValueError("TGS complexity")
        if isinstance(value, dict):
            if value.keys() & {"__proto__", "constructor", "prototype", "ef", "fonts", "chars"}:
                raise ValueError("unsupported TGS feature")
            if isinstance(value.get("x"), str) or isinstance(value.get("p"), str):
                raise ValueError("TGS expression or resource")
            if value.get("ty") == "rp" or value.get("ddd", 0) != 0:
                raise ValueError("TGS repeater or 3D")
            pending.extend((child, depth + 1) for child in value.values())
        elif isinstance(value, list):
            if len(value) > 4096:
                raise ValueError("TGS array length")
            pending.extend((child, depth + 1) for child in value)
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            _number(value)
        elif isinstance(value, str) and len(value) > 1024:
            raise ValueError("TGS string length")
    assets = animation.get("assets", [])
    if not isinstance(assets, list) or len(assets) > 128:
        raise ValueError("TGS assets")
    compositions: dict[str, Any] = {}
    for asset in assets:
        if not isinstance(asset, dict) or set(asset) - {"id", "layers", "nm"}:
            raise ValueError("TGS external asset")
        ident = asset.get("id")
        if not isinstance(ident, str) or ident in compositions:
            raise ValueError("TGS asset identity")
        compositions[ident] = asset.get("layers")
    expanded = 0
    expanded_bytes = 0

    def layers(items: Any, ancestors: frozenset[str]) -> None:
        nonlocal expanded, expanded_bytes
        if not isinstance(items, list) or len(ancestors) > 16:
            raise ValueError("TGS composition")
        by_id: dict[int, dict[str, Any]] = {}
        for layer in items:
            if not isinstance(layer, dict):
                raise ValueError("TGS layer")
            ident = layer.get("ind")
            if not isinstance(ident, int) or isinstance(ident, bool) or ident in by_id:
                raise ValueError("TGS layer identity")
            by_id[ident] = layer
        for ident in by_id:
            visited: set[int] = set()
            current: int | None = ident
            while current is not None:
                if current in visited or current not in by_id or len(visited) > 32:
                    raise ValueError("TGS parent cycle or missing parent")
                visited.add(current)
                current = by_id[current].get("parent")
        for layer in items:
            expanded += 1
            expanded_bytes += len(json.dumps(layer))
            if expanded_bytes > MAX_TGS_JSON_BYTES:
                raise ValueError("TGS expanded composition complexity")
            for dimension in ("w", "h"):
                if dimension in layer and not 0 < _number(layer[dimension]) <= 512:
                    raise ValueError("TGS layer dimensions")
            if expanded > 512 or not isinstance(layer, dict) or layer.get("ty") not in {0, 3, 4}:
                raise ValueError("TGS layer")
            if layer.get("ty") == 0:
                ref = layer.get("refId")
                if not isinstance(ref, str) or ref not in compositions or ref in ancestors:
                    raise ValueError("TGS cyclic or missing composition")
                layers(compositions[ref], ancestors | {ref})

    layers(animation.get("layers"), frozenset())
    for ident, items in compositions.items():
        layers(items, frozenset({ident}))
    return animation


def validate_webm(data: bytes) -> None:
    """Require one complete WebM segment; reject appended files and embedded attachments."""

    def integer(offset: int, *, size: bool) -> tuple[int, int]:
        if offset >= len(data) or data[offset] == 0:
            raise ValueError("invalid WebM integer")
        length = 9 - data[offset].bit_length()
        if length > (8 if size else 4) or offset + length > len(data):
            raise ValueError("invalid WebM integer length")
        value = int.from_bytes(data[offset : offset + length], "big")
        if size:
            value &= (1 << (7 * length)) - 1
            if value == (1 << (7 * length)) - 1:
                value = -1
        return value, offset + length

    def element(offset: int) -> tuple[int, int, int]:
        ident, start = integer(offset, size=False)
        length, start = integer(start, size=True)
        end = len(data) if length == -1 and ident == 0x18538067 else start + length
        if end < start or end > len(data):
            raise ValueError("truncated WebM")
        return ident, start, end

    ident, start, end = element(0)
    if ident != 0x1A45DFA3:
        raise ValueError("invalid WebM header")
    header_end, doctype = end, None
    while start < header_end:
        ident, content, end = element(start)
        if end > header_end:
            raise ValueError("invalid WebM header length")
        if ident == 0x4282:
            doctype = data[content:end]
        start = end
    if doctype != b"webm":
        raise ValueError("not WebM")
    ident, start, end = element(header_end)
    if ident != 0x18538067 or end != len(data):
        raise ValueError("invalid or appended WebM segment")
    while start < len(data):
        ident, _, end = element(start)
        if ident not in {
            0x114D9B74,
            0x1549A966,
            0x1654AE6B,
            0x1F43B675,
            0x1C53BB6B,
            0x1254C367,
            0xEC,
            0xBF,
        }:
            raise ValueError("unsupported WebM element")
        start = end


def inspect_sticker(path: Path, kind: str) -> str:
    if kind not in STICKER_LIMITS or not 0 < path.stat().st_size <= STICKER_LIMITS[kind]:
        raise ValueError("sticker size or type")
    if kind == "animated":
        validate_tgs(path.read_bytes())
        return TGS_MIME
    if kind == "static":
        from resolvate.media_inspect import inspect

        mime = inspect(path)
        if mime not in {"image/webp", "image/png"}:
            raise ValueError("sticker image type")
        with Image.open(path) as image:
            if max(image.size) != 512 or min(image.size) < 1:
                raise ValueError("sticker dimensions")
        return mime
    validate_webm(path.read_bytes())
    info = probe(path, format_whitelist="matroska,webm")
    streams = info.get("streams", [])
    duration = _number(float(info.get("format", {}).get("duration", 0)))
    if len(streams) != 1 or not 0 < duration <= 3.1:
        raise ValueError("sticker duration or streams")
    stream = streams[0]
    if stream.get("codec_type") != "video" or stream.get("codec_name") != "vp9":
        raise ValueError("sticker codec")
    width, height = stream.get("width", 0), stream.get("height", 0)
    if min(width, height) <= 0 or max(width, height) != 512:
        raise ValueError("sticker dimensions")
    numerator, denominator = str(stream.get("avg_frame_rate", "0/1")).split("/")
    fps = _number(float(numerator) / float(denominator))
    if not 0 < fps <= 30:
        raise ValueError("sticker frame rate")
    return "video/webm"
