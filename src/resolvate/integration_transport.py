"""Project-configurable HTTP destinations must not reach the installation's private network."""

from __future__ import annotations

import asyncio
import ipaddress
import socket

import httpx


class IntegrationTransport(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        self.transports: dict[tuple[str, int], httpx.AsyncBaseTransport] = {}

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        if url.scheme != "https" or url.username or url.password:
            raise httpx.ConnectError("Integration destination requires HTTPS", request=request)
        host, port = url.host, url.port or 443
        try:
            addresses = await asyncio.wait_for(
                asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM), 5
            )
            resolved = [ipaddress.ip_address(address[4][0]) for address in addresses]
        except (OSError, TimeoutError, ValueError):
            raise httpx.ConnectError(
                "Integration destination cannot be resolved", request=request
            ) from None
        if not resolved or any(
            not address.is_global or address.is_multicast for address in resolved
        ):
            raise httpx.ConnectError(
                "Private integration destinations are not allowed", request=request
            )
        origin = (host, port)
        if origin not in self.transports:
            if len(self.transports) >= 8:
                raise httpx.ConnectError("Too many integration destinations", request=request)
            self.transports[origin] = httpx.AsyncHTTPTransport(trust_env=False)
        # Connect to the checked numeric IP (no second DNS lookup), retaining TLS hostname
        # verification and HTTP Host. Pools are distinct for each original origin.
        headers = request.headers.copy()
        headers["Host"] = url.netloc.decode("ascii")
        pinned = httpx.Request(
            request.method,
            url.copy_with(host=str(resolved[0])),
            headers=headers,
            stream=request.stream,
            extensions={**request.extensions, "sni_hostname": host},
        )
        return await self.transports[origin].handle_async_request(pinned)

    async def aclose(self) -> None:
        await asyncio.gather(*(transport.aclose() for transport in self.transports.values()))
