from __future__ import annotations

import ast
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from resolvate.action_permissions import (
    CONSOLE_ACTIONS,
    OPERATOR_API_ACTIONS,
    TELEGRAM_ACTIONS,
    Action,
    ActionActor,
    allows_action,
)
from resolvate.authorization import AuthorizationService
from resolvate.config import Settings
from resolvate.telegram_constants import TOPIC_COMMANDS


@pytest.mark.parametrize("action", list(Action))
def test_current_action_matrix(action: Action) -> None:
    operator = ActionActor("project-a", "operator", True)
    admin = ActionActor("project-a", "admin", True, True)
    owner_without_membership = ActionActor("project-a", "owner", False, True)
    assert allows_action(operator, action, project_id="project-a") == (
        action != Action.RESOLVE_PANEL
    )
    assert allows_action(admin, action, project_id="project-a")
    assert not allows_action(owner_without_membership, action, project_id="project-a")
    assert not allows_action(admin, action, project_id="project-b")
    assert not allows_action(operator, None, project_id="project-a")


def test_transport_actions_are_explicit_and_share_business_permissions() -> None:
    assert set(TELEGRAM_ACTIONS) == TOPIC_COMMANDS
    assert TELEGRAM_ACTIONS["/stop"] == TELEGRAM_ACTIONS["/hidestop"]
    assert TELEGRAM_ACTIONS["/stop"] == OPERATOR_API_ACTIONS["close_ticket"]
    assert CONSOLE_ACTIONS["send"] == OPERATOR_API_ACTIONS["send_message"]
    # Keep newly added console endpoints from silently bypassing the policy.
    root = Path(__file__).resolve().parents[1] / "src" / "resolvate"
    console = ast.parse((root / "console.py").read_text())
    actor_endpoints = {
        node.name
        for node in ast.walk(console)
        if isinstance(node, ast.AsyncFunctionDef)
        and any(
            isinstance(arg.annotation, ast.Name) and arg.annotation.id == "Actor"
            for arg in node.args.args
        )
    }
    assert actor_endpoints == set(CONSOLE_ACTIONS) | {"lifecycle"}
    api = ast.parse((root / "api_routes.py").read_text())
    operator_endpoints = {
        node.name
        for node in ast.walk(api)
        if isinstance(node, ast.AsyncFunctionDef)
        and any(
            isinstance(dec, ast.Call)
            and dec.args
            and isinstance(dec.args[0], ast.Constant)
            and str(dec.args[0].value).startswith("/api/v1/tickets")
            for dec in node.decorator_list
        )
    }
    assert operator_endpoints == set(OPERATOR_API_ACTIONS)


@pytest.mark.parametrize(
    "member,admin", [(False, False), (False, True), (True, False), (True, True)]
)
async def test_telegram_resolve_requires_both_membership_and_administration(
    member: bool, admin: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = AuthorizationService(Settings())
    monkeypatch.setattr(service, "can_operate", AsyncMock(return_value=member))
    check_admin = AsyncMock(return_value=admin)
    monkeypatch.setattr(service, "can_administer", check_admin)
    assert await service.can_execute(42, Action.RESOLVE_PANEL) == (member and admin)
    assert check_admin.await_count == int(member)
    assert await service.can_execute(42, Action.GIFT) == member


async def test_legacy_telegram_allowlist_is_preserved() -> None:
    service = AuthorizationService(Settings(admin_telegram_ids={42}))
    assert await service.can_execute(42, Action.GIFT)
    assert await service.can_execute(42, Action.RESOLVE_PANEL)
    assert not await service.can_execute(43, Action.GIFT)
