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
#
# Провал ЛЮБОГО шага до сверок (restore, старт кластера) тоже уходит отчётом `failed`: иначе
# дашборд молчал бы, а тревога RestoreDrillMissing пришла бы только через двое суток.
# pgBackRest возвращает лишь содержимое PGDATA: на Debian/Ubuntu postgresql.conf и pg_hba.conf
# живут в /etc/postgresql и в копию не попадают — скрипт дописывает минимальные файлы сам
# (RHEL/Alpine держат их в PGDATA — тогда они остаются как есть).
set -eu
DIR=$(dirname "$0")
. "$DIR/lib.sh"

STANZA=${STANZA:-superapp6}
REPO=${REPO:-1}
SCRATCH=${SCRATCH:-/var/lib/sa6-drill/pgdata}
PORT=${DRILL_PORT:-5499}
APP_DIR=${APP_DIR:-/opt/superapp6/apps/api}
# Каталог бинарников кластера (pg_ctl той же мажорной версии, что и бэкап); пусто — из PATH
PG_BIN=${PG_BIN:-}
: "${DRILL_SOURCE_URL:?DRILL_SOURCE_URL (read-only role on the primary) is required}"
: "${DRILL_DB_USER:?DRILL_DB_USER is required}"

case "$SCRATCH" in
  /|/var|/var/lib|/etc|/usr|/home|/root|"") echo "SCRATCH must be a dedicated directory, not $SCRATCH" >&2; exit 2 ;;
esac

pg_ctl_bin() { if [ -n "$PG_BIN" ]; then echo "$PG_BIN/pg_ctl"; else echo pg_ctl; fi; }

KIND=restore_drill
TARGET=""
if [ "${1:-}" = pitr ]; then
  KIND=pitr_drill
  # Случайная точка за последние 7 суток (в пределах окна PITR 35 дней)
  back=$(( $(od -An -N4 -tu4 /dev/urandom) % (7 * 86400) ))
  TARGET=$(date -u -d "@$(( $(date +%s) - back ))" '+%Y-%m-%d %H:%M:%S+00')
fi

started=$(iso)
# Сверки прошли (или скрипт сверок сам отправил свой отчёт) — отчёт о провале подготовки не нужен
checks_reached=0

report_failure() {
  code="$1"
  body=$(jq -nc --arg kind "$KIND" --arg repo "repo$REPO" --arg ext "$KIND-$started" --arg s "$started" --arg f "$(iso)" --arg code "$code" \
    '{kind:$kind, repo:$repo, status:"failed", externalId:$ext, startedAt:$s, finishedAt:$f, details:{errorCode:$code}}')
  report "$body" || true
}

cleanup() {
  rc=$?
  "$(pg_ctl_bin)" -D "$SCRATCH" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
  if [ "$rc" -ne 0 ] && [ "$checks_reached" -eq 0 ]; then
    report_failure "drill.restore_failed"
  fi
  exit "$rc"
}
trap cleanup EXIT

rm -rf "$SCRATCH" && mkdir -p "$SCRATCH" && chmod 700 "$SCRATCH"
if [ -n "$TARGET" ]; then
  pgbackrest --stanza="$STANZA" --repo="$REPO" --pg1-path="$SCRATCH" --type=time --target="$TARGET" --target-action=promote restore
else
  pgbackrest --stanza="$STANZA" --repo="$REPO" --pg1-path="$SCRATCH" --type=immediate --target-action=promote restore
fi

# Конфиги вне PGDATA (Debian): минимальный postgresql.conf — только чтобы кластер поднялся
if [ ! -f "$SCRATCH/postgresql.conf" ]; then
  cat > "$SCRATCH/postgresql.conf" <<EOF
# scratch-кластер учения восстановления — живёт минуты, наружу не смотрит
hba_file = '$SCRATCH/pg_hba.conf'
ident_file = '$SCRATCH/pg_ident.conf'
unix_socket_directories = '$SCRATCH'
max_connections = 20
shared_buffers = 256MB
timezone = 'UTC'
log_timezone = 'UTC'
log_parameter_max_length = 0
log_parameter_max_length_on_error = 0
EOF
fi
if [ ! -f "$SCRATCH/pg_hba.conf" ]; then
  cat > "$SCRATCH/pg_hba.conf" <<EOF
# только локальные сверки: сокет каталога копии и loopback
local   all   all                 peer
host    all   all   127.0.0.1/32  scram-sha-256
host    all   all   ::1/128       scram-sha-256
EOF
fi
[ -f "$SCRATCH/pg_ident.conf" ] || : > "$SCRATCH/pg_ident.conf"
# Копия не архивирует WAL и не принимает никого, кроме локальных сверок; postgresql.auto.conf
# читается последним и перекрывает и восстановленный, и минимальный postgresql.conf
cat >> "$SCRATCH/postgresql.auto.conf" <<EOF
archive_mode = off
listen_addresses = '127.0.0.1'
port = $PORT
unix_socket_directories = '$SCRATCH'
EOF
"$(pg_ctl_bin)" -D "$SCRATCH" -w -t 3600 -l "$SCRATCH/drill.log" start

checks_reached=1
DRILL_RESTORED_URL="postgresql://$DRILL_DB_USER@127.0.0.1:$PORT/superapp6" \
  node "$APP_DIR/scripts/lifecycle-restore-drill.cjs" --report --kind="$KIND" --repo="repo$REPO"
