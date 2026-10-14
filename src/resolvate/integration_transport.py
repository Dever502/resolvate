"""Project-configurable HTTP destinations must not reach the installation's private network."""

from __future__ import annotations

import asyncio
import ipaddress
import socket

import httpx

NAT64_NETWORK = ipaddress.IPv6Network("64:ff9b::/96")
LOCAL_NAT64_NETWORK = ipaddress.IPv6Network("64:ff9b:1::/48")


def is_public_integration_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if not address.is_global or address.is_multicast:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        if address.is_site_local or address.scope_id or address in LOCAL_NAT64_NETWORK:
            return False
        # Reject transition tunnels; their embedded destination need not be public.
        if address.sixtofour is not None or address.teredo is not None:
            return False
        if address.ipv4_mapped is not None:
            return is_public_integration_address(address.ipv4_mapped)
        if address in NAT64_NETWORK:
            return is_public_integration_address(ipaddress.IPv4Address(int(address) & 0xFFFFFFFF))
    return True


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
        if not resolved or any(not is_public_integration_address(address) for address in resolved):
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
