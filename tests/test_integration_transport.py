import asyncio
import socket
from unittest.mock import AsyncMock

import httpx
import pytest

from resolvate.integration_transport import IntegrationTransport


@pytest.mark.parametrize(
    "address", ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "224.0.0.1"]
)
async def test_private_addresses_are_blocked(address: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        asyncio.get_running_loop(),
        "getaddrinfo",
        AsyncMock(return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))]),
    )
    async with httpx.AsyncClient(transport=IntegrationTransport()) as client:
        with pytest.raises(httpx.ConnectError, match="Private"):
            await client.get("https://integration.example/api")


async def test_public_address_is_pinned_with_original_tls_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resolver = AsyncMock(
        return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))]
    )
    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", resolver)

    async def handle(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "1.1.1.1"
        assert request.headers["host"] == "integration.example"
        assert request.extensions["sni_hostname"] == "integration.example"
        return httpx.Response(200, json={"ok": True})

    transport = IntegrationTransport()
    transport.transports[("integration.example", 443)] = httpx.MockTransport(handle)
    async with httpx.AsyncClient(transport=transport) as client:
        assert (await client.get("https://integration.example/api")).status_code == 200
    resolver.assert_awaited_once()


async def test_http_and_dns_errors_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", AsyncMock(side_effect=OSError))
    async with httpx.AsyncClient(transport=IntegrationTransport()) as client:
        for url in ("http://integration.example/api", "https://integration.example/api"):
            with pytest.raises(httpx.ConnectError):
                await client.get(url)
