# Resolvate

Resolvate — система технической поддержки с Telegram, Web-панелью операторов и server-to-server
API. Обращения из бота и с сайта доступны в панели и отдельных темах закрытой Forum-группы.
Переписка, вложения, состояние тикетов и история действий сохраняются и переживают перезапуск.

> Версия: `v4.0.0`.

## Возможности

- один постоянный тикет и одна Forum-тема на идентичность в каждом канале;
- двусторонняя передача текста, фото, видео и PDF до 20 MiB;
- [Web-панель операторов](docs/CONSOLE.md): диалоги, история, готовые ответы через `/`, аккаунты;
- Web API для текста и вложений, cursor polling ответов, close/rating/reopen;
- компактная статистика Telegram/Web в General topic;
- общая тема быстрых ответов с произвольными хештегами и нативным поиском Telegram;
- закрытие и повторное открытие обращений, оценки, блокировка и внутренние заметки;
- единый список администраторов с доступом ко всем командам;
- durable очередь доставки с повторами и восстановлением после сбоев;
- PostgreSQL 16 с раздельными least-privilege ролями для миграций и приложения;
- независимые Web Support API и Operator API;
- healthcheck, readiness, Prometheus-метрики, JSON-логи и backup/restore;
- полноценная интеграция с Remnawave 2.8.x: подписка, продление, перевыпуск ссылки и ключей,
  сброс устройств и безопасное восстановление неизвестного результата;
- подписанный notification webhook с durable at-least-once доставкой.

## Как это работает

```text
Telegram-клиент ── Telegram bot ──┐
                                  ├── Resolvate + БД ── Forum-темы операторов
Backend сайта ───── Web API ──────┘
                                  │
                           Web-панель / Operator API (опционально)
```

Первое сообщение создаёт тикет и тему. Ответ из темы доставляется Telegram-клиенту либо становится
доступен backend сайта через polling. После закрытия новое сообщение повторно открывает тикет.

## Быстрый запуск

Понадобятся Docker Compose v2, Telegram-бот и приватная supergroup с включёнными Topics.

1. Клонируйте репозиторий и подготовьте конфигурацию:

   ```bash
   git clone https://github.com/Dever502/resolvate.git
   cd resolvate
   cp .env.example .env
   ```

2. Создайте бота через [@BotFather](https://t.me/BotFather), добавьте его администратором
   Forum-группы с правами управления темами и удаления сообщений, затем заполните `.env`:

   ```dotenv
   SUPPORT_BOT_TOKEN=replace-with-bot-token
   SUPPORT_GROUP_ID=replace-with-forum-group-id
   ADMIN_TELEGRAM_IDS=replace-with-admin-id
   DATA_DIR=./data
   POSTGRES_ADMIN_PASSWORD=replace-with-random-password-1
   POSTGRES_MIGRATION_PASSWORD=replace-with-random-password-2
   POSTGRES_RUNTIME_PASSWORD=replace-with-random-password-3
   ```

   Для поддержки сайта дополнительно включите `WEB_API_ENABLED`, задайте отдельный
   `WEB_API_TOKEN` и выберите `WEB_IDENTITY_MODE`. Браузер к этому API не обращается: запросы
   выполняет только backend сайта через HTTPS reverse proxy.

   Для операторской панели задайте `CONSOLE_ORIGIN` и создайте первого администратора
   по [инструкции](docs/CONSOLE.md). Панель использует собственные логин и пароль.

   Пароли должны быть разными, URL-safe и длиной не менее 16 символов.

3. Запустите Resolvate:

   ```bash
   ./scripts/start.sh
   ```

Скрипт скачивает image `v4.0.0`, закрепляет фактически полученный digest, проверяет Compose и ждёт
успешного healthcheck. Конфигурация PostgreSQL и разделение migration/runtime ролей описаны в
[руководстве по эксплуатации](docs/OPERATIONS.md).

Версия 4.0 рассчитана на чистую установку PostgreSQL. Обновление баз данных из версий 3.x
не поддерживается.

Скрипт — только прозрачная обёртка. Прямой запуск Compose остаётся доступен:

```bash
export APP_IMAGE='ghcr.io/dever502/resolvate@sha256:<digest>'
export RESOLVATE_ENV_FILE="$PWD/.env"
docker compose --env-file .env -f compose.production.postgres.yaml up --detach --wait
```

## Container image

Официальный способ поставки — container image в GHCR. `scripts/start.sh` автоматически разрешает
version tag в immutable digest. Для явной установки и rollback также можно передать digest:

```bash
./scripts/start.sh 'ghcr.io/dever502/resolvate@sha256:<digest>'
```

PyPI-пакет и wheel для релиза не публикуются.

## Документация

- [Эксплуатация](docs/OPERATIONS.md) — настройка, PostgreSQL, deploy, backup/restore и диагностика.
- [Техническое устройство](docs/TECHNICAL.md) — архитектура, данные, очереди, API и интеграции.
- [Наблюдаемость](docs/OBSERVABILITY.md) — метрики, alerts и incident runbook.

## Лицензия

Resolvate распространяется на условиях [GNU Affero General Public License версии 3.0](LICENSE)
(`AGPL-3.0-only`).

Коммерческое использование разрешено при соблюдении условий AGPL. Если вы изменяете Resolvate и
предоставляете к нему доступ через сеть, соответствующий исходный код должен быть доступен
пользователям этой версии.

Организации, которым необходимо использовать Resolvate без требований AGPL, могут получить
отдельную коммерческую лицензию. Подробности указаны в
[COMMERCIAL.md](COMMERCIAL.md).
