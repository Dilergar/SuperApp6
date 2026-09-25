#!/bin/sh
# ============================================================
# Общее для скриптов бэкапа: подписанный отчёт в движок core/lifecycle
# ============================================================
# POST $SA6_API_BASE/lifecycle/ops/backups/report
#   Authorization: Bearer $LIFECYCLE_OPS_TOKEN
#   X-Lifecycle-Signature: t=<unix>,v1=<hex HMAC-SHA256(токен, "<t>.<тело>")>  (окно 5 минут)
# Отчёт идемпотентен по (вид, репозиторий, метка) — повтор после сетевого сбоя безопасен.
# Требует: curl, openssl, jq. Секреты — из окружения сервиса (systemd EnvironmentFile 0600).

: "${SA6_API_BASE:?SA6_API_BASE is required (https://api.example.kz/api)}"
: "${LIFECYCLE_OPS_TOKEN:?LIFECYCLE_OPS_TOKEN is required}"

# report <json-тело>
report() {
  body="$1"
  t=$(date +%s)
  sig=$(printf '%s.%s' "$t" "$body" | openssl dgst -sha256 -hmac "$LIFECYCLE_OPS_TOKEN" -hex | sed 's/^.*= *//')
  # Три попытки: отчёт — единственный сигнал «бэкап был»; его отсутствие поднимет тревогу
  for i in 1 2 3; do
    if curl -fsS --max-time 20 -X POST "$SA6_API_BASE/lifecycle/ops/backups/report" \
      -H "Authorization: Bearer $LIFECYCLE_OPS_TOKEN" \
      -H "X-Lifecycle-Signature: t=$t,v1=$sig" \
      -H 'Content-Type: application/json' \
      --data-binary "$body" >/dev/null; then
      return 0
    fi
    sleep $((i * 10))
  done
  echo "backup report was not delivered (the dashboard and the absence alert will show it)" >&2
  return 1
}

iso() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
