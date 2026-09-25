#!/bin/sh
# ============================================================
# Бэкап PostgreSQL в оба репозитория + отчёт в движок (docs/operations_backup_dr.md)
# ============================================================
#   backup.sh full     — полная (еженедельно)
#   backup.sh incr     — блочная инкрементальная (каждые 6 часов)
#   backup.sh verify   — проверка целостности репозиториев (ежедневно)
# Каждый репозиторий — своим прогоном и своим отчётом: упавший город 2 не маскируется успехом
# города 1. Отчёт об ошибке уходит так же, как об успехе; а если скрипт не запустился вовсе —
# тревогу поднимает ОТСУТСТВИЕ отчёта (lifecycle_backup_last_success_seconds, GitLab 2017).
set -eu
DIR=$(dirname "$0")
. "$DIR/lib.sh"

STANZA=${STANZA:-superapp6}
MODE=${1:?usage: backup.sh full|incr|verify}
case "$MODE" in full|incr|verify) ;; *) echo "unknown mode: $MODE" >&2; exit 2 ;; esac

rc_all=0
for repo in 1 2; do
  started=$(iso)
  if [ "$MODE" = verify ]; then
    if pgbackrest --stanza="$STANZA" --repo="$repo" verify; then status=ok; else status=failed; rc_all=1; fi
    body=$(jq -nc --arg kind verify --arg repo "repo$repo" --arg status "$status" --arg ext "verify-repo$repo-$started" \
      --arg s "$started" --arg f "$(iso)" \
      '{kind:$kind, repo:$repo, status:$status, externalId:$ext, startedAt:$s, finishedAt:$f, details:(if $status=="ok" then {} else {errorCode:"pgbackrest.verify_failed"} end)}')
    report "$body" || rc_all=1
    continue
  fi
  if pgbackrest --stanza="$STANZA" --repo="$repo" --type="$MODE" backup; then
    # Метка, границы и объём — из info последнего бэкапа этого репозитория. Сбой самого `info`
    # (репозиторий недоступен сразу после бэкапа) не должен превратить успех в молчание —
    # тогда уходит отчёт с меткой запуска и без объёма
    if info=$(pgbackrest --stanza="$STANZA" --repo="$repo" --output=json info 2>/dev/null)        && body=$(printf '%s' "$info" | jq -ce --arg repo "repo$repo" '
      .[0].backup | last |
      { kind: .type, repo: $repo, status: "ok", externalId: .label,
        startedAt: (.timestamp.start | todate | sub("Z$"; ".000Z")),
        finishedAt: (.timestamp.stop | todate | sub("Z$"; ".000Z")),
        bytes: .info.repository.delta,
        details: { walFrom: (.timestamp.start | todate | sub("Z$"; ".000Z")), walTo: (.timestamp.stop | todate | sub("Z$"; ".000Z")) } }' 2>/dev/null); then
      :
    else
      body=$(jq -nc --arg kind "$MODE" --arg repo "repo$repo" --arg ext "$MODE-repo$repo-$started" --arg s "$started" --arg f "$(iso)"         '{kind:$kind, repo:$repo, status:"ok", externalId:$ext, startedAt:$s, finishedAt:$f, bytes:null, details:{}}')
    fi
  else
    rc_all=1
    body=$(jq -nc --arg kind "$MODE" --arg repo "repo$repo" --arg ext "$MODE-repo$repo-$started" --arg s "$started" --arg f "$(iso)" \
      '{kind:$kind, repo:$repo, status:"failed", externalId:$ext, startedAt:$s, finishedAt:$f, details:{errorCode:"pgbackrest.backup_failed"}}')
  fi
  report "$body" || rc_all=1
done
exit "$rc_all"
