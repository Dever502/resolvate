# Локальные компоненты интерфейса

Для Telegram TGS используется **lottie-web 5.13.0**, сборка `lottie_light_canvas.min.js`
без движка expressions. Загружается с самой установки только при просмотре TGS;
CDN, внешние изображения и исполняемые выражения анимаций не используются.

- Источник: https://github.com/airbnb/lottie-web/tree/v5.13.0
- Пакет: https://registry.npmjs.org/lottie-web/-/lottie-web-5.13.0.tgz
- Лицензия MIT: `src/resolvate/console_assets/lottie_license.txt` (включена в образ).
- Неизменённый upstream-файл: `src/resolvate/console_assets/lottie_light_canvas.js`.
- SHA-256 файла: `0930bfecb5b5dad59dd9049a139fa957e57f70e0805fc94a311204e524e45e28`.
- SHA-512 npm-архива (base64):
  `+gfBXl6sxXMPe8tKQm7qzLnUy5DUPJPKIyRHwtpCpyUEYjHYRJC/5gjUvdkuO2c3JllrPtHXH5UJJK8LRYl5yQ==`.

При обновлении сверять источник, лицензию, контрольные суммы и отсутствие expression engine;
повторять браузерную проверку с действующей CSP. CSP ради проигрывателя не ослаблять.
