#!/bin/sh
# Новый том dev-базы: подключить настройки SuperApp6 (infra/postgres/superapp6.conf).
# Исполняется образом postgres ОДИН раз — при инициализации пустого каталога данных (скрипт
# без бита исполнения образ ПОДКЛЮЧАЕТ через `.`, поэтому без `set -u`: оно пережило бы скрипт).
# Готовый том — та же строка руками (docs/dev_environment.md) и рестарт контейнера.
CONF="$PGDATA/postgresql.conf"
LINE="include_if_exists = '/etc/postgresql/superapp6.conf'"
grep -qxF "$LINE" "$CONF" || echo "$LINE" >> "$CONF"
