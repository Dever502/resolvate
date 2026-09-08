"""Create the first console administrator without passwords in argv or shell history."""

from __future__ import annotations

import argparse
import asyncio
import getpass

from fastapi import HTTPException

from resolvate.config import get_settings
from resolvate.console_auth import ConsoleAuth
from resolvate.database import Database


async def create(login: str, name: str, password: str) -> None:
    settings = get_settings()
    database = Database(settings.database_url)
    try:
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
    args = parser.parse_args()
    password = getpass.getpass("Пароль (12–128 символов): ")
    if password != getpass.getpass("Повторите пароль: "):
        parser.exit(1, "Пароли не совпадают.\n")
    try:
        asyncio.run(create(args.login, args.name, password))
    except HTTPException as error:
        parser.exit(1, f"{error.detail}\n")
    print("Администратор создан.")


if __name__ == "__main__":
    main()
