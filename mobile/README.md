# SelfNote для iOS и Android

Expo + React Native. Данные — тот же Yjs-формат, что у веба (AGENTS.md §3.1): одно
WebSocket-соединение `/collab`, офлайн-копия всех документов в SQLite на телефоне.
Общий код (`extractDocument`, задачи, даты) берётся из `../app/packages/shared/src`
через `metro.config.js`.

## Первый запуск

```bash
cd mobile
npm install
npx expo install expo-router expo-linking expo-constants expo-status-bar expo-splash-screen \
  expo-font @expo-google-fonts/golos-text expo-secure-store expo-sqlite \
  react-native-safe-area-context react-native-screens react-native-svg \
  react-native-get-random-values
npm install yjs@^13.6.27 @hocuspocus/provider@^3.4.0 lucide-react-native
npx expo install --fix
npm run typecheck
npx expo start
```

## Редактор

Редактор — TipTap в WebView. Его исходники лежат в вебе (`app/apps/web/src/mobile-editor`),
схема документа общая с веб-редактором (`app/apps/web/src/editorSchema.ts`) — иначе
y-prosemirror молча выбросит незнакомые узлы. Собирается в одну HTML-строку:

```bash
npx expo install react-native-webview expo-image-picker expo-file-system   # один раз
npm run editor                          # = npm run build:mobile-editor -w @selfnote/web
```

Команда пишет `src/editor/editorHtml.ts` — **этот файл коммитим** (EAS собирает приложение
без папки app/). Пересобирать после любых правок в `mobile-editor/` или `editorSchema.ts`.
Пока файл пустой, заметки открываются только для чтения, кнопки «+» нет.

Протокол моста — `app/packages/shared/src/editorBridge.ts`: обновления Yjs ходят
в обе стороны в base64, сеть и токены остаются в приложении.

Хватает Expo Go (WebView в нём есть). Своя иконка и заставка видны только в собственной
сборке: `npx expo run:ios` или `eas build --profile development --platform ios`.

## Вход

Адрес сервера (можно без `https://`), почта и пароль. Приложение шлёт заголовок
`X-SelfNote-Client: app` — сервер отдаёт refresh-токен в теле ответа, а не в cookie;
токен хранится в Keychain/Keystore (`expo-secure-store`). Нужен сервер SelfNote
не старше версии с этим изменением (см. docs/changelog.md).

Для сервера в домашней сети по `http://192.168.…` на iOS включён `NSAllowsLocalNetworking`.

## Сборка в App Store

```bash
npm install -g eas-cli
eas login
eas build:configure      # один раз, привяжет проект к аккаунту Expo
eas build --platform ios --profile production
eas submit --platform ios
```

Bundle ID: `ru.nskarl.selfnote` (app.json).

## Структура

```
mobile/
├─ index.js            полифилы → expo-router
├─ app/                экраны (expo-router)
│  ├─ login.tsx        сервер, почта, пароль
│  └─ (app)/(tabs)/    Заметки, Задачи, Книжки, Настройки; note/[id] — заметка
└─ src/
   ├─ auth.ts          вход, обновление токена, выход
   ├─ session.tsx      аккаунт и рабочее пространство для React
   ├─ sync/            Workspace (Yjs + Hocuspocus) и LocalStore (SQLite)
   ├─ editor/          NoteEditor (WebView + мост), Toolbar, LinkDialog, editorHtml (сборка)
   ├─ NoteView.tsx     просмотр заметки без редактора (пока editorHtml не собран)
   └─ theme.ts, ui.tsx, dates.ts
```
