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

## Ограничения

- CSP панели не ослабляется (`src/resolvate/console.py`): `script-src 'self'`, `style-src 'self'`, без
  `unsafe-inline`, `data:` и `blob:`. Статические атрибуты `style="…"` в шаблонах, `v-html`, блоки
  `<style>` в компонентах и строковые `:style` запрещены тестом `src/templates.test.ts`. Динамический
  `:style` объектом допустим: Vue применяет его через CSSOM.
- Компоненты Reka UI, которые вставляют `<style>` (viewport у Select, ScrollArea, Combobox), не
  используются: CSP их блокирует.
- Тема применяется скриптом `src/boot/theme-boot.js` до первой отрисовки, для экрана входа и панели
  одинаково. Ключ `localStorage` — `resolvate.theme` (сохранённые настройки совместимы).
- Минимальные браузеры (Tailwind CSS 4): Safari 16.4, Chrome 111, Firefox 128.

Браузерные тесты локально удобнее запускать в образе `mcr.microsoft.com/playwright:v1.63.0-noble`:
он уже содержит Chromium, Firefox и WebKit.
