from __future__ import annotations

import asyncio
import hashlib
import re
import secrets
from datetime import timedelta

from fastapi import HTTPException, Request
from sqlalchemy import delete, select, text
from sqlalchemy.exc import IntegrityError

from resolvate.api_security import InMemoryRateLimiter
from resolvate.database import Database
from resolvate.models import ConsoleAccount, ConsoleSession, utcnow

COOKIE = "resolvate_session"
SESSION_SECONDS = 12 * 60 * 60
ACCOUNT_LOCK = 684214018


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def password_hash(password: str, salt: str | None = None) -> str:
    if not 12 <= len(password) <= 128:
        raise ValueError("Пароль должен содержать от 12 до 128 символов.")
    salt = salt or secrets.token_hex(16)
    hashed = hashlib.scrypt(
        password.encode(),
        salt=bytes.fromhex(salt),
        n=2**17,
        r=8,
        p=1,
        maxmem=160 * 1024 * 1024,
        dklen=32,
    )
    return f"scrypt-v1${salt}${hashed.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        kind, salt, _ = encoded.split("$")
        return kind == "scrypt-v1" and secrets.compare_digest(
            password_hash(password, salt), encoded
        )
    except (ValueError, TypeError):
        return False


def account_view(account: ConsoleAccount) -> dict[str, object]:
    return {
        "id": account.id,
        "login": account.login,
        "name": account.display_name,
        "role": account.role,
        "active": account.active,
    }


class ConsoleAuth:
    def __init__(self, database: Database, origin: str) -> None:
        self.database = database
        self.origin = origin
        self.secure = origin.startswith("https://")
        self.login_limiter = InMemoryRateLimiter(limit=10, window_seconds=300)
        self.global_limiter = InMemoryRateLimiter(limit=60, window_seconds=60)
        self.request_limiter = InMemoryRateLimiter(limit=300, window_seconds=60)
        self.hash_slots = asyncio.Semaphore(2)

    def same_origin(self, request: Request) -> None:
        if request.headers.get("origin") != self.origin:
            raise HTTPException(403, "Запрос должен поступать из панели.")

    async def require(self, request: Request) -> ConsoleAccount:
        token = request.cookies.get(COOKIE, "")
        if not 32 <= len(token) <= 128:
            raise HTTPException(401, "Войдите в панель.")
        async with self.database.session() as session:
            account = await session.scalar(
                select(ConsoleAccount)
                .join(ConsoleSession)
                .where(
                    ConsoleSession.token_hash == digest(token),
                    ConsoleSession.expires_at > utcnow(),
                    ConsoleAccount.active.is_(True),
                )
            )
        if account is None:
            raise HTTPException(401, "Сессия завершена. Войдите снова.")
        allowed, retry = await self.request_limiter.consume(account.id)
        if not allowed:
            raise HTTPException(429, "Слишком много запросов.", headers={"Retry-After": str(retry)})
        if request.method not in {"GET", "HEAD"}:
            self.same_origin(request)
            if not secrets.compare_digest(
                request.headers.get("x-csrf-token", ""), digest("csrf:" + token)
            ):
                raise HTTPException(403, "Обновите страницу и повторите действие.")
        return account

    async def admin(self, request: Request) -> ConsoleAccount:
        account = await self.require(request)
        if account.role != "admin":
            raise HTTPException(403, "Требуются права администратора.")
        return account

    async def login(self, login: str, password: str, client: str) -> tuple[ConsoleAccount, str]:
        login = login.strip().casefold()
        for limiter, key in (
            (self.global_limiter, "login"),
            (self.login_limiter, client),
            (self.login_limiter, "account:" + login.casefold()),
        ):
            allowed, retry = await limiter.consume(key)
            if not allowed:
                raise HTTPException(
                    429, "Слишком много попыток входа.", headers={"Retry-After": str(retry)}
                )
        async with self.database.session() as session:
            account = await session.scalar(
                select(ConsoleAccount).where(ConsoleAccount.login == login.strip().casefold())
            )
        # Unknown accounts pay the same hashing cost and receive the same error.
        encoded = account.password_hash if account else "scrypt-v1$" + "00" * 16 + "$" + "00" * 32
        async with self.hash_slots:
            valid = await asyncio.to_thread(verify_password, password, encoded)
        if not valid or account is None or not account.active:
            raise HTTPException(401, "Неверный логин или пароль.")
        token = secrets.token_urlsafe(32)
        async with self.database.session() as session:
            # Serialize issuance with account revocation, including changes during hashing.
            current = await session.scalar(
                select(ConsoleAccount).where(ConsoleAccount.id == account.id).with_for_update()
            )
            if current is None or not current.active or current.password_hash != encoded:
                raise HTTPException(401, "Неверный логин или пароль.")
            await session.execute(
                delete(ConsoleSession).where(ConsoleSession.expires_at <= utcnow())
            )
            existing = list(
                (
                    await session.scalars(
                        select(ConsoleSession)
                        .where(ConsoleSession.account_id == account.id)
                        .order_by(ConsoleSession.expires_at.desc())
                    )
                ).all()
            )
            for old in existing[9:]:
                await session.delete(old)
            session.add(
                ConsoleSession(
                    token_hash=digest(token),
                    account_id=account.id,
                    expires_at=utcnow() + timedelta(seconds=SESSION_SECONDS),
                )
            )
            await session.commit()
        return account, token

    async def create_account(
        self, *, login: str, name: str, password: str, role: str, bootstrap: bool = False
    ) -> ConsoleAccount:
        login = login.strip().casefold()
        if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{2,63}", login):
            raise HTTPException(422, "Логин: 3–64 символа, латиница, цифры, точка, _ или -.")
        if role not in {"admin", "operator"} or not 1 <= len(name.strip()) <= 100:
            raise HTTPException(422, "Проверьте имя и роль.")
        try:
            async with self.hash_slots:
                encoded = await asyncio.to_thread(password_hash, password)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        async with self.database.session() as session:
            await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": ACCOUNT_LOCK})
            if bootstrap and await session.scalar(select(ConsoleAccount.id).limit(1)):
                raise HTTPException(409, "Первый администратор уже создан. Используйте панель.")
            account = ConsoleAccount(
                login=login,
                display_name=name.strip(),
                password_hash=encoded,
                role=role,
                active=True,
            )
            session.add(account)
            try:
                await session.commit()
            except IntegrityError as error:
                raise HTTPException(409, "Такой логин уже существует.") from error
            return account

    async def set_active(self, account_id: str, active: bool) -> None:
        async with self.database.session() as session:
            await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": ACCOUNT_LOCK})
            accounts = list((await session.scalars(select(ConsoleAccount).with_for_update())).all())
            account = next((item for item in accounts if item.id == account_id), None)
            if account is None:
                raise HTTPException(404, "Учётная запись не найдена.")
            if (
                not active
                and account.active
                and account.role == "admin"
                and sum(item.active and item.role == "admin" for item in accounts) <= 1
            ):
                raise HTTPException(409, "Нельзя отключить последнего администратора.")
            account.active = active
            if not active:
                await session.execute(
                    delete(ConsoleSession).where(ConsoleSession.account_id == account_id)
                )
            await session.commit()
