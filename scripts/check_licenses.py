from __future__ import annotations

import re
from collections.abc import Iterable
from importlib import metadata

FORBIDDEN_LICENSE = re.compile(r"(?<!L)(?:AGPL|GPL|SSPL)(?:[- v]?[123][^A-Za-z]*)?", re.IGNORECASE)
PROJECT_DISTRIBUTION_NAME = "resolvate"


def distribution_license(distribution: metadata.Distribution) -> str:
    expression = distribution.metadata.get("License-Expression")
    if expression:
        return expression
    license_value = distribution.metadata.get("License")
    if license_value and license_value.casefold() != "unknown":
        return license_value
    classifiers = distribution.metadata.get_all("Classifier", [])
    licenses = [
        item.removeprefix("License :: ") for item in classifiers if item.startswith("License :: ")
    ]
    return "; ".join(licenses) if licenses else "UNKNOWN"


def normalize_distribution_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).casefold()


def audit_distributions(
    distributions: Iterable[metadata.Distribution],
) -> tuple[list[str], list[str]]:
    violations: list[str] = []
    unknown: list[str] = []
    project_name = normalize_distribution_name(PROJECT_DISTRIBUTION_NAME)
    for distribution in sorted(
        distributions, key=lambda item: (item.metadata.get("Name") or "").casefold()
    ):
        name = distribution.metadata.get("Name") or "unnamed-distribution"
        if normalize_distribution_name(name) == project_name:
            continue
        license_value = distribution_license(distribution)
        if license_value == "UNKNOWN":
            unknown.append(name)
        elif FORBIDDEN_LICENSE.search(license_value):
            violations.append(f"{name}: {license_value}")
    return violations, unknown


def main() -> None:
    violations, unknown = audit_distributions(metadata.distributions())
    if unknown:
        print("Packages without machine-readable license metadata: " + ", ".join(unknown))
    if violations:
        raise SystemExit("Forbidden dependency licenses:\n" + "\n".join(violations))
    print("Dependency license policy passed")


if __name__ == "__main__":
    main()
