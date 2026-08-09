# ============================================================
# Верификатор электронной подписи НУЦ РК (движок core/sign).
#
# ОБРАЗ ПРИВАТНЫЙ и наружу не публикуется: внутри SDK KalkanCrypt, чья лицензия
# разрешает использование, но не перераспространение (см. LICENSING.md).
# Тот же приём, что у своей сборки редактора документов.
#
# Собирается скриптом build.ps1 — он проверяет, что SDK и корневые сертификаты
# на месте. Собирать вручную без этих проверок не стоит: получится верификатор,
# который «всё подтверждает», а это хуже отсутствующего.
# ============================================================
ARG NCANODE_REF=master

# ---------- Сборка обвязки ----------
FROM maven:3.9-eclipse-temurin-17 AS builder
ARG NCANODE_REF

WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends git unzip \
    && rm -rf /var/lib/apt/lists/*

# SDK НУЦ кладётся в локальный maven-репозиторий: артефакта в Central нет и быть
# не может — его выдают по заявке организации.
COPY vendor/ /sdk/
RUN set -eux; \
    cd /sdk; \
    for f in *.zip; do [ -e "$f" ] && unzip -o "$f" -d /sdk/unpacked || true; done; \
    find /sdk -name 'kalkan*.jar' -exec cp {} /sdk/ \; || true

RUN git clone --depth 50 https://github.com/malikzh/NCANode.git src \
    && cd src \
    && git checkout "${NCANODE_REF}"

RUN set -eux; \
    cd /sdk; \
    for jar in kalkan*.jar; do \
      [ -e "$jar" ] || continue; \
      mvn -q install:install-file -Dfile="$jar" \
        -DgroupId=kz.gov.pki -DartifactId="$(basename "$jar" .jar)" \
        -Dversion=local -Dpackaging=jar; \
    done

RUN cd /build/src && mvn -q -DskipTests package

# ---------- Рантайм ----------
FROM eclipse-temurin:17-jre
LABEL org.opencontainers.image.title="SuperApp6 sign verifier"
LABEL org.opencontainers.image.description="Приватный образ: NCANode (MIT) + SDK KalkanCrypt НУЦ РК. Не публиковать."

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/src/target/*.jar /app/verifier.jar
# Корневые сертификаты НУЦ — ВСЕ ТРИ семейства алгоритмов (ГОСТ-2004, ГОСТ-2015,
# RSA): старые сертификаты доживают свой срок, и отказ от них означал бы
# «ваш ключ не подходит» у половины страны.
COPY roots/ /app/roots/

ENV NCANODE_PKI_ENV=test
EXPOSE 14579

ENTRYPOINT ["java", "-jar", "/app/verifier.jar", "--server.port=14579"]
