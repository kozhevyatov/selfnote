<div align="center">

# SelfNote

**Заметки и задачи на вашем собственном сервере.**
Работает без интернета, синхронизируется между устройствами, хранит историю каждой правки.

[![Проверка и сборка образа](https://github.com/kozhevyatov/selfnote/actions/workflows/docker.yml/badge.svg)](https://github.com/kozhevyatov/selfnote/actions/workflows/docker.yml)
[![Образ в GHCR](https://img.shields.io/badge/ghcr.io-kozhevyatov%2Fselfnote-2496ED?logo=docker&logoColor=white)](https://github.com/kozhevyatov/selfnote/pkgs/container/selfnote)

![Главный экран SelfNote](docs/screenshots/main.png)

</div>

## Зачем

SelfNote — замена облачным заметкам и Synology Note Station, которая живёт на вашем NAS или сервере в одном Docker-контейнере. Заметки принадлежат вам, а не сервису: база — SQLite или ваша MariaDB, картинки — обычные файлы в папке `data/`.

## Возможности

**Заметки**
- Записные книжки с подразделами и метки. Закрепление, корзина с автоочисткой через 30 дней.
- Простой редактор: жирный, курсив, зачёркнутый, **скрытый текст** (по клику), ссылки, заголовки, списки, картинки (вставка из буфера и перетаскиванием).
- Автосохранение — без кнопки «Сохранить».
- Мгновенный поиск по всем заметкам, в том числе без сети.

**Задачи**
- Чек-листы прямо в заметках, у каждого пункта — свой срок.
- Вкладка «Задачи»: сегодня, просрочено, предстоящие, без срока, выполненные.
- На главном экране — что нужно сделать сегодня, из всех заметок сразу.

**Надёжность**
- **Офлайн по-настоящему**: все заметки хранятся на устройстве, правки без сети догоняют сервер, как только он снова доступен. Конфликтов «чья версия главнее» нет — изменения сливаются (Yjs).
- **История версий** у каждой заметки: просмотр, подсветка изменений, восстановление одной кнопкой.
- Синхронизация в реальном времени между вкладками и устройствами.
- Пароли — Argon2id, короткоживущие токены, отзыв сессий, защита от перебора.
- Картинки: автоповорот, удаление EXIF (геометок), сжатие в WebP, превью.

**Дома на сервере**
- Один контейнер, мастер первого запуска: SQLite или существующая MariaDB, администратор, открытая/закрытая регистрация.
- Устанавливается как приложение (PWA) на телефон и компьютер.
- Сам разбирается с правами на папку данных на Synology.

<p align="center">
  <img src="docs/screenshots/note.png" alt="Открытая заметка с чек-листом и сроками задач" width="100%">
</p>

## Установка

Нужен Docker с Compose (на Synology — Container Manager). Готовые файлы для трёх вариантов лежат в [`samples/`](samples/): выберите один, скачайте его `docker-compose.yml` и `env.example` в пустую папку сервиса.

| Вариант | Когда выбрать | Файлы |
|---|---|---|
| **SQLite** | Один пользователь или семья, самый простой запуск | [`samples/sqlite`](samples/sqlite) |
| **Существующая MariaDB** | На сервере уже работает MariaDB/MySQL в Docker | [`samples/mariadb-existing`](samples/mariadb-existing) |
| **SelfNote + MariaDB** | Нужна отдельная MariaDB, а своей нет — поднимется вместе с сервисом | [`samples/mariadb-bundled`](samples/mariadb-bundled) |

### 1. Скачать файлы

```bash
mkdir selfnote && cd selfnote
VARIANT=sqlite          # или mariadb-existing, или mariadb-bundled
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/kozhevyatov/selfnote/main/samples/$VARIANT/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/kozhevyatov/selfnote/main/samples/$VARIANT/env.example
mkdir data
```

На Synology без SSH: создайте папку в `docker/selfnote`, положите туда `docker-compose.yml` и `.env` через File Station, затем Container Manager → «Проект» → «Создать» → укажите эту папку.

### 2. Подготовить вариант

**SQLite** — ничего делать не нужно.

**Существующая MariaDB.** В `.env` укажите `DB_NETWORK` — Docker-сеть, где работает база (`docker network ls`; на Synology часто `db`). Создайте базу и пользователя:

```sql
CREATE DATABASE selfnote CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'selfnote'@'%' IDENTIFIED BY 'длинный-пароль';
GRANT ALL PRIVILEGES ON selfnote.* TO 'selfnote'@'%';
FLUSH PRIVILEGES;
```

**SelfNote + MariaDB.** В `.env` придумайте `MARIADB_PASSWORD` и `MARIADB_ROOT_PASSWORD`. База и пользователь создадутся сами, файлы базы — в папке `mariadb/` рядом с compose.

### 3. Запустить

```bash
docker compose up -d
docker compose logs -f selfnote     # первая строка: «selfnote: запуск от …»
```

### 4. Пройти мастер первого запуска

Откройте `http://адрес-сервера:1339`:

| Вариант | Что выбрать в мастере |
|---|---|
| SQLite | «SQLite» |
| Существующая MariaDB | «MariaDB», хост — имя контейнера базы в сети (например `db`), порт `3306`, база/пользователь/пароль — созданные выше |
| SelfNote + MariaDB | «MariaDB», хост `mariadb`, порт `3306`, база и пользователь `selfnote`, пароль — `MARIADB_PASSWORD` из `.env` |

Затем создайте администратора и выберите режим регистрации: открытая, закрытая или по приглашению.

### 5. HTTPS

Откройте сервис через домен с HTTPS — например, через Nginx Proxy Manager: прокси на `адрес-сервера:1339`, включить **Websockets Support** (нужен для синхронизации) и выпустить сертификат. В `.env` задайте:

```env
APP_ORIGIN=https://notes.example.ru
COOKIE_SECURE=true
```

и примените: `docker compose up -d`. Без HTTPS заметки работают, но браузер не даёт установить приложение на телефон и запускать его без сети.

> **Права на папку `data/` настраивать не нужно.** Контейнер сам отдаёт её пользователю сервиса. Чтобы файлы принадлежали вашему пользователю (на Synology — пользователю DSM), задайте в `.env` `PUID` и `PGID` (узнать: `id` по SSH).

### Обновление

```bash
docker compose pull
docker compose up -d
```

Миграции базы выполняются сами при запуске. Данные в `data/` при обновлении не трогаются.

### Настройки (`.env`)

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `PORT` | `1339` | Внешний порт на хосте |
| `APP_ORIGIN` | — | Полный адрес сервиса, например `https://notes.example.ru` |
| `COOKIE_SECURE` | `false` | `true`, если сервис открыт по HTTPS |
| `TRUST_PROXY` | `false` | `true`, только если сервис доступен исключительно через ваш reverse proxy |
| `PUID` / `PGID` | `1000` | От какого пользователя хоста работать (на Synology — ваш пользователь DSM, `id` по SSH) |
| `SELFNOTE_TAG` | `latest` | Версия образа: `latest`, номер релиза или `sha-…` |
| `DB_NETWORK` | `db` | Только `mariadb-existing`: Docker-сеть существующей базы |
| `MARIADB_*` | — | Только `mariadb-bundled`: имя базы, пользователь и пароли встроенной MariaDB |

### Резервные копии

Всё состояние сервиса — папка `data/`: база SQLite (или настройки подключения к MariaDB), картинки, ключ токенов; в варианте с встроенной базой — ещё папка `mariadb/`. Для файловой копии остановите контейнеры (`docker compose stop`); при внешней MariaDB сохраняйте ещё и дамп базы. Автоматические бэкапы, экспорт и импорт (в том числе из Synology Note Station) — в ближайших планах.

## Планы

- [x] Фундамент: аккаунты, книжки и подразделы, редактор, задачи со сроками, картинки, офлайн-синхронизация
- [x] История версий и корзина
- [ ] Автоматические бэкапы, экспорт в Markdown, импорт из Synology Note Station и Markdown
- [ ] Повторяющиеся задачи, тёмная тема, перенос заметок перетаскиванием, серверный поиск
- [ ] Пароль на заметку (шифрование на устройстве)
- [ ] Публичные ссылки с паролем и сроком жизни
- [ ] Совместное редактирование: приглашения и гостевой доступ по ссылке с PIN
- [ ] Напоминания о сроках задач
- [ ] Мобильное приложение

## Технологии

React · TipTap · Yjs · IndexedDB · Hocuspocus · Fastify · Kysely (SQLite / MariaDB) · sharp · Vite PWA · TypeScript

## Для разработчиков

- [docs/development.md](docs/development.md) — локальный запуск, проверки, сборка образа из исходников, хранение данных.
- [docs/changelog.md](docs/changelog.md) — история изменений.
- [AGENTS.md](AGENTS.md) — полное техническое задание, архитектура и правила для ИИ-агентов.

Образ собирается и публикуется GitHub Actions при каждом push в `main`: сначала проверки типов, линтер, unit- и интеграционные тесты, затем сборка `ghcr.io/kozhevyatov/selfnote`.
