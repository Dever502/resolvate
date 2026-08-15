from __future__ import annotations

from collections.abc import Mapping
from importlib import metadata
from typing import cast

from scripts.check_licenses import audit_distributions


class FakeDistribution:
    def __init__(self, name: str, license_expression: str) -> None:
        self.metadata: Mapping[str, str] = {
            "Name": name,
            "License-Expression": license_expression,
        }


def as_distribution(distribution: FakeDistribution) -> metadata.Distribution:
    return cast(metadata.Distribution, distribution)


def test_dependency_license_policy_excludes_the_project_itself() -> None:
    violations, unknown = audit_distributions(
        [as_distribution(FakeDistribution("Resolvate", "AGPL-3.0-only"))]
    )

    assert violations == []
    assert unknown == []


def test_dependency_license_policy_still_rejects_agpl_dependencies() -> None:
    violations, unknown = audit_distributions(
        [as_distribution(FakeDistribution("copyleft-dependency", "AGPL-3.0-only"))]
    )

    assert violations == ["copyleft-dependency: AGPL-3.0-only"]
    assert unknown == []
