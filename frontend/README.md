# Панель операторов (Vue)

Новая панель на Vue 3, TypeScript, Vite, Tailwind CSS 4, Pinia и Reka UI. Она заменит классическую
`src/resolvate/console_assets/`. До переключения сборка отдаётся по `/console/next/`, если в окружении
установки указано `CONSOLE_NEXT_ENABLED=true`. Классическая `/console/` работает как раньше.

Нужен Node.js 24. Сборка пишет в `src/resolvate/console_next/` (каталог в `.gitignore`). Образ Docker
собирает её сам в стадии `frontend`.

```bash
npm ci
npm run dev       # Vite на :5173, API проксируется на установку на :8080 (CONSOLE_ORIGIN=http://localhost:8080)
npm run build     # production-сборка в ../src/resolvate/console_next
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
  одинаково. Ключ `localStorage` — `resolvate.theme`, как у классической панели.
- Минимальные браузеры (Tailwind CSS 4): Safari 16.4, Chrome 111, Firefox 128.

Браузерные тесты локально удобнее запускать в образе `mcr.microsoft.com/playwright:v1.63.0-noble`:
он уже содержит Chromium, Firefox и WebKit.
