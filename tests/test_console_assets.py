from __future__ import annotations

import re
from collections import Counter
from html.parser import HTMLParser
from importlib.resources import files
from unittest.mock import MagicMock

import httpx
import pytest

from resolvate.config import Settings
from resolvate.console import create_console

ASSETS = files("resolvate").joinpath("console_assets")
VOID_TAGS = {
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "source",
    "wbr",
}


class ConsoleTemplate(HTMLParser):
    """Check the source structure before the browser silently repairs invalid HTML."""

    def __init__(self) -> None:
        super().__init__()
        self.elements: list[tuple[str, dict[str, str | None], tuple[str, ...]]] = []
        self.stack: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        assert len(attrs) == len(dict(attrs)), f"Duplicate attributes on {tag}"
        assert tag != "form" or "form" not in self.stack, "Nested forms lose their controls"
        self.elements.append((tag, dict(attrs), tuple(self.stack)))
        if tag not in VOID_TAGS:
            self.stack.append(tag)

    def handle_endtag(self, tag: str) -> None:
        assert self.stack and self.stack[-1] == tag, f"Unexpected closing {tag}: {self.stack}"
        self.stack.pop()

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_data(self, data: str) -> None:
        if "script" in self.stack or "style" in self.stack:
            assert not data.strip(), "Console assets must stay compatible with the strict CSP"


@pytest.fixture(scope="module")
def template() -> ConsoleTemplate:
    parsed = ConsoleTemplate()
    parsed.feed(ASSETS.joinpath("index.html").read_text(encoding="utf-8"))
    parsed.close()
    assert not parsed.stack
    return parsed


def test_console_controls_and_accessibility_references_resolve(template: ConsoleTemplate) -> None:
    counts = Counter(attrs["id"] for _, attrs, _ in template.elements if "id" in attrs)
    assert all(count == 1 for count in counts.values()), "DOM IDs must be unique"
    for _, attrs, _ in template.elements:
        for key in ("for", "aria-labelledby", "aria-describedby", "aria-controls"):
            for target in (attrs.get(key) or "").split():
                assert target in counts, f"Unresolved {key}={target}"
    for name in ("app.js", "image_viewer.js", "theme.js"):
        source = ASSETS.joinpath(name).read_text(encoding="utf-8")
        # Literal DOM references in the controllers must match the actual template.
        targets = re.findall(
            r'(?:(?<![\w$.])(?:\$|get)|document\.getElementById)\("([^"\n]+)"\)', source
        )
        if name != "theme.js":
            assert targets
        assert set(targets) <= counts.keys(), set(targets) - counts.keys()


def test_console_dialogs_and_visible_inputs_have_accessible_names(
    template: ConsoleTemplate,
) -> None:
    labelled = {attrs.get("for") for tag, attrs, _ in template.elements if tag == "label"}
    for tag, attrs, ancestors in template.elements:
        if tag == "dialog":
            assert attrs.get("aria-label") or attrs.get("aria-labelledby")
        if tag not in {"input", "select", "textarea"} or "hidden" in attrs:
            continue
        assert (
            "label" in ancestors
            or attrs.get("aria-label")
            or attrs.get("aria-labelledby")
            or attrs.get("id") in labelled - {None}
        ), f"Unlabelled {tag}: {attrs}"


def test_console_loads_only_packaged_scripts_and_styles(template: ConsoleTemplate) -> None:
    for tag, attrs, _ in template.elements:
        assert not any(name.startswith("on") or name == "style" for name in attrs)
        if tag not in {"script", "link"}:
            continue
        source = attrs.get("src" if tag == "script" else "href") or ""
        assert re.fullmatch(r"assets/[a-z_]+\.(?:js|css)", source)
        assert ASSETS.joinpath(source.removeprefix("assets/")).is_file()
        if tag == "script" and source != "assets/theme.js":
            assert "defer" in attrs


def test_theme_bootstraps_before_styles_without_inline_script() -> None:
    source = ASSETS.joinpath("index.html").read_text(encoding="utf-8")
    assert source.index('src="assets/theme.js"') < source.index('href="assets/app.css"')
    assert 'data-theme="dark"' in ASSETS.joinpath("app.css").read_text(encoding="utf-8")


def test_theme_switches_use_buttons_without_a_menu(template: ConsoleTemplate) -> None:
    buttons = [
        attrs
        for tag, attrs, _ in template.elements
        if "data-theme-toggle" in attrs and tag == "button"
    ]
    assert len(buttons) == 1  # Only the authenticated workspace.
    assert all(attrs.get("aria-label") and "aria-haspopup" not in attrs for attrs in buttons)
    assert all(attrs.get("id") != "theme-dialog" for _, attrs, _ in template.elements)
    source = ASSETS.joinpath("index.html").read_text(encoding="utf-8")
    login = source.split('id="login-screen"', 1)[1].split("</main>", 1)[0]
    assert "data-theme-toggle" not in login


async def test_theme_script_is_publicly_served_with_strict_csp() -> None:
    database = MagicMock()
    settings = Settings(_env_file=None, console_origin="https://support.example.com")
    app = create_console(database, MagicMock(), settings, MagicMock(), lambda _: "test")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://support.example.com"
    ) as client:
        response = await client.get("/assets/theme.js")
        assert response.status_code == 200
        assert response.text == ASSETS.joinpath("theme.js").read_text(encoding="utf-8")
        assert "javascript" in response.headers["content-type"]
        assert "script-src 'self'" in response.headers["content-security-policy"]
        assert "unsafe-inline" not in response.headers["content-security-policy"]
        assert (await client.get("/assets/not_public.js")).status_code == 404
    database.session.assert_not_called()


def test_console_appbar_reading_order_matches_project_first_layout() -> None:
    source = ASSETS.joinpath("index.html").read_text(encoding="utf-8")
    appbar = source.split('<header class="appbar"', 1)[1].split("</header>", 1)[0]
    assert appbar.index('class="project-picker"') < appbar.index('class="brand"')
    assert appbar.index('class="brand"') < appbar.index('id="projects-open"')


def test_console_rating_card_does_not_link_back_to_current_ticket() -> None:
    source = ASSETS.joinpath("app.js").read_text(encoding="utf-8")
    rating = source.split("if (item.rating) {", 1)[1].split("} else if", 1)[0]
    assert '"Оценка поддержки"' in rating
    assert "data.score" in rating
    assert "data.display_name" in rating
    assert 'node("a"' not in rating
    assert "openTicket(" not in rating


def test_folder_filters_are_tabs_and_ticket_assignment_is_separate(
    template: ConsoleTemplate,
) -> None:
    controls = {attrs.get("id"): (tag, attrs) for tag, attrs, _ in template.elements}
    assert controls["folder-tabs"][1]["role"] == "tablist"
    assert controls["folder-tabs"][1]["aria-orientation"] == "horizontal"
    assert controls["ticket-list"][1]["role"] == "tabpanel"
    assert controls["ticket-folder"][0] == "select"
    assert "folder-filter" not in controls


def test_folder_tabs_are_above_ticket_list_inside_sidebar() -> None:
    source = ASSETS.joinpath("index.html").read_text(encoding="utf-8")
    sidebar = source.split('<aside id="ticket-sidebar"', 1)[1].split("</aside>", 1)[0]
    assert sidebar.index('id="folder-tabs"') < sidebar.index('id="ticket-list"')
    column = source.split('<div class="conversation-column">', 1)[1]
    assert 'id="folder-tabs"' not in column


def test_unfiled_is_only_an_assignment_option_not_a_folder_tab() -> None:
    script = ASSETS.joinpath("app.js").read_text(encoding="utf-8")
    tabs = script.split("function renderFolderTabs()", 1)[1].split(
        '$("folder-tabs").addEventListener', 1
    )[0]
    assert '[["", "Все"], ...state.folders.map' in tabs
    assert "Без папки" not in tabs and "unfiled" not in tabs
    assert '[["", "Без папки"], ...state.folders.map' in script
    assert 'folderFilter === "unfiled"' not in script


def test_archive_action_is_in_heading_without_bottom_status_tabs(template: ConsoleTemplate) -> None:
    source = ASSETS.joinpath("index.html").read_text(encoding="utf-8")
    assert 'id="active-tab"' not in source
    assert 'id="archive-tab"' not in source
    assert source.index('id="archive-toggle"') < source.index('id="folder-tabs"')
    for _, attrs, ancestors in template.elements:
        if attrs.get("id") == "archive-toggle":
            assert ancestors[-2:] == ("aside", "header")
            assert attrs["aria-label"] == "Открыть архив"
            assert attrs["aria-controls"] == "ticket-list"


def test_sidebar_resize_control_is_accessible(template: ConsoleTemplate) -> None:
    controls = {attrs.get("id"): attrs for _, attrs, _ in template.elements}
    handle = controls["sidebar-resizer"]
    assert handle["role"] == "separator"
    assert handle["aria-orientation"] == "vertical"
    assert handle["aria-controls"] == "ticket-sidebar"
    assert handle["tabindex"] == "0"
    assert all(key in handle for key in ("aria-valuemin", "aria-valuemax", "aria-valuenow"))
