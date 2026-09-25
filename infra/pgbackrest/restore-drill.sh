#!/bin/sh
# ============================================================
# Ночное учение восстановления (scratch-хост; docs/operations_backup_dr.md)
# ============================================================
#   restore-drill.sh               — последний бэкап репозитория (restore_drill)
#   restore-drill.sh pitr          — случайная точка времени за последние 7 дней (pitr_drill)
# Восстановление в ЧИСТЫЙ каталог scratch-хоста в изолированной сети (копия не видна продукту),
# старт на отдельном порту, сверки apps/api/scripts/lifecycle-restore-drill.cjs (строки, Σ=0
# леджера, дайджесты журнала безопасности, журнал стираний), отчёт с RTO — в движок. Копия
# уничтожается после сверок: в ней ПДн, живущие дольше, чем нужно учению.
set -eu
DIR=$(dirname "$0")
. "$DIR/lib.sh"

STANZA=${STANZA:-superapp6}
REPO=${REPO:-1}
SCRATCH=${SCRATCH:-/var/lib/sa6-drill/pgdata}
PORT=${DRILL_PORT:-5499}
APP_DIR=${APP_DIR:-/opt/superapp6/apps/api}
: "${DRILL_SOURCE_URL:?DRILL_SOURCE_URL (read-only role on the primary) is required}"
: "${DRILL_DB_USER:?DRILL_DB_USER is required}"

KIND=restore_drill
TARGET=""
if [ "${1:-}" = pitr ]; then
  KIND=pitr_drill
  # Случайная точка за последние 7 суток (в пределах окна PITR 35 дней)
  back=$(( $(od -An -N4 -tu4 /dev/urandom) % (7 * 86400) ))
  TARGET=$(date -u -d "@$(( $(date +%s) - back ))" '+%Y-%m-%d %H:%M:%S+00')
fi

cleanup() {
  pg_ctl -D "$SCRATCH" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

started=$(iso)
rm -rf "$SCRATCH" && mkdir -p "$SCRATCH" && chmod 700 "$SCRATCH"
if [ -n "$TARGET" ]; then
  pgbackrest --stanza="$STANZA" --repo="$REPO" --pg1-path="$SCRATCH" --type=time --target="$TARGET" --target-action=promote restore
else
  pgbackrest --stanza="$STANZA" --repo="$REPO" --pg1-path="$SCRATCH" --type=immediate --target-action=promote restore
fi
# Копия не архивирует WAL и не принимает никого, кроме локальных сверок
cat >> "$SCRATCH/postgresql.auto.conf" <<EOF
archive_mode = off
listen_addresses = '127.0.0.1'
port = $PORT
EOF
pg_ctl -D "$SCRATCH" -w -t 3600 start

DRILL_RESTORED_URL="postgresql://$DRILL_DB_USER@127.0.0.1:$PORT/superapp6" \
  node "$APP_DIR/scripts/lifecycle-restore-drill.cjs" --report --kind="$KIND" --repo="repo$REPO"
