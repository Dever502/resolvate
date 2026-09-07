from pathlib import Path

import pytest
from pydantic import ValidationError

from resolvate.config import Settings


def configured(**overrides: object) -> Settings:
    return Settings(
        _env_file=None,
        support_bot_token="test-token",
        support_group_id=-100123,
        **overrides,
    )


@pytest.mark.parametrize(
    ("ai", "messages", "topics", "reserve", "trigger", "target"),
    [(False, 2500, 250, 25, 225, 200), (True, 2000, 200, 20, 180, 160)],
)
def test_mode_defaults(
    ai: bool, messages: int, topics: int, reserve: int, trigger: int, target: int
) -> None:
    settings = configured(ai_enabled=ai)
    assert settings.rotation_message_limit == messages
    assert settings.rotation_topic_limit == topics
    assert settings.rotation_topic_reserve == reserve
    assert settings.rotation_cleanup_trigger == trigger
    assert settings.rotation_cleanup_target == target
    assert settings.topic_rotation_delay_seconds == 300


@pytest.mark.parametrize("ai", [False, True])
def test_explicit_limits_are_not_scaled(ai: bool) -> None:
    settings = configured(
        ai_enabled=ai,
        topic_rotation_message_limit=17,
        topic_rotation_topic_limit=11,
        topic_rotation_topic_reserve=3,
    )
    assert settings.rotation_message_limit == 17
    assert settings.rotation_cleanup_trigger == 8
    assert settings.rotation_cleanup_target == 5


def test_retention_and_budget_defaults() -> None:
    settings = configured()
    assert not settings.ai_enabled
    assert settings.archive_retention_days == 60
    assert settings.archive_media_compress_after_days == 14
    assert settings.archive_media_retention_days == 30
    assert settings.summary_inactivity_retention_days == 180
    assert settings.media_budget_bytes == 20 * 1024**3
    assert settings.archive_budget_bytes == 2 * 1024**3
    assert settings.storage_reserve_bytes == 3 * 1024**3


@pytest.mark.parametrize(
    "overrides",
    [
        {"topic_rotation_message_limit": 0},
        {"topic_rotation_topic_limit": 40, "topic_rotation_topic_reserve": 20},
        {"topic_rotation_topic_reserve": 0},
        {"topic_rotation_delay_seconds": -1},
        {"archive_media_compress_after_days": 30},
        {"archive_media_retention_days": 61},
        {"archive_retention_days": 0},
        {"summary_inactivity_retention_days": 0},
        {"media_budget_bytes": 0},
        {"archive_budget_bytes": 0},
        {"storage_reserve_bytes": 0},
    ],
)
def test_invalid_rotation_settings_are_rejected(overrides: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        configured(**overrides)


def test_notifications_do_not_require_a_separate_recipient() -> None:
    assert "rotation_admin_telegram_id" not in Settings.model_fields
    assert configured(admin_telegram_ids=set()).support_group_id


def test_environment_is_read_only_when_settings_are_constructed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("AI_ENABLED", "false")
    monkeypatch.setenv("TOPIC_ROTATION_DELAY_SECONDS", "71")
    settings = configured()
    monkeypatch.setenv("AI_ENABLED", "true")
    assert settings.ai_enabled is False
    assert settings.rotation_message_limit == 2500
    assert settings.topic_rotation_delay_seconds == 71
    assert configured().rotation_message_limit == 2000
