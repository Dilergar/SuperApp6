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
#
# ПОРЯДОК СЛОЁВ НЕСЛУЧАЕН. POCO собирается десять минут, поэтому он стоит РАНЬШЕ
# основного списка зависимостей: иначе добавление одного забытого пакета выбрасывало
# бы кэш POCO и каждая итерация стоила бы этих десяти минут заново.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# --- Слой 1: минимум, которого хватает POCO ---
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libssl-dev wget ca-certificates tar \
    && rm -rf /var/lib/apt/lists/*

# --- Слой 2: POCO из исходников ---
# Неочевидная, но обязательная часть связки «готовый движок»: POCO собирается ВНУТРИ
# дерева движка (workdir/UnpackedTarball/poco), а готовый ассет содержит только instdir —
# то есть POCO в нём нет. configure это переживает и сам печатает «falling back to
# system POCO», но системный POCO обязан присутствовать, причём не любой: Ubuntu даёт
# 1.11.0, а требуется >= 1.12.0. Пакет libpoco-dev поэтому не годится, и ставить его
# рядом тоже нельзя — смешались бы заголовки 1.11 с библиотеками 1.12.
#
# Версия взята та, с которой Collabora сама собирала POCO: статически, без тестов
# и примеров, -fPIC. 1.13.0 брать нельзя — configure отдельно ловит её как заведомо битую.
#
# А вот список --omit НЕ копируем со старой ветки: там был выброшен Zip, но co-26.04
# использует его в wsd/Unzip.cpp (`Poco/Zip/Decompress.h`), и сборка падает уже на
# компиляции. Предупреждение при этом было раньше — `cannot find -lPocoZip` в config.log,
# — но выглядело безобидно рядом с заведомо опциональными -lpfm и -ldld.
# Поэтому теперь выбрасываем ТОЛЬКО заведомо ненужное и тяжёлое (драйверы БД и прочее),
# а всё, что coolwsd может затребовать, оставляем: дешевле лишние минуты сборки,
# чем ещё один круг диагностики.
ARG POCO_VERSION=1.12.5p2
RUN cd /tmp \
    && wget -q "https://pocoproject.org/releases/poco-${POCO_VERSION}/poco-${POCO_VERSION}-all.tar.gz" \
    && tar -xzf "poco-${POCO_VERSION}-all.tar.gz" \
    && cd "poco-${POCO_VERSION}-all" \
    && ./configure --static --no-tests --no-samples --no-sharedlibs --cflags="-fPIC" \
         --omit=Data,Data/SQLite,Data/ODBC,Data/MySQL,Data/PostgreSQL,MongoDB,Redis,PDF,CppParser,PageCompiler,ActiveRecord \
         --prefix=/usr/local \
    && make -j"$(nproc)" \
    && make install \
    && cd /tmp && rm -rf "poco-${POCO_VERSION}-all" "poco-${POCO_VERSION}-all.tar.gz" \
    && grep -m1 POCO_VERSION /usr/local/include/Poco/Version.h

# --- Слой 3: остальные зависимости ---
# Список сверен с configure.ac: все PKG_CHECK_MODULES (openssl, libpcre2-8, libpng,
# zlib, libzstd>=1.4, cppunit) и все AC_CHECK_HEADERS (security/pam_appl.h,
# sys/capability.h, linux/seccomp.h). Qt6 из того же списка НЕ нужен — он только для
# десктопного приложения.
#
# libexpat1-dev стоит здесь не «на всякий случай». Без него ломается ЛИНКОВКА тестовых
# программ configure (в LIBS попадает -lexpat), а поскольку AC_CHECK_FUNCS проверяет
# функции именно линковкой, разом «пропадают» ppoll, memrchr и pipe2 — все три есть
# в glibc. Дальше HAVE_PIPE2=no заставляет компилировать ветку «для платформ без
# pipe2, вроде macOS», и сборка падает в совершенно другом файле с сообщением
# «'set_fds_cloexec_nonblock' was not declared». Цепочка длинная и очень обманчивая.
#
# lsb-release тоже обязателен, хоть и выглядит лишним: build.sh выбирает Dockerfile
# по выводу `lsb_release -si`.
RUN apt-get update && apt-get install -y --no-install-recommends \
        autoconf automake libtool pkg-config \
        git curl lsb-release \
        bash coreutils findutils zip rsync \
        libpng-dev libzstd-dev libcap-dev libpam0g-dev \
        libcppunit-dev zlib1g-dev libpcre2-dev libexpat1-dev \
        python3 python3-lxml python3-polib \
    && rm -rf /var/lib/apt/lists/*

# --- Слой 4: Node ---
# Не из Ubuntu: в 24.04 приезжает 18.19, а configure.ac проверяет версию явно и
# обрывает сборку — «This node version is old, upgrade to >= 20.0.0». NodeSource 22
# заодно приносит npm 10 (нужен >= 9).
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version && npm --version

# --- Слой 5: клиент docker ---
# Только КЛИЕНТ: демон нам не нужен, финальный `docker build` из build.sh уходит
# в docker-сокет хоста (монтируется при запуске). Пакет docker.io притащил бы ещё
# и containerd — лишние сотни мегабайт ради бинарника, который мы не запускаем.
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
