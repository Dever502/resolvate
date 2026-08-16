.PHONY: install lock run migrate migration-check postgresql-only-check license-check publication-check format-check test test-postgres lint typecheck verify production-preflight

install:
	uv sync --frozen --all-groups

lock:
	uv lock

run:
	uv run --frozen resolvate

migrate:
	uv run --frozen alembic upgrade head

migration-check:
	uv run --frozen python scripts/check_migrations.py

postgresql-only-check:
	uv run --frozen python scripts/check_postgresql_only.py

license-check:
	uv run --frozen python scripts/check_licenses.py

publication-check:
	uv run --frozen python scripts/check_publication.py

format-check:
	uv run --frozen ruff format --check .

test:
	sh scripts/test_unit.sh

test-postgres:
	sh scripts/test_postgres.sh

lint:
	uv run --frozen ruff check .

typecheck:
	uv run --frozen mypy src

verify:
	sh scripts/verify.sh

production-preflight:
	sh scripts/deploy.sh preflight
