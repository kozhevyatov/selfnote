# Примеры установки SelfNote

| Папка | Вариант |
|---|---|
| [`sqlite/`](sqlite) | Один контейнер, база SQLite в `./data` — самый простой запуск |
| [`mariadb-existing/`](mariadb-existing) | Подключение к уже работающей MariaDB/MySQL в другой Docker-сети (`DB_NETWORK`) |
| [`mariadb-bundled/`](mariadb-bundled) | SelfNote и собственная MariaDB в одном проекте |

В каждой папке — `docker-compose.yml` и `env.example` (переименуйте в `.env` рядом с compose).
Пошаговая инструкция и что вводить в мастере первого запуска — в [README](../README.md#установка).
