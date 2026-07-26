#!/usr/bin/env bash
# Сборка base-образа редактора документов. Запускается ВНУТРИ Dockerfile.builder;
# снаружи её дёргает build.ps1. Логика живёт здесь, а не в PowerShell, потому что
# всё, что она делает, — линуксовое.
#
# Монтируется при запуске:
#   /work    — infra/docs-editor из репозитория (только чтение по смыслу)
#   /build   — том со сборочным деревом: клон, builddir, instdir (переживает запуски)
#   /assets  — том с ассетом движка (445 МБ, качаем один раз)
#   /var/run/docker.sock — сокет демона хоста, в него уходит финальный docker build
set -euo pipefail

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mОШИБКА: %s\033[0m\n' "$*" >&2; exit 1; }

[ -f /work/pins.env ] || die "не вижу /work/pins.env — смонтирован ли infra/docs-editor в /work?"
# shellcheck disable=SC1091
set -a; . /work/pins.env; set +a

: "${ONLINE_COMMIT:?не задан в pins.env}"
: "${IMAGE_BASE:?не задан в pins.env}"
: "${BASE_TAG:?не задан в pins.env}"

SRC=/build/from-source
ASSET_FILE=/assets/engine-assets.tar.gz

########################################################################
log "1/5 Ассет движка"
########################################################################
# Скачиваем один раз и проверяем контрольную сумму. Ассет перезаливают по тому же
# URL, поэтому «пересборка без изменений» без этой проверки могла бы тихо подменить
# версию LibreOffice под нами.
if [ -n "${ENGINE_ASSETS_URL:-}" ]; then
  if [ ! -f "$ASSET_FILE" ]; then
    echo "качаю $ENGINE_ASSETS_URL (~440 МБ, один раз)"
    wget --progress=dot:giga -O "$ASSET_FILE.part" "$ENGINE_ASSETS_URL"
    mv "$ASSET_FILE.part" "$ASSET_FILE"
  else
    echo "ассет уже в томе, повторно не качаю"
  fi

  ACTUAL=$(sha256sum "$ASSET_FILE" | cut -d' ' -f1)
  if [ -z "${ENGINE_ASSETS_SHA256:-}" ]; then
    # Trust on first use: печатаем и требуем вписать в pins.env, чтобы со следующего
    # раза подмена уже не прошла молча.
    echo
    echo "  ┌─────────────────────────────────────────────────────────────────"
    echo "  │ SHA256 ассета ещё не закреплён. Впишите в infra/docs-editor/pins.env:"
    echo "  │   ENGINE_ASSETS_SHA256=$ACTUAL"
    echo "  └─────────────────────────────────────────────────────────────────"
    echo
    [ "${ACCEPT_NEW_ASSET:-}" = "1" ] || die "остановился намеренно: закрепите сумму и запустите снова (или ACCEPT_NEW_ASSET=1)"
  elif [ "$ACTUAL" != "$ENGINE_ASSETS_SHA256" ]; then
    echo "  ожидали: $ENGINE_ASSETS_SHA256"
    echo "  на диске: $ACTUAL"
    [ "${ACCEPT_NEW_ASSET:-}" = "1" ] || die "ассет НЕ совпал с пином. Это либо перезалив upstream, либо битая закачка. Разберитесь и обновите pins.env осознанно (или ACCEPT_NEW_ASSET=1)"
  else
    echo "sha256 совпал с пином"
  fi
  # build.sh забирает ассет через `wget "$ENGINE_ASSETS"`, а wget в Ubuntu отвечает на
  # file:// «Unsupported scheme» (проверено: GNU Wget 1.21.4). Патчить upstream ради
  # одной схемы не хочется, поэтому поднимаем на минуту локальный HTTP поверх тома —
  # ассет никуда не уходит с машины, слушаем только 127.0.0.1.
  ( cd /assets && python3 -m http.server 18080 --bind 127.0.0.1 >/dev/null 2>&1 ) &
  ASSET_SRV=$!
  trap 'kill "$ASSET_SRV" 2>/dev/null || true' EXIT
  ENGINE_ASSETS="http://127.0.0.1:18080/$(basename "$ASSET_FILE")"
  for _ in $(seq 1 20); do
    wget -q -O /dev/null "$ENGINE_ASSETS" && break
    sleep 0.5
  done
  wget -q -O /dev/null "$ENGINE_ASSETS" || die "локальная раздача ассета не поднялась — сборка всё равно упала бы на этом шаге"
  echo "ассет раздаётся локально: $ENGINE_ASSETS"
else
  echo "ENGINE_ASSETS_URL пуст → движок будет собран из исходников (часы, много памяти)"
  ENGINE_ASSETS=""
fi

########################################################################
log "2/5 Пин исходников на коммит"
########################################################################
# build.sh умеет только ВЕТКУ, а нам нужен точный коммит. Вместо патча upstream
# заводим локальный bare-репозиторий, в котором ветка `pinned` навсегда указывает
# на нужный коммит, и подсовываем его как «удалённый». Тогда `git fetch/pull`
# внутри build.sh отрабатывают штатно и никуда нас не увозят.
PIN_REPO=/build/pin.git
if [ ! -d "$PIN_REPO" ] || ! git -C "$PIN_REPO" rev-parse --verify -q pinned >/dev/null; then
  rm -rf "$PIN_REPO"; mkdir -p "$PIN_REPO"
  git init --bare -q "$PIN_REPO"
  # Тянем РОВНО нужный коммит. Зеркало на GitHub это умеет; если нет — добираем глубиной.
  MIRROR=https://github.com/CollaboraOnline/online.mirror
  echo "тяну коммит $ONLINE_COMMIT"
  if ! git -C "$PIN_REPO" fetch --depth=1 "$MIRROR" "$ONLINE_COMMIT:refs/heads/pinned" 2>/dev/null; then
    echo "по sha не отдал — добираю ветку с глубиной"
    git -C "$PIN_REPO" fetch --depth=200 "$MIRROR" "$ONLINE_BRANCH:refs/heads/upstream"
    git -C "$PIN_REPO" branch -f pinned "$ONLINE_COMMIT" \
      || die "коммит $ONLINE_COMMIT не найден в последних 200 ветки $ONLINE_BRANCH — ветка ушла далеко вперёд, обновите pins.env"
  fi
fi
GOT=$(git -C "$PIN_REPO" rev-parse pinned)
[ "$GOT" = "$ONLINE_COMMIT" ] || die "в пин-репозитории лежит $GOT вместо $ONLINE_COMMIT"
echo "pinned = $GOT"

########################################################################
log "3/5 Раскладка сборочного дерева"
########################################################################
# Копируем вендоренную обвязку на том: build.sh кладёт builddir/ и instdir/ РЯДОМ
# с собой, и в репозитории им делать нечего.
mkdir -p "$SRC"
cp -f /work/upstream/build.sh /work/upstream/Ubuntu /work/upstream/.dockerignore "$SRC/"
chmod +x "$SRC/build.sh"
for p in /work/patches/*.patch; do
  [ -e "$p" ] || break
  echo "накладываю патч $(basename "$p")"
  ( cd "$SRC" && git apply -p1 "$p" ) || die "патч $p не лёг"
done

########################################################################
log "4/5 Сборка online (coolwsd + браузерный клиент)"
########################################################################
export DOCKER_HUB_REPO="$IMAGE_BASE"
export DOCKER_HUB_TAG="$BASE_TAG"
export COLLABORA_ONLINE_REPO="$PIN_REPO"
export COLLABORA_ONLINE_BRANCH=pinned
export ENGINE_ASSETS
export ENGINE_BUILD_TARGET=""
# ВАЖНО: подставляется в ./configure БЕЗ кавычек и без eval — шелл разобьёт значение
# по пробелам. Поэтому только ASCII и без пробелов внутри отдельного значения.
# Название с пробелом/кириллицей делается оверлеем бренда, а не отсюда.
export ONLINE_EXTRA_BUILD_OPTIONS="--with-vendor=SuperApp6 --with-app-name=SuperApp6 --with-max-documents=9999 --with-max-connections=9999"

echo "образ:  $DOCKER_HUB_REPO:$DOCKER_HUB_TAG"
echo "движок: ${ENGINE_ASSETS:-из исходников}"
echo "опции:  $ONLINE_EXTRA_BUILD_OPTIONS"
echo
# Приватный репозиторий брендинга Collabora (git@gitlab.collabora.com) недоступен —
# в build.sh этот клон стоит с `|| echo`, а сам шаг обёрнут в `if test -d`, так что
# он просто пропускается. Обезличиваем мы отдельным слоем поверх образа (Dockerfile.brand).
cd "$SRC"
./build.sh

########################################################################
log "5/5 Готово"
########################################################################
docker image inspect "$IMAGE_BASE:$BASE_TAG" --format 'образ {{.RepoTags}}  размер {{.Size}} байт' \
  || die "build.sh отработал, но образа нет — смотрите вывод выше"
