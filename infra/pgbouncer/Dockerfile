# ============================================================
# PgBouncer 1.26.0 — сборка из исходников с пином контрольной суммы (docs/data_architecture.md)
# ============================================================
# Версия ≥ 1.26.0 закрывает CVE-2026-19888 / CVE-2026-6668 / CVE-2026-6669. Сторонние образы
# пулера не берём: цепочка поставки — архив проекта + sha256, собранный здесь же.
#   docker compose build pgbouncer
FROM alpine:3.22 AS build
ARG PGBOUNCER_VERSION=1.26.0
ARG PGBOUNCER_SHA256=afd25dd61ee6775d37b40629b87ce08736b3e6955f3057bb212e410fbf21c71d
RUN apk add --no-cache build-base pkgconf libevent-dev openssl-dev c-ares-dev curl
WORKDIR /src
RUN curl -fsSL -o pgbouncer.tar.gz "https://www.pgbouncer.org/downloads/files/${PGBOUNCER_VERSION}/pgbouncer-${PGBOUNCER_VERSION}.tar.gz" \
 && echo "${PGBOUNCER_SHA256}  pgbouncer.tar.gz" | sha256sum -c - \
 && tar xzf pgbouncer.tar.gz --strip-components=1 \
 && ./configure --prefix=/usr/local --with-cares --with-openssl --without-systemd \
 && make -j"$(nproc)" pgbouncer \
 && install -D -m 0755 pgbouncer /usr/local/bin/pgbouncer

FROM alpine:3.22
RUN apk add --no-cache libevent openssl c-ares \
 && addgroup -S pgbouncer && adduser -S -G pgbouncer -H -s /sbin/nologin pgbouncer \
 && mkdir -p /etc/pgbouncer /var/run/pgbouncer \
 && chown pgbouncer:pgbouncer /var/run/pgbouncer
COPY --from=build /usr/local/bin/pgbouncer /usr/local/bin/pgbouncer
USER pgbouncer
EXPOSE 6432
# Порт слушается — пулер жив (без клиента PostgreSQL в образе: меньше поверхности)
HEALTHCHECK --interval=5s --timeout=3s --retries=5 CMD nc -z 127.0.0.1 6432 || exit 1
ENTRYPOINT ["/usr/local/bin/pgbouncer"]
CMD ["/etc/pgbouncer/pgbouncer.ini"]
