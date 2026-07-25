# Среда, в которой собирается слой `online` (coolwsd + браузерный клиент).
#
# Почему сборка идёт в контейнере, а не прямо в WSL: upstream build.sh компилирует
# на ХОСТЕ, а потом `COPY /instdir /` в образ `FROM ubuntu:24.04`. Значит среда сборки
# обязана совпадать по релизу дистрибутива с базой образа — иначе бинарники слинкуются
# с чужой glibc. Ровно поэтому upstream и называет свои Dockerfile'ы именами хостовых ОС
# и выбирает нужный через `lsb_release -si`. Сборка внутри ubuntu:24.04 делает совпадение
# истинным по построению и не засоряет машину разработчика.
#
# Движок (LibreOffice) мы НЕ собираем — берём готовый ассет (см. pins.env), поэтому
# здесь нет ни X11-, ни font-заголовков, ни meson/ninja/gperf/nasm: всё это нужно
# только для сборки движка из исходников.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Список build-зависимостей взят не «по памяти», а из Alpine-Dockerfile самого upstream
# (он единственный собирает всё внутри контейнера, поэтому перечисляет их явно) —
# секция «COOL build deps» + базовые инструменты, переведённые в имена пакетов Ubuntu.
#
# lsb-release здесь ОБЯЗАТЕЛЕН, хоть и выглядит лишним: build.sh выбирает Dockerfile
# по выводу `lsb_release -si`, и без пакета он молча свалится в ветку «не могу определить
# дистрибутив» (по счастью тоже Ubuntu, но полагаться на это не будем).
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential autoconf automake libtool pkg-config \
        git wget curl ca-certificates lsb-release \
        bash coreutils findutils tar zip rsync \
        libpng-dev libssl-dev libzstd-dev libcap-dev libpam0g-dev \
        libcppunit-dev zlib1g-dev \
        python3 python3-lxml python3-polib \
        nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# Только КЛИЕНТ docker: сам демон нам не нужен, финальный `docker build` из build.sh
# уходит в docker-сокет хоста (он монтируется при запуске). Пакет docker.io притащил бы
# ещё и containerd — лишние сотни мегабайт ради бинарника, который мы не запускаем.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
         > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

COPY run-build.sh /usr/local/bin/run-build.sh
RUN chmod +x /usr/local/bin/run-build.sh

WORKDIR /build
ENTRYPOINT ["/usr/local/bin/run-build.sh"]
