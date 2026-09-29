from __future__ import annotations

import html
import re

import pytest

from resolvate.topic_messages import topic_deliveries


@pytest.mark.parametrize("operator", [False, True])
@pytest.mark.parametrize("kind", ["send_text", "send_photo", "send_voice"])
def test_mirror_escapes_and_splits_without_losing_customer_content(
    operator: bool, kind: str
) -> None:
    content = "😀<script> & пример\n" * 350
    payload = {"kind": kind, "storage_path": "web-media/assets/test", "target_thread_id": 10}
    jobs = topic_deliveries(
        ticket_id="ticket",
        key="delivery",
        payload=payload,
        content=content,
        author="<b>Иван & Пётр</b>",
        operator=operator,
    )
    recovered = []
    for index, job in enumerate(jobs):
        formatted = job.payload["text"]
        assert isinstance(formatted, str)
        assert "<script>" not in formatted
        header, body = formatted.split("\n\n", 1)
        assert "&lt;b&gt;Иван &amp; Пётр&lt;/b&gt;" in header
        assert ("ПОДДЕРЖКА" if operator else "КЛИЕНТ") in header
        if operator:
            assert body.startswith("<blockquote>") and body.endswith("</blockquote>")
            body = body.removeprefix("<blockquote>").removesuffix("</blockquote>")
        recovered.append(html.unescape(body))
        plain = html.unescape(re.sub(r"</?(?:b|blockquote)>", "", formatted))
        limit = 1024 if index == 0 and kind != "send_text" else 4096
        assert len(plain.encode("utf-16-le")) // 2 <= limit
        if index:
            assert job.payload["kind"] == "send_text"
            assert "storage_path" not in job.payload
            assert job.created_at > jobs[index - 1].created_at
    assert "".join(recovered) == content
    assert len({job.idempotency_key for job in jobs}) == len(jobs)
    assert "text" not in payload  # The caller's customer payload is unchanged.


def test_attachment_without_caption_still_has_author() -> None:
    jobs = topic_deliveries(
        ticket_id="ticket",
        key="delivery",
        payload={"kind": "send_voice"},
        content=None,
        author=None,
    )
    assert len(jobs) == 1 and "КЛИЕНТ" in jobs[0].payload["text"]
