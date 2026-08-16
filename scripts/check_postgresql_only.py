from __future__ import annotations

import subprocess
from pathlib import Path

FORBIDDEN_FRAGMENT = "sq" + "lite"


def repository_files(root: Path) -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=root,
        check=True,
        capture_output=True,
    )
    return [
        root / raw_path.decode()
        for raw_path in result.stdout.split(b"\0")
        if raw_path and (root / raw_path.decode()).is_file()
    ]


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    findings: list[str] = []
    for path in repository_files(root):
        relative_path = path.relative_to(root)
        if FORBIDDEN_FRAGMENT in str(relative_path).casefold():
            findings.append(str(relative_path))
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for line_number, line in enumerate(content.splitlines(), start=1):
            if FORBIDDEN_FRAGMENT in line.casefold():
                findings.append(f"{relative_path}:{line_number}")

    if findings:
        rendered = "\n".join(findings)
        raise SystemExit(
            "PostgreSQL-only policy failed: unsupported embedded-database reference found:\n"
            f"{rendered}"
        )
    print("PostgreSQL-only policy check passed")


if __name__ == "__main__":
    main()
