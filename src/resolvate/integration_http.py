"""Bound integration replies before buffering or decompressing untrusted data."""

from __future__ import annotations

import asyncio
import zlib
from typing import Any

import httpx

MAX_RESPONSE_BYTES = 4 * 1024 * 1024


async def _read_body(response: httpx.Response, limit: int) -> bytes:
    # In-memory transports may return an already consumed response.
    if response.is_stream_consumed:
        if len(response.content) > limit:
            raise httpx.ReadError("Integration response exceeds size limit")
        return response.content
    encoding = response.headers.get("content-encoding", "identity").strip().lower()
    if encoding not in {"identity", "gzip", "deflate"}:
        raise httpx.DecodingError("Unsupported integration response encoding")
    decoder = (
        zlib.decompressobj(16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS)
        if encoding != "identity"
        else None
    )
    body = bytearray()
    received = 0
    try:
        async for chunk in response.aiter_raw():
            received += len(chunk)
            if received > limit:
                raise httpx.ReadError("Integration response exceeds size limit")
            decoded = decoder.decompress(chunk, limit - len(body) + 1) if decoder else chunk
            if len(body) + len(decoded) > limit:
                raise httpx.ReadError("Integration response exceeds size limit")
            body.extend(decoded)
        if decoder and (not decoder.eof or decoder.unused_data):
            raise httpx.DecodingError("Malformed compressed integration response")
    except zlib.error as error:
        raise httpx.DecodingError("Malformed compressed integration response") from error
    return bytes(body)


async def integration_request(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    timeout: float,  # noqa: ASYNC109 -- Applies to httpx I/O and the total asyncio deadline.
    headers: dict[str, str],
    json: dict[str, Any] | None = None,
    content: bytes | None = None,
    read_body: bool = True,
) -> httpx.Response:
    try:
        # The deadline covers DNS, headers and the entire body, not each chunk separately.
        async with asyncio.timeout(timeout):
            async with client.stream(
                method,
                url,
                headers={**headers, "Accept-Encoding": "identity"},
                json=json,
                content=content,
                timeout=timeout,
                follow_redirects=False,
            ) as response:
                body = await _read_body(response, MAX_RESPONSE_BYTES) if read_body else b""
                reply_headers = response.headers.copy()
                for name in ("content-encoding", "content-length", "transfer-encoding"):
                    reply_headers.pop(name, None)
                return httpx.Response(
                    response.status_code,
                    headers=reply_headers,
                    content=body,
                    request=response.request,
                )
    except TimeoutError as error:
        raise httpx.ReadTimeout("Integration request exceeded total deadline") from error
