# Движок ключей (`core/keys`)

22-й платформенный движок. ЕДИНСТВЕННАЯ дверь ко всей криптографии платформы: подпись токенов, шифрование секретов и ПДн, слепые индексы, HMAC, ключи API организаций и людей, боты, реестр ключей, журнал. Правило: **секрет, ключ, шифрование или подпись — только через движок**; свой `crypto.createCipher`/`jsonwebtoken`/`JWT_SECRET` в сервисе запрещён линтером (`KEYS_SECRET_SELECTORS` в `apps/api/eslint.config.mjs`). Части: [keys_api_access.md](keys_api_access.md) (ключи API, боты, реестр), [keys_pii.md](keys_pii.md) (ПДн), [webhooks_engine.md](webhooks_engine.md) (исходящие вебхуки, 23-й движок).

## Модель

- **`CryptoKey`** (`scope` · `purpose` · `name`) — логический ключ; **`CryptoKeyVersion`** — версии с состояниями `pending → active → disabled | destroy_scheduled → destroyed`; материал версии хранится ОБЁРНУТЫМ корнем (`wrapped`, AAD = `kid|purpose`), в памяти — кэш 5 мин с эпохой в Redis (`keys:epoch`, микрокэш 1 с) — kill-switch работает на всех инстансах за секунду.
- **Скоупы**: `platform` (KEK платформы, пары подписи, HMAC-ключи), `workspace:<id>` (KEK организации — секреты Процессов, вебхуков, реквизиты), `user:<id>` (KEK человека — ПДн, карты, Google-токены). KEK создаётся лениво при первом шифровании (`ensureKey` под advisory-локом).
- **Назначения** (`purpose`): `kek` (AES-256), `sign` (Ed25519, пара на аудиторию), `mac` (HMAC-SHA256: `verify_otp`, `oauth_state`, `blind_index`, `api_key_pepper`).
- **Корень** (`KeyProvider`): `software` — 32 байта в файле `KEYS_ROOT_KEY_FILE` (dev-дефолт `apps/api/.keys/root.key`, создаётся сам только в development); `pkcs11` — заглушка (`KEYS_PKCS11_*`), интерфейс тот же (`wrap/unwrap/generate/sign/verify`). Отпечаток корня `rootKid` (16 hex) — в каждой обёртке; версия, обёрнутая чужим корнем, роняет бут (fail-closed).

## Артефакты (самоописываемые, с `kid`)

| Префикс | Форма | Где |
|---|---|---|
| `sa6e:1:<kek_kid>:A256GCM:<dek_wrapped>:<iv>:<ct+tag>` | envelope: DEK на запись, обёрнут KEK; **AAD = `entity|field|ownerType|ownerId|kek_kid`** — шифротекст не переставить в чужое поле/строку | `KeysEnvelopeService.encrypt/decrypt/tryDecrypt/rewrap` |
| `sa6b:1:<mac_kid>:<hmac>` | слепой индекс (поиск по равенству без расшифровки; нормализация значения — у колонки) | `blindIndex`, `blindIndexCandidates` (все живые версии) |
| `sa6m:1:<mac_kid>:<hmac>` | HMAC-строка (OTP-коды, state OAuth) | `KeysMacService.tagged/verifyTagged/verifyAny` |
| `sa6_<bot|pat|whs>_<live|test>_<43 base62>_<crc32 6>` | секреты API-ключей и вебхуков (в БД — HMAC-хеш pepper-ключом либо envelope) | [keys_api_access.md](keys_api_access.md) |

Реестр шифрованных колонок — `KeysFieldRegistry.register({table, idColumn, column, scope, scopeColumn, entity, field, blindIndex?, legacyDecrypt?})` из модуля-владельца: по нему работают rewrap при ротации KEK, реиндекс слепых индексов и перешивка legacy-строк (`keys.legacy.reencrypt` на старте). Колонка вне реестра при ротации KEK НЕ перешивается — и через 30 дней после `destroy_scheduled` станет нечитаемой.

## Подпись токенов

- JWS compact, `alg: EdDSA`, `kid` в заголовке, `typ` по аудитории (`at+jwt`, `refresh+jwt`, `platform+jwt`, `wopi+jwt`, …). Allow-list алгоритмов: EdDSA (+ HS256 только на legacy-окне); заголовки `jku/jwk/x5u/x5c/crit` — отказ. Своя реализация на `node:crypto` (`keys.jwt.ts`), без `jose`/`jsonwebtoken`.
- **Аудитории** (`SIGNING_AUDIENCES`): `product` (access/refresh), `platform` (кабинет), `wopi`, `share_link`, `files_url`, `webhook` — у каждой своя пара (урок Storm-0558: один ключ на всё = один инцидент на всё). Токен чужой аудитории отвергается ДО подписи.
- **JWKS**: `GET /.well-known/jwks.json` (вне префикса `/api`, `Cache-Control: max-age=600`) и алиас `/api/v1/keys/jwks`; публикуются `active` + `pending` версии всех аудиторий (OKP/Ed25519, `use: sig`).
- **Ротация без разлогина**: `signing.rotate(audience)` → версия `pending` (уже в JWKS) → джоб `keys.signing.activate` через `signingActivateDelayMin` (кэш JWKS у потребителей успел обновиться) → новая версия подписывает, старая `active` проверяет до `retireAfterSec` (= максимальный TTL токенов аудитории) → `keys.signing.retire` → `destroy_scheduled` → через 30 дней `destroyed`. Плановая ротация — крон раз в день по `signingRotationDays` (90), KEK — по `kekRotationDays` (365, `keys.rewrap` перешивает колонки реестра батчами по 500).
- **Legacy-окно HS256** (`JWT_SECRET_LEGACY`/`JWT_SECRET` + `KEYS_LEGACY_HS256_UNTIL`): старые токены и производные HMAC читаются до даты; в production окно обязано быть датированным и не истёкшим (страж env), после даты секрет удаляется из окружения. Прочие потребители `JWT_SECRET` (docs, share-links, files-url, platform, verify, google state, кредсы Процессов, карты) переведены на движок.

## Заморозка и уничтожение

- `freezeScope(scope)` → все версии `disabled` → любое чтение/запись данных скоупа = `403 keys.key_unavailable` (организация под расследованием, аккаунт в споре); `unfreezeScope` возвращает. Команды кабинета `keys.workspace.freeze|unfreeze` (critical, dualControl).
- `scheduleScopeDestroy(scope)` при purge организации и анонимизации аккаунта: через `destroyDelayDays` (30) материал стирается — crypto-shredding зашифрованных данных без обхода таблиц.
- Ротация корня — `keys.root.rotate` (critical, dualControl, dryRun): новый файл кладётся церемонией заранее (две офлайн-копии у двух людей, отпечаток SHA-256 — в кабинете), команда перешивает ВСЕ версии, старый файл уничтожается после подтверждения, инстансы перезапускаются с новым `KEYS_ROOT_KEY_FILE`. Учение восстановления — `keys-verify-root.cjs` копией файла (обязательно перед прод-запуском и раз в квартал).

## Журнал и наблюдаемость

- `key_audit_entries` — append-only (триггеры `immutable`/`no_truncate` в миграции `keys_engine`): актор (`user|bot|system|platform`), действие, предмет, причина, IP, детали без материала и секретов. Лента организации — `GET /workspaces/:id/keys/journal` (вкладка «Журнал» раздела «Интеграции и ключи», фильтр по предмету); события движка (ротации, заморозки, rewrap) пишутся без организации либо с ней. Объём мал, живёт вечно.
- Журналы объёма — `api_access_log` (обращения ключами, 90 дней) и `pii_access_log` (чтения ПДн, 365 дней) — **месячные партиции** (миграция `keys_journal_partitions`, руками; составной PK `(id, <ts>)` зеркалом в схеме): `shared/database/monthly-partitions.ts` заводит партиции на три месяца вперёд на буте и кроном, ретеншн — `DETACH … CONCURRENTLY` + `DROP` партиции целиком, не `DELETE` строк; вставка в месяц без партиции заводит её и повторяется один раз.
- **Метрики Prometheus** (`shared/metrics`, `GET /metrics` у корня хоста; гейт `METRICS_TOKEN` — Bearer в константное время, в production без токена маршрут отвечает 404, в development открыт): `keys_unwrap_total{purpose}` (распаковки корнем), `keys_cache_hit_total{result}` (кэш версий), `keys_decrypt_latency_seconds{result}` (гистограмма расшифровки поля), `keys_api_auth_total{result}` (исходы аутентификации ключом: `ok`, `invalid`, `revoked`, `expired`, `frozen`, `ip_denied`, `rate_limited`), `keys_root_present` (корень загружен), `webhooks_delivery_ok_total`/`webhooks_delivery_fail_total{outcome}`; плюс стандартные `sa6_process_*`/`sa6_nodejs_*`. Метки — только коды, ни id, ни ПДн. Отсутствие корня на старте — строка лога `event=keys.root.missing provider=… code=…` (алерт по логам) и отказ бута.
- **Бэкапы и crypto-shredding (правило ops)**: бэкап БД содержит только ОБЁРНУТЫЕ версии ключей, поэтому уничтожение версии в keystore (`destroyed`, материал = NULL) делает данные нечитаемыми и в бэкапах — при условии, что бэкап keystore (таблицы `crypto_keys`/`crypto_key_versions`) подчиняется тому же ретеншну, что и `destroy_scheduled` (30 дней): снимок старше 30 дней с живой версией ключа воскресил бы стёртое. Файл корня в бэкап БД не входит никогда — только офлайн-копии церемонии.

## Дев-полигон и сьюты

`/keys/dev/*` (только development/test): `status`, `signing/rotate|activate|retire|sign`, `kek/rotate`, `scope/freeze|unfreeze`, `roundtrip` (envelope + AAD + mac + blind index), `legacy/reencrypt`, `pii/status|mode|backfill`, `usage/flush|daily|throttle|partitions` (`throttle` — посев корзины минуты / суточного счётчика выгрузки ключа для учения 429; `partitions` — партиции журналов вперёд и сброс по ретеншну), `webhooks/probe|daily`. Сьюты: `verify-keys.cjs` (секции A–E: keystore, JWKS, ротации, заморозка, учение корня, журнал append-only, потребители подписи, envelope-потребители, ключи API и боты), `verify-keys-pii.cjs`, `verify-webhooks.cjs`; скрипты `keys-init-root.cjs` (церемония) и `keys-verify-root.cjs` (учение).

## Ловушки

- **Prisma `Bytes`** принимает только `Uint8Array` — `Buffer` из `node:crypto` заворачивать `Uint8Array.from`.
- **AAD привязан к `ownerType|ownerId`**: перенос строки в другую организацию = перешифрование (`rewrap` с новым контекстом), иначе `decrypt` даст `format`/`auth` ошибку.
- **`disabled` ≠ «старая версия»**: заморозка — состояние kill-switch; ротация оставляет старую версию `active` до retire, иначе токены и шифротексты умирают раньше срока.
- **Кэш KEK 5 мин**: заморозка доходит через эпоху Redis (микрокэш 1 с); при недоступном Redis инстанс живёт на своём кэше до TTL.
- Все `keys.*` env — [environment_variables.md](environment_variables.md); секреты в логах и конвертах ошибок гасит `redactSecrets` (`shared/utils/redact.ts`).

## Связанные доки

[keys_api_access.md](keys_api_access.md) · [keys_pii.md](keys_pii.md) · [webhooks_engine.md](webhooks_engine.md) · [security.md](security.md) · [verify_engine.md](verify_engine.md) · [platform_console.md](platform_console.md) · [module_graph.md](module_graph.md)
