from __future__ import annotations

import importlib.util
import runpy
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "select_pytest_shard",
    ROOT / "scripts" / "select_pytest_shard.py",
)
assert SPEC is not None and SPEC.loader is not None
SHARDING = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SHARDING
SPEC.loader.exec_module(SHARDING)

ShardFile = SHARDING.ShardFile
build_shards = SHARDING.build_shards
discover_test_files = SHARDING.discover_test_files
collect_timings = runpy.run_path(str(ROOT / "scripts/pytest_timings.py"))["collect_timings"]


def test_junit_timings_require_complete_successful_nonduplicate_run(tmp_path: Path) -> None:
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "test_one.py").write_text("def test_one(): pass\n")
    (tests / "test_two.py").write_text("def test_two(): pass\n")
    first, second = tmp_path / "first.xml", tmp_path / "second.xml"
    first.write_text(
        '<testsuite><testcase classname="tests.test_one" name="test_one" time="2"/></testsuite>'
    )
    second.write_text(
        '<testsuite><testcase classname="tests.test_two.TestClass" '
        'name="test_two" time="3"/></testsuite>'
    )
    assert collect_timings([first, second], tmp_path) == {
        "tests/test_one.py": 2.0,
        "tests/test_two.py": 3.0,
    }
    with pytest.raises(ValueError, match="every"):
        collect_timings([first], tmp_path)
    with pytest.raises(ValueError, match="duplicate"):
        collect_timings([first, second, first], tmp_path)
    second.write_text(
        '<testsuite><testcase classname="tests.test_two" name="test_two" time="3">'
        "<failure/></testcase></testsuite>"
    )
    with pytest.raises(ValueError, match="successful"):
        collect_timings([first, second], tmp_path)


@pytest.mark.parametrize("count", [2, 4])
def test_discovered_test_files_are_partitioned_exactly_once(count: int) -> None:
    files = discover_test_files()
    shards = build_shards(files, count)
    discovered = {test_file.path for test_file in files}

    assert all(shards)
    assert len([path for shard in shards for path in shard]) == len(discovered)
    assert set().union(*map(set, shards)) == discovered


def test_measured_durations_balance_expensive_small_files() -> None:
    files = [ShardFile(Path(f"tests/test_{name}.py"), 1, 100) for name in "abcd"]
    timings = {
        f"tests/test_{name}.py": duration
        for name, duration in zip("abcd", [9, 8, 2, 1], strict=True)
    }
    shards = build_shards(files, 2, timings)
    assert shards == build_shards(list(reversed(files)), 2, timings)
    assert [sum(timings[path.as_posix()] for path in shard) for shard in shards] == [10, 10]
    # Unmeasured files still participate, obsolete profile entries never select files.
    timings.pop("tests/test_d.py")
    timings["tests/test_removed.py"] = 100
    selected = [path for shard in build_shards(files, 4, timings) for path in shard]
    assert sorted(selected) == sorted(item.path for item in files)


@pytest.mark.parametrize(
    "data",
    [
        "[]",
        '{"../secret": 1}',
        '{"tests/test_a.py": -1}',
        '{"tests/test_a.py": NaN}',
        '{"tests/test_a.py": true}',
    ],
)
def test_invalid_timing_profile_fails_closed(tmp_path: Path, data: str) -> None:
    path = tmp_path / "timings.json"
    path.write_text(data)
    with pytest.raises(ValueError):
        SHARDING.load_timings(path)


def test_discovery_excludes_module_level_postgres_marker(tmp_path: Path) -> None:
    tests_dir = tmp_path / "tests"
    tests_dir.mkdir()
    (tests_dir / "test_unit.py").write_text(
        "def test_unit():\n    pass\n",
        encoding="utf-8",
    )
    (tests_dir / "test_postgres.py").write_text(
        "import pytest\n\n"
        "pytestmark = pytest.mark.postgres\n\n"
        "def test_postgres_only():\n    pass\n",
        encoding="utf-8",
    )

    files = discover_test_files(tmp_path)

    assert [(test_file.path.as_posix(), test_file.test_count) for test_file in files] == [
        ("tests/test_unit.py", 1)
    ]


def test_discovery_estimates_literal_and_stacked_parametrize_cases(
    tmp_path: Path,
) -> None:
    tests_dir = tmp_path / "tests"
    tests_dir.mkdir()
    test_file = tests_dir / "test_parametrized.py"
    test_file.write_text(
        "import pytest\n\n"
        "values = [1, 2, 3, 4]\n\n"
        "@pytest.mark.parametrize('value', [1, 2, pytest.param(3)])\n"
        "def test_literal(value):\n    pass\n\n"
        "@pytest.mark.parametrize('left', (1, 2))\n"
        "@pytest.mark.parametrize(argnames='right', argvalues=['a', 'b', 'c'])\n"
        "async def test_stacked(left, right):\n    pass\n\n"
        "@pytest.mark.parametrize('value', values)\n"
        "def test_dynamic_falls_back_to_one(value):\n    pass\n",
        encoding="utf-8",
    )

    files = discover_test_files(tmp_path)

    assert len(files) == 1
    assert files[0].path == Path("tests/test_parametrized.py")
    assert files[0].test_count == 10


def test_shard_assignment_is_deterministic_and_balanced() -> None:
    files = [
        ShardFile(Path("tests/test_large.py"), test_count=10, size=1_000),
        ShardFile(Path("tests/test_medium.py"), test_count=6, size=1_000),
        ShardFile(Path("tests/test_small_a.py"), test_count=2, size=1_000),
        ShardFile(Path("tests/test_small_b.py"), test_count=2, size=1_000),
    ]

    first = build_shards(files, 2)
    second = build_shards(list(reversed(files)), 2)

    assert first == second
    assert [sum(item.weight for item in files if item.path in shard) for shard in first] == [
        101_000,
        103_000,
    ]


@pytest.mark.parametrize("count", [0, 3])
def test_invalid_shard_count_is_rejected(count: int) -> None:
    files = [ShardFile(Path("tests/test_one.py"), test_count=1, size=1)]

    with pytest.raises(ValueError):
        build_shards(files, count)
