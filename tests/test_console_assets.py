from __future__ import annotations

import re
from collections import Counter
from html.parser import HTMLParser
from importlib.resources import files

import pytest

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
    for name in ("app.js", "image_viewer.js"):
        source = ASSETS.joinpath(name).read_text(encoding="utf-8")
        # Literal references in both controllers must match the actual template.
        targets = re.findall(r'(?<![\w$.])(?:\$|get)\("([^"\n]+)"\)', source)
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
        if tag == "script":
            assert "defer" in attrs


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
