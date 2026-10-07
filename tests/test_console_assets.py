from __future__ import annotations

import gzip
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import FastAPI

from resolvate.config import Settings
from resolvate.console import IMMUTABLE, create_console

ORIGIN = "https://support.example.com"
SCRIPT = b"console.log('next');" * 20
# The Playwright stub serves the same headers; this test keeps the two in step.
STUB_HEADERS = Path(__file__).parents[1] / "frontend" / "e2e" / "headers.json"


@pytest.fixture
def build(tmp_path: Path) -> Path:
    assets = tmp_path / "assets"
    assets.mkdir()
    (tmp_path / "index.html").write_text("<!doctype html><title>next</title>", encoding="utf-8")
    (assets / "app-Ab1_2c.js").write_bytes(SCRIPT)
    (assets / "app-Ab1_2c.js.gz").write_bytes(gzip.compress(SCRIPT))
    (assets / "app-Ab1_2c.js.br").write_bytes(b"brotli bytes")
    (assets / "index-x9.css").write_bytes(b"body{}")
    (assets / "app-Ab1_2c.js.map").write_bytes(b"{}")
    return tmp_path


def console(build: Path) -> tuple[Any, MagicMock]:
    database = MagicMock()
    settings = Settings(_env_file=None, console_origin=ORIGIN)
    app = FastAPI()
    app.mount(
        "/console",
        create_console(database, MagicMock(), settings, MagicMock(), lambda _: "test", build),
    )
    return app, database


@pytest.fixture
async def client(build: Path) -> AsyncIterator[httpx.AsyncClient]:
    app, database = console(build)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN) as client:
        yield client
    database.session.assert_not_called()


async def raw(client: httpx.AsyncClient, path: str, encoding: str) -> httpx.Response:
    request = client.build_request("GET", path, headers={"Accept-Encoding": encoding})
    response = await client.send(request, stream=True)
    response._content = b"".join([chunk async for chunk in response.aiter_raw()])
    return response


@pytest.mark.parametrize(
    "path",
    [
        "next",
        "next/",
        "next/assets/app-Ab1_2c.js",
        "assets/app.js",
        "assets/theme.js",
        "assets/stickers.js",
        "assets/lottie_light_canvas.js",
    ],
)
async def test_old_frontend_and_preview_routes_are_removed(
    client: httpx.AsyncClient, path: str
) -> None:
    response = await client.get(f"/console/{path}")
    assert response.status_code == 404
    assert response.headers["cache-control"] == "no-store"


async def test_index_is_served_uncached_with_the_console_csp(client: httpx.AsyncClient) -> None:
    response = await client.get("/console/")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["cache-control"] == "no-store"
    assert "unsafe-inline" not in response.headers["content-security-policy"]


async def test_trailing_slash_redirect_keeps_the_deep_link(
    client: httpx.AsyncClient,
) -> None:
    response = await client.get("/console?project=p1&ticket=t1")
    assert response.status_code == 307
    assert response.headers["location"] == ORIGIN + "/console/?project=p1&ticket=t1"
    assert (await client.get("/console")).headers["location"] == ORIGIN + "/console/"


async def test_hashed_assets_are_immutable_and_precompressed(client: httpx.AsyncClient) -> None:
    plain = await raw(client, "/console/assets/app-Ab1_2c.js", "identity")
    assert plain.status_code == 200
    assert plain.content == SCRIPT
    assert plain.headers["content-type"] == "text/javascript; charset=utf-8"
    assert plain.headers["cache-control"] == IMMUTABLE
    assert plain.headers["vary"] == "Accept-Encoding"
    assert "content-encoding" not in plain.headers

    brotli = await raw(client, "/console/assets/app-Ab1_2c.js", "gzip, deflate, br")
    assert brotli.headers["content-encoding"] == "br"
    assert brotli.content == b"brotli bytes"

    gzipped = await raw(client, "/console/assets/app-Ab1_2c.js", "br;q=0, gzip")
    assert gzipped.headers["content-encoding"] == "gzip"
    assert gzip.decompress(gzipped.content) == SCRIPT

    css = await raw(client, "/console/assets/index-x9.css", "br, gzip")
    assert css.headers["content-type"] == "text/css; charset=utf-8"
    assert "content-encoding" not in css.headers


@pytest.mark.parametrize(
    "name",
    [
        "missing-1.js",
        ".hidden.js",
        "app-Ab1_2c.js.map",
        "app-Ab1_2c.js.br",
        "app-Ab1_2c.js.gz",
        "..%2Findex.html",
        "index.html",
    ],
)
async def test_only_built_scripts_and_styles_are_served(
    client: httpx.AsyncClient, name: str
) -> None:
    response = await client.get(f"/console/assets/{name}")
    assert response.status_code == 404
    assert response.headers["cache-control"] == "no-store"


async def test_missing_build_returns_503_but_does_not_disable_api(tmp_path: Path) -> None:
    app, _ = console(tmp_path)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN) as client:
        assert (await client.get("/console/")).status_code == 503
        assert (await client.get("/console/me")).status_code == 401
        assert (await client.get("/console/assets/app-Ab1_2c.js")).status_code == 404


async def test_everything_else_stays_no_store(client: httpx.AsyncClient) -> None:
    assert (await client.get("/console/assets/theme.js")).headers["cache-control"] == "no-store"
    assert (await client.get("/console/me")).headers["cache-control"] == "no-store"


async def test_e2e_stub_serves_the_same_headers_as_the_console(
    client: httpx.AsyncClient,
) -> None:
    expected = json.loads(STUB_HEADERS.read_text(encoding="utf-8"))
    answers = {
        "document": await client.get("/console/"),
        "asset": await client.get("/console/assets/index-x9.css"),
        "api": await client.get("/console/me"),
    }
    assert answers["api"].status_code == 401
    for kind, response in answers.items():
        assert {key: response.headers.get(key) for key in expected[kind]} == expected[kind], kind
