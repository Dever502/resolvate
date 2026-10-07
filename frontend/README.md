# Панель операторов (Vue)

Единственная панель на Vue 3, TypeScript, Vite, Tailwind CSS 4, Pinia и Reka UI, доступная по
`/console/`. Сейчас реализованы вход, выход, восстановление проверки сессии, тема и каркас.
Диалоги и управление ещё не перенесены; backend API и Telegram продолжают работать.

Нужен Node.js 24. Сборка пишет в `src/resolvate/console_dist/` (каталог в `.gitignore`). Образ Docker
собирает её сам в стадии `frontend`.

```bash
npm ci --ignore-scripts
npm run dev       # Vite на :5173, API проксируется на установку на :8080 (CONSOLE_ORIGIN=http://localhost:8080)
npm run build     # production-сборка в ../src/resolvate/console_dist
npm run check     # lockfile, типы, модульные тесты, сборка, проверка под CSP, лицензии
npx playwright test --project=chromium   # браузерные тесты против сборки и заглушки API
```

## Структура `src/`

- `api/` — клиент API панели и типы ответов. Любой сбой запроса — `ApiError` с текстом для оператора;
  запрос, отменённый вызывающим кодом, отклоняется как отменённый.
- `stores/` — состояние приложения (Pinia): сессия, тема.
- `composables/` — механика браузера и интерфейса без собственного доменного состояния.
- `components/<домен>/` — экраны и их части: `auth/` (вход), `workspace/` (каркас рабочей области),
  `account/` (аккаунт оператора: сводка, тема, выход). Папка домена появляется вместе с его первым
  экраном — `projects/`, `tickets/`, `folders/`, `chat/` и так далее, — а не заранее.
- `components/ui/` — общие примитивы без доменной логики: `Icon`, `IconButton`.
- `lib/` — чистые функции, `boot/` — скрипт темы до первой отрисовки, `styles/` — Tailwind и токены.

## UI-примитивы

- Нативные `button`, `input`, `textarea`, `form` и `label` остаются нативными, оформление — в
  `styles/app.css`. Обёртка в `components/ui/` нужна, когда повторяется поведение, а не разметка.
- Составные контролы — на Reka UI: она даёт клавиатуру, фокус и ARIA. Подписи кнопок-иконок —
  Tooltip через `ui/IconButton.vue`; окна, вкладки, меню, всплывающие панели и выбор из списка — Dialog,
  Tabs, DropdownMenu, Popover и Listbox. Обёртка появляется вместе с первым экраном, которому она нужна.
- Кнопка, которая ждёт ответа сервера, получает `aria-disabled="true"` и игнорирует повторное нажатие:
  атрибут `disabled` сбросил бы фокус клавиатуры.
- Когда один экран сменяет другой, фокус переходит на его заголовок или первое поле.
- Поведение проверяет `e2e/a11y.spec.ts` на production-сборке под CSP панели: клавиатура (Tab, Enter,
  пробел, Esc), фокус, роли и имена для скринридера, отсутствие нарушений CSP.

## Ограничения

- CSP панели не ослабляется (`src/resolvate/console.py`): `script-src 'self'`, `style-src 'self'`, без
  `unsafe-inline`, `data:` и `blob:`. Статические атрибуты `style="…"` в шаблонах, `v-html`, блоки
  `<style>` в компонентах и строковые `:style` запрещены тестом `src/templates.test.ts`. Динамический
  `:style` объектом допустим: Vue применяет его через CSSOM.
- Компоненты Reka UI, которые вставляют `<style>` (в reka-ui 2.11.0 — viewport у Select, Combobox и
  ScrollArea, а также `Viewport`), не используются: CSP их блокирует, а ослаблять её ради оформления
  нельзя (`docs/DESIGN.md`).
- Тема применяется скриптом `src/boot/theme-boot.js` до первой отрисовки, для экрана входа и панели
  одинаково. Ключ `localStorage` — `resolvate.theme` (сохранённые настройки совместимы).
- Минимальные браузеры (Tailwind CSS 4): Safari 16.4, Chrome 111, Firefox 128.

Браузерные тесты локально удобнее запускать в образе `mcr.microsoft.com/playwright:v1.63.0-noble`:
он уже содержит Chromium, Firefox и WebKit.
