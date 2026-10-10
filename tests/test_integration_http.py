from __future__ import annotations

import asyncio
import gzip
import zlib
from collections.abc import AsyncIterator

import httpx
import pytest
from pydantic import SecretStr

from resolvate.integration_http import MAX_RESPONSE_BYTES, integration_request
from resolvate.remnawave import RemnawaveClient, RemnawaveUnknownOutcomeError


class ReplyStream(httpx.AsyncByteStream):
    def __init__(self, body: bytes, *, delay: float = 0) -> None:
        self.body = body
        self.delay = delay
        self.closed = False
        self.reads = 0

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for offset in range(0, len(self.body), 1024):
            await asyncio.sleep(self.delay)
            self.reads += 1
            yield self.body[offset : offset + 1024]

    async def aclose(self) -> None:
        self.closed = True


@pytest.mark.parametrize("encoding", ["identity", "gzip", "deflate"])
async def test_bounded_reply_accepts_json(encoding: str) -> None:
    body = b'{"response": {"ok": true}}'
    encoded = {"identity": body, "gzip": gzip.compress(body), "deflate": zlib.compress(body)}
    stream = ReplyStream(encoded[encoding])

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["accept-encoding"] == "identity"
        return httpx.Response(200, headers={"content-encoding": encoding}, stream=stream)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        reply = await integration_request(
            client, "GET", "https://example.com", timeout=1, headers={}
        )
    assert reply.json() == {"response": {"ok": True}}
    assert stream.closed


@pytest.mark.parametrize("compressed", [False, True])
async def test_oversized_reply_is_bounded_and_closed(compressed: bool) -> None:
    body = b"x" * (MAX_RESPONSE_BYTES + 1)
    stream = ReplyStream(gzip.compress(body) if compressed else body)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(
                200,
                headers={"content-encoding": "gzip" if compressed else "identity"},
                stream=stream,
            )
        )
    ) as client:
        with pytest.raises(httpx.ReadError, match="size limit"):
            await integration_request(client, "GET", "https://example.com", timeout=5, headers={})
    assert stream.closed


async def test_slow_drip_has_total_deadline() -> None:
    stream = ReplyStream(b"x" * 10000, delay=0.01)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=stream))
    ) as client:
        with pytest.raises(httpx.ReadTimeout, match="total deadline"):
            await integration_request(
                client, "GET", "https://example.com", timeout=0.025, headers={}
            )
    assert stream.closed
    assert stream.reads < 10


async def test_webhook_does_not_read_response_body_or_follow_redirect() -> None:
    stream = ReplyStream(b"x", delay=10)
    async with httpx.AsyncClient(
        follow_redirects=True,
        transport=httpx.MockTransport(
            lambda _: httpx.Response(
                302, headers={"location": "https://other.example"}, stream=stream
            )
        ),
    ) as client:
        reply = await integration_request(
            client, "POST", "https://example.com", timeout=1, headers={}, read_body=False
        )
    assert reply.status_code == 302
    assert stream.closed and stream.reads == 0


@pytest.mark.parametrize(
    "body",
    [b"not gzip", gzip.compress(b"{}", mtime=0)[:-2], gzip.compress(b"{}", mtime=0) + b"extra"],
    ids=["invalid-header", "truncated", "trailing-data"],
)
async def test_invalid_compressed_reply_is_closed(body: bytes) -> None:
    stream = ReplyStream(body)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, headers={"content-encoding": "gzip"}, stream=stream)
        )
    ) as client:
        with pytest.raises(httpx.DecodingError):
            await integration_request(client, "GET", "https://example.com", timeout=1, headers={})
    assert stream.closed


async def test_oversized_mutation_reply_remains_unknown_not_replayed() -> None:
    stream = ReplyStream(gzip.compress(b"x" * (MAX_RESPONSE_BYTES + 1)))
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, headers={"content-encoding": "gzip"}, stream=stream)
        )
    ) as client:
        panel = RemnawaveClient(
            base_url="https://example.com", api_token=SecretStr("test"), client=client
        )
        with pytest.raises(RemnawaveUnknownOutcomeError):
            await panel._request_json("/mutation", method="POST", mutation=True)
    assert stream.closed


@pytest.mark.parametrize("length", [MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES + 1])
async def test_preloaded_response_size_boundary(length: int) -> None:
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, content=b"x" * length))
    ) as client:
        if length > MAX_RESPONSE_BYTES:
            with pytest.raises(httpx.ReadError):
                await integration_request(
                    client, "GET", "https://example.com", timeout=1, headers={}
                )
        else:
            reply = await integration_request(
                client, "GET", "https://example.com", timeout=1, headers={}
            )
            assert len(reply.content) == length
