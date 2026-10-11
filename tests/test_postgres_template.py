from contextlib import aclosing

import pytest
from postgres_support import disposable_postgres_database
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine


async def test_template_clones_do_not_share_data(migrated_postgres_template: str) -> None:
    async with aclosing(
        disposable_postgres_database(template_url=migrated_postgres_template)
    ) as first:
        first_url = await anext(first)
        engine = create_async_engine(first_url)
        try:
            async with engine.begin() as connection:
                await connection.execute(text("CREATE TABLE clone_only (value integer)"))
                await connection.execute(text("INSERT INTO clone_only VALUES (42)"))
        finally:
            await engine.dispose()
        async with aclosing(
            disposable_postgres_database(template_url=migrated_postgres_template)
        ) as second:
            second_url = await anext(second)
            assert first_url != second_url
            engine = create_async_engine(second_url)
            try:
                async with engine.connect() as connection:
                    assert await connection.scalar(text("SELECT to_regclass('clone_only')")) is None
                    assert await connection.scalar(text("SELECT version_num FROM alembic_version"))
                    assert (
                        await connection.scalar(text("SELECT count(*) FROM console_accounts")) == 0
                    )
            finally:
                await engine.dispose()


@pytest.mark.parametrize(
    "template",
    [
        "postgresql+asyncpg://resolvate_test@localhost/production",
        "postgresql+asyncpg://resolvate_test@other-server/sbtest_example",
        'postgresql+asyncpg://resolvate_test@localhost/sbtest_bad"name',
    ],
)
async def test_template_rejects_foreign_or_unsafe_database(template: str) -> None:
    async with aclosing(disposable_postgres_database(template_url=template)) as databases:
        with pytest.raises(ValueError):
            await anext(databases)
