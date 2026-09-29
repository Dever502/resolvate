"""Create the first console administrator without passwords in argv or shell history."""

from __future__ import annotations

import argparse
import asyncio
import getpass

from fastapi import HTTPException
from sqlalchemy import delete, select, text

from resolvate.config import get_settings
from resolvate.console_auth import ACCOUNT_LOCK, ConsoleAuth, password_hash
from resolvate.database import Database
from resolvate.models import AccessAudit, ConsoleAccount, ConsoleSession


async def recover(database: Database, login: str, password: str) -> None:
    encoded = await asyncio.to_thread(password_hash, password)
    async with database.session() as session:
        await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": ACCOUNT_LOCK})
        target = await session.scalar(
            select(ConsoleAccount).where(ConsoleAccount.login == login.strip().casefold())
        )
        if target is None:
            raise HTTPException(404, "Укажите логин существующей учётной записи.")
        owners = (
            await session.scalars(select(ConsoleAccount).where(ConsoleAccount.role == "admin"))
        ).all()
        for owner in owners:
            owner.role = "operator"
        await session.flush()
        target.role, target.active, target.password_hash = "admin", True, encoded
        await session.execute(
            delete(ConsoleSession).where(
                ConsoleSession.account_id.in_([target.id, *(row.id for row in owners)])
            )
        )
        session.add(AccessAudit(action="owner_recovered_cli", target_id=target.id))
        await session.commit()


async def create(login: str, name: str, password: str, *, recovery: bool = False) -> None:
    settings = get_settings()
    database = Database(settings.database_url)
    try:
        if recovery:
            await recover(database, login, password)
            return
        await ConsoleAuth(database, "").create_account(
            login=login,
            name=name,
            password=password,
            role="admin",
            bootstrap=True,
        )
    finally:
        await database.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description="Create the first Web console administrator.")
    parser.add_argument("login")
    parser.add_argument("--name", default="Администратор")
    parser.add_argument(
        "--recover",
        action="store_true",
        help="Recover installation ownership for an existing account",
    )
    args = parser.parse_args()
    password = getpass.getpass("Пароль (12–128 символов): ")
    if password != getpass.getpass("Повторите пароль: "):
        parser.exit(1, "Пароли не совпадают.\n")
    try:
        asyncio.run(create(args.login, args.name, password, recovery=args.recover))
    except HTTPException as error:
        parser.exit(1, f"{error.detail}\n")
    except ValueError as error:
        parser.exit(1, f"{error}\n")
    print("Доступ восстановлен." if args.recover else "Администратор создан.")


if __name__ == "__main__":
    main()
