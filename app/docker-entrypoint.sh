#!/bin/sh
# Запуск SelfNote. Стартует от root, готовит папку данных и сбрасывает права.
# Нужно для Synology: папку data/ создаёт пользователь DSM, а у общих папок
# есть ACL, поэтому одной смены владельца бывает недостаточно.
# PUID/PGID (необязательно) — от какого пользователя NAS запускать сервис.
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" != "0" ]; then
  echo "selfnote: запуск от $(id -u):$(id -g) (без root, права на $DATA_DIR не проверяются)"
  exec "$@"
fi
RUN_UID="${PUID:-$(id -u node)}"
RUN_GID="${PGID:-$(id -g node)}"
mkdir -p "$DATA_DIR"
if [ "$(stat -c %u "$DATA_DIR")" != "$RUN_UID" ] || [ "$(stat -c %g "$DATA_DIR")" != "$RUN_GID" ]; then
  echo "selfnote: передаю $DATA_DIR пользователю $RUN_UID:$RUN_GID"
  chown -R "$RUN_UID:$RUN_GID" "$DATA_DIR" || echo "selfnote: не удалось сменить владельца $DATA_DIR"
fi
PROBE="$DATA_DIR/.write-test-$$"
if setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups sh -c "touch '$PROBE' && rm -f '$PROBE'" 2>/dev/null; then
  echo "selfnote: запуск от $RUN_UID:$RUN_GID"
  exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups "$@"
fi
rm -f "$PROBE" 2>/dev/null || true
echo "selfnote: ВНИМАНИЕ — пользователь $RUN_UID:$RUN_GID не может писать в $DATA_DIR (вероятно, ACL Synology)."
echo "selfnote: запускаю от root. Чтобы этого избежать, задайте PUID/PGID своего пользователя DSM."
exec "$@"
