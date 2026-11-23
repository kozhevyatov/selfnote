# SelfNote для macOS (Tauri 2)

Тот же веб-клиент (`app/apps/web`, сборка `--mode desktop`) в системном WebView.
Интерфейс лежит внутри приложения, сервер выбирается при первом запуске; вход —
почтой и паролем, refresh-токен хранится в приложении (без cookie, как в мобильном).
Заметки работают офлайн так же, как в браузере (IndexedDB).

## Что нужно один раз

```sh
xcode-select --install                                           # если ещё нет
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
cd desktop && npm install && npm run icons                        # CLI Tauri и значки
```

`npm run icons` делает из `app-icon.png` все размеры в `src-tauri/icons/` —
их стоит закоммитить. Нужен свежий сервер: десктоп-приложению нужен CORS из этой
версии (пересобрать Docker-образ).

## Сборка

```sh
cd desktop
npm run build            # → src-tauri/target/release/bundle/macos/SelfNote.app и dmg/
npm run dev              # запуск без упаковки (с отладкой: правый клик → Inspect)
```

Для Mac на Intel и Apple Silicon сразу: `rustup target add x86_64-apple-darwin`,
затем `npm run build:universal`.

Без подписи macOS при первом запуске скажет «неизвестный разработчик»:
правый клик по SelfNote.app → «Открыть». Подпись и нотаризация — позже
(Developer ID из аккаунта разработчика Apple).

## Как устроено

- `src-tauri/src/main.rs` — окно (размер и положение запоминаются), меню на русском,
  загрузки (экспорт, резервные копии) — в «Загрузки».
- Меню: ⌘N — заметка, ⌘⇧L — список задач, ⌘K — поиск, ⌘, — настройки, ⌘R — обновить.
  Пункты меню шлют в страницу событие `selfnote:menu` (обработчик в `App.tsx`).
- Внешние ссылки открываются в браузере (`openExternalLinks` в `platform.ts`).
- Режим desktop в вебе: `apps/web/src/platform.ts` (адрес сервера, токен, WebSocket,
  ссылки для других людей), экран «Подключение к серверу» — `ServerSetup.tsx`.
- Сервер разрешает CORS только для `tauri://localhost` и `http(s)://tauri.localhost`
  (без cookie).
