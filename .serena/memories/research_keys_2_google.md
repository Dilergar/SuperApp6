# Бенчмарк GOOGLE (Cloud KMS + Workspace + consumer) для движка `core/keys` SuperApp6

> **Примечание о размещении файла.** Задание просило записать отчёт в
> `C:/Users/SANZHA~1/AppData/Local/Temp/claude/.../scratchpad/research/02-google.md`.
> Сессия работает в режиме плана (plan mode), где единственный разрешённый для записи файл —
> этот. Отчёт полностью здесь; при выходе из plan mode его можно скопировать по нужному пути
> одной командой.
>
> **Маркировка достоверности.** `[official]` — проверено по первоисточнику Google (cloud.google.com /
> developers.google.com / support.google.com / *.googleblog.com). `[secondary]` — независимый
> источник или агрегатор, первоисточник не подтвердил дословно. `[inference]` — мой вывод, не факт.
> Даты и числа без пометки взяты из `[official]`-страниц, перечисленных в §7.

---

## 1. Executive summary (15 пунктов)

1. **Иерархия KMS у Google — четырёхуровневая и НЕизменяемая по ключевым свойствам:**
   `project → location → keyRing → cryptoKey → cryptoKeyVersion`. Key ring **нельзя удалить никогда**,
   имена удалённых ключей нельзя переиспользовать, protection level и purpose нельзя поменять после
   создания. Это сознательный выбор: ключ — «вечный» идентификатор, а ротируется только **версия**.
2. **Ротация = новая primary-версия, а не перешифрование.** Старые версии остаются `ENABLED` и
   продолжают расшифровывать. Автоматическая ротация есть только у симметричных ключей; у
   асимметричных её нет принципиально (нужно раздать новый публичный ключ). Данные НЕ
   перешифровываются сами.
3. **Уничтожение ключевой версии — с задержкой 30 дней по умолчанию** (раньше было 24 часа,
   изменено с 1 февраля 2024 `[secondary]`), настраивается только при создании ключа,
   org-policy `constraints/cloudkms.minimumDestroyScheduledDuration` (7d/15d/30d/60d/90d/120d) и
   `constraints/cloudkms.disableBeforeDestroy`. Материал может жить в системах Google **до 45 суток**
   после запланированного времени уничтожения.
4. **Envelope encryption — обязательная модель, а не оптимизация.** KMS физически не примет
   plaintext > **64 KiB**. DEK генерируется на каждую запись (AES-256-GCM), KEK живёт в KMS,
   один KEK покрывает миллионы DEK. AAD (≤ 64 KiB) **не хранится в шифротексте** и **не
   логируется** — это защита от confused deputy: перенёс шифротекст в другую строку → не
   расшифруешь.
5. **Разделение полномочий зашито в роли:** `roles/cloudkms.admin` **не даёт** права
   шифровать/расшифровывать; отдельно `cryptoKeyEncrypter`, `cryptoKeyDecrypter`,
   `cryptoKeyEncrypterDecrypter`, `signer`, `signerVerifier`, `publicKeyViewer`, `importer`.
   Security Command Center отдельным детектором ловит «KMS Role Separation» — принципала, у
   которого есть и админка, и крипто-право на одном ключе.
6. **Использование ключа логируется как Data Access, а не Admin Activity** — то есть по умолчанию
   ВЫКЛЮЧЕНО. Это главная ловушка: админ-операции видны всегда, а «кто и что расшифровал» — только
   если включили явно.
7. **Tink — эталон клиентской стороны:** не «ключ», а **keyset** (список ключей, один primary),
   32-битный key id, 5-байтовый префикс шифротекста `0x01 + big-endian key id`. Префикс **не
   аутентифицирован**, это лишь подсказка для ускорения. Ротация: добавить ключ → раскатать
   на все бинарники → только потом сделать primary. Cleartext keyset — явный анти-паттерн,
   keyset положено шифровать KMS-ключом.
8. **Secret Manager НЕ ротирует секреты.** Он только шлёт `SECRET_ROTATE` в Pub/Sub по расписанию
   (период ≥ 1 час). Рабочий паттерн — две живые версии + «pin to version number, not `latest`» +
   «disable, подожди неделю, потом destroy».
9. **Service account keys — главный анти-паттерн Google по его же словам.** «Avoid whenever
   possible», до 10 ключей на SA, по умолчанию **не истекают**; с 3 мая 2024 запрет их создания
   включён по умолчанию для новых организаций; с 16 июня 2024 утёкшие в публичные репозитории
   ключи **автоматически отключаются** (партнёрство с секрет-сканерами GitHub/GitLab).
   Замена — Workload Identity Federation + импersonation (токен 1 ч, максимум 12 ч по org-policy).
10. **API-ключи у Google принципиально НЕ несут личность.** «A standard API key doesn't authenticate
    a principal» — только проект для биллинга и квот. Строку нельзя посмотреть после создания,
    удалённый ключ восстанавливается 30 дней, ключ без restrictions официально назван «insecure».
11. **Client secret теперь хэшируется и показывается один раз** (с июня 2025 для новых клиентов,
    с ноября 2025 — для существующих); показываются последние 4 символа; **максимум 2 секрета**
    на клиент — ровно для бесшовной ротации; неиспользуемые 6 месяцев OAuth-клиенты **удаляются
    автоматически** (уведомление за 30 дней, восстановление 30 дней).
12. **Refresh token у Google — не вечный и жёстко лимитирован:** 100 refresh-токенов на
    Google-аккаунт на один client_id, при превышении **самый старый молча инвалидируется**;
    7 дней жизни для приложений в статусе Testing; 6 месяцев неиспользования; смена пароля
    убивает токены с Gmail-скоупами.
13. **Исходящие вебхуки Google подписывает НЕ HMAC-секретом, а асимметричным OIDC/JWT** с
    привязкой к `audience` (URL эндпоинта или номер проекта) и проверяемым по публичному JWKS.
    Pub/Sub push и Google Chat работают именно так. Это снимает проблему «secret rotation» с
    вебхуков целиком.
14. **AI-агенты уже получили first-class identity:** Agent Identity на базе **SPIFFE**,
    X.509-сертификат **на 24 часа** с автопродлением, long-lived ключи запрещены, агента
    **нельзя импersonate**, идентичность не разделяется между воркладами; отдельный
    «auth manager» хранит API-ключи / OAuth client secret / делегированные end-user токены.
15. **Собственная инфраструктура Google — это пятиуровневая обёртка ключей:**
    DEK → KEK (в Cloud KMS) → KMS master key (на локацию) → Keystore master key → root keystore
    master key; всё симметричное, материал ключей шифруется и at rest, и in transit, метаданные
    защищены HMAC, ежечасный джоб проверяет, что HMAC валидны и ключи реально расшифровывают.

---

## 2. Находки по граням

### 2.1 Cloud KMS: ресурсная модель

**Иерархия и resource ID** `[official]`

```
projects/PROJECT_ID/locations/LOCATION/keyRings/KEY_RING
projects/PROJECT_ID/locations/LOCATION/keyRings/KEY_RING/cryptoKeys/KEY_NAME
projects/PROJECT_ID/locations/LOCATION/keyRings/KEY_RING/cryptoKeys/KEY_NAME/cryptoKeyVersions/N
projects/PROJECT_ID/locations/LOCATION/ekmConnections/EKM_CONNECTION
projects/RESOURCE_PROJECT_ID/locations/LOCATION/keyHandles/KEY_HANDLE
```

- Key ring живёт в конкретной локации; имя уникально **в пределах локации**, не проекта.
- **Key ring нельзя удалить после создания.** Имена удалённых ключей нельзя переиспользовать.
- Версия ключа — целое число, растёт монотонно; в resource ID видна и локация, и key ring —
  то есть **ID самодостаточен**, по нему всегда можно понять, где расшифровывать.

**Key purposes и алгоритмы** `[official]`

| Purpose | Алгоритмы (enum) |
|---|---|
| `ENCRYPT_DECRYPT` | `GOOGLE_SYMMETRIC_ENCRYPTION` (AES-256-GCM) — дефолт |
| `RAW_ENCRYPT_DECRYPT` | `GOOGLE_SYMMETRIC_ENCRYPTION` через `rawEncrypt`/`rawDecrypt` |
| `ASYMMETRIC_SIGN` | `EC_SIGN_ED25519`, `EC_SIGN_P256_SHA256` (рекоменд.), `EC_SIGN_P384_SHA384`, `EC_SIGN_SECP256K1_SHA256`; `RSA_SIGN_PSS_{2048,3072,4096}_SHA*` (3072 рекоменд.); `RSA_SIGN_PKCS1_*`; `RSA_SIGN_RAW_PKCS1_*`; PQC: `PQ_SIGN_ML_DSA_{44,65,87}`, `PQ_SIGN_SLH_DSA_SHA2_128S` |
| `ASYMMETRIC_DECRYPT` | `RSA_DECRYPT_OAEP_{2048,3072,4096}_SHA{1,256,512}` (3072-SHA256 рекоменд.) |
| `MAC` | `HMAC_SHA{1,224,256,384,512}` (SHA256 рекоменд.) |
| `KEY_ENCAPSULATION` | `ML_KEM_768`, `ML_KEM_1024`, `KEM_XWING` (гибрид ML-KEM-768 + X25519, рекоменд.) |

Protection level и purpose **нельзя изменить после создания ключа**.

**Protection levels** `[official]`

| Уровень | Enum | Сертификация | Цена/версия/мес |
|---|---|---|---|
| Software | `SOFTWARE` | FIPS 140-3 Level 1 | $0.06 |
| Multi-tenant HSM | `HSM` | FIPS 140-2 Level 3 | $1.00–$2.50 |
| Single-tenant HSM | `HSM_SINGLE_TENANT` | FIPS 140-2 Level 3 | — |
| External (Cloud EKM) | `EXTERNAL` | ключ у партнёра, «never sent to Google» | $3.00 |
| External via VPC | `EXTERNAL_VPC` | то же, трафик через VPC | — |

**Состояния версии ключа** `[official]`

`PENDING_GENERATION` → `ENABLED` ⇄ `DISABLED` → `DESTROY_SCHEDULED` → `DESTROYED`;
плюс `PENDING_IMPORT` → `ENABLED` и `IMPORT_FAILED`.
Восстановление из `DESTROY_SCHEDULED` возвращает версию в **`DISABLED`**, а не в `ENABLED` —
то есть требуется явный второй шаг «включить». Это правильная защита от «отменил уничтожение и
случайно снова стал шифровать».

**Уничтожение** `[official] + [secondary]`
- Дефолт `destroyScheduledDuration` = **30 суток** `[official: destroy-restore]`.
  Изменён с 24 часов на 30 суток 1 февраля 2024 `[secondary]`.
- Минимум 24 часа (для import-only ключей — 0), максимум 120 суток `[secondary]`;
  задаётся **только при создании ключа** и распространяется на все будущие версии `[secondary]`.
- Org-policy `constraints/cloudkms.minimumDestroyScheduledDuration` — допустимые значения
  `7d`, `15d`, `30d`, `60d`, `90d`, `120d` `[official]`.
- Org-policy `constraints/cloudkms.disableBeforeDestroy` — нельзя планировать уничтожение, пока
  ключ не отключён `[official]`.
- После истечения: «Key material can remain in Google systems for **up to 45 days** from the
  scheduled destruction time» `[official]`. То есть «уничтожено» ≠ «стёрто немедленно».

**Ротация** `[official]`
- Автоматическая: `rotation_period` + `next_rotation_time`. Консоль при создании сама
  проставляет значения.
- Рекомендация в доке — регулярное расписание, пример «каждые 90 дней»; дефолтного периода
  в доке не названо. Криптопериод для GCM Google советует считать по **числу зашифрованных
  сообщений** (ссылка на NIST SP 800-38D), а не только по времени.
- Для CMEK отдельная рекомендация: «минимум раз в год для ряда комплаенс-стандартов, чаще —
  для чувствительных нагрузок».
- **Ротация не перешифровывает данные и не отключает старые версии.** Старые версии продолжают
  стоить денег, пока не уничтожены.
- Асимметричные ключи: **автоматической ротации нет** — нужен цикл раздачи публичного ключа.
- При подозрении на компрометацию: «disable it and revoke access **as soon as possible**» —
  то есть штатный ответ на инцидент = `DISABLED`, а не `DESTROYED`.

**Envelope encryption и AAD** `[official]`
- Максимальный вход для `Encrypt`/`Decrypt` — **64 KiB**. Это архитектурное принуждение к
  envelope-схеме.
- Рекомендованный DEK — AES-256-GCM; «generate a new DEK every time you write the data» ⇒
  DEK не ротируется вообще, ротируется только KEK.
- «Do NOT store a plaintext DEK»; «store the DEK near the data that it encrypts».
- **AAD**: ≤ 64 KiB, **не хранится в шифротексте**, **не пишется в Cloud Audit Logs**; при
  расшифровке нужен ровно тот же AAD; пустой AAD ≡ пустая строка. Google прямо называет цель —
  защита от confused deputy. Примеры из доки: идентификатор пользователя (email/username),
  путь и имя файла, части bearer-токена.

**IAM** `[official]`

| Роль | Что даёт |
|---|---|
| `roles/cloudkms.admin` | управление ресурсами KMS, **без** encrypt/decrypt |
| `roles/cloudkms.cryptoKeyEncrypter` | `cryptoKeyVersions.useToEncrypt` |
| `roles/cloudkms.cryptoKeyDecrypter` | `cryptoKeyVersions.useToDecrypt` |
| `roles/cloudkms.cryptoKeyEncrypterDecrypter` | обе |
| `roles/cloudkms.signer` | `useToSign` |
| `roles/cloudkms.signerVerifier` | Sign, Verify, GetPublicKey |
| `roles/cloudkms.publicKeyViewer` | `viewPublicKey` |
| `roles/cloudkms.viewer` | Get/List |
| `roles/cloudkms.importer` | `ImportCryptoKeyVersion`, `CreateImportJob` |
| `roles/cloudkms.expertRawPKCS1` | `manageRawPKCS1Keys` |

Минимальный уровень выдачи почти всех — **CryptoKey** (не key ring, не проект).
Рекомендации по разделению обязанностей `[official]`:
- ключи — в **отдельном проекте** от данных;
- для CMEK «service account should be the **only** principal authorized to use the key»;
- избегать basic-ролей (owner/editor);
- SCC-детектор **KMS Role Separation**.

**Key Access Justifications (KAJ)** `[official]` — политика на ключе, которая разрешает/запрещает
доступ по коду причины. Коды:
`CUSTOMER_INITIATED_ACCESS`, `CUSTOMER_INITIATED_SUPPORT`, `CUSTOMER_AUTHORIZED_WORKFLOW_SERVICING`,
`GOOGLE_INITIATED_SYSTEM_OPERATION`, `GOOGLE_INITIATED_SERVICE`, `GOOGLE_INITIATED_REVIEW`,
`GOOGLE_RESPONSE_TO_PRODUCTION_ALERT`, `THIRD_PARTY_DATA_REQUEST`, `REASON_NOT_EXPECTED`,
`REASON_UNSPECIFIED`.
Если запретить всё — ключ становится непригоден: `CUSTOMER_INITIATED_ACCESS` и
`GOOGLE_INITIATED_SYSTEM_OPERATION` необходимы для нормальной работы `[secondary]`;
дока явно советует не запрещать `CUSTOMER_AUTHORIZED_WORKFLOW_SERVICING` `[official]`.
**Идея для нас:** у каждого обращения к ключу есть машинно-читаемая «причина», и политика может
её фильтровать. Это сильнее, чем просто «кто».

**Аудит** `[official]`
- Admin Activity (`CreateCryptoKey`, `UpdateCryptoKey`, `SetIamPolicy`) — всегда включён,
  бесплатен.
- Data Access — **надо включать явно**; сюда попадают `Encrypt`, `Decrypt`, `RawEncrypt`,
  `RawDecrypt`, `AsymmetricSign`, `AsymmetricDecrypt`, `MacSign`, `MacVerify` (тип разрешения
  `DATA_READ`).
- Фильтр: `protoPayload.serviceName="cloudkms.googleapis.com"`.
- AAD в логи не попадает.

**Квоты и латентность** `[official] + [secondary]`
- Актуальная (после 16.02.2026) токен-модель, **per region**:
  software — 6 000 000 TPM (soft), HSM — 3 000 000 TPM (soft), EKM — 10 000 TPS (**hard**);
  management read 600 TPM, write 100 TPM. Разные операции стоят разное число токенов
  (симметричное шифрование — 100; asymmetric sign RSA-4096 на HSM — 14 000).
- Историческая модель: «Cryptographic requests» подняли с 600 QPM до 60 000 QPM `[secondary]`.
- Отдельные квоты на HSM и EKM **суммируются** с общей и списываются с проекта, где лежит ключ.
- Явного текста «кэшируйте DEK ради квоты» на страницах envelope-encryption/quotas я не нашёл —
  но арифметика очевидна: 64 KiB лимит + региональная квота ⇒ один вызов KMS на объект,
  а не на запрос. `[inference]`

**Импорт ключей** `[official]`
- `ImportJob` задаёт неизменяемые свойства импортируемых ключей; **истекает через 3 дня**.
- Методы обёртки: `rsa-oaep-3072-sha1-aes-256`, `rsa-oaep-4096-sha1-aes-256`,
  `rsa-oaep-3072-sha256-aes-256`, `rsa-oaep-4096-sha256-aes-256`, `rsa-oaep-3072-sha256`,
  `rsa-oaep-4096-sha256`.
- Приватные ключи — PKCS#8 DER.
- «Import-only» ключи: KMS не может сам сгенерировать новую версию — защита от «случайно
  отротировали и потеряли внешний материал».

**Autokey** `[official]` — автогенерация CMEK по запросу ресурса: key handle → KMS сам создаёт
key ring `autokey`, ключ нужной гранулярности, сервисный агент и IAM-гранты.
Дефолты Autokey: protection level **HSM**, алгоритм **AES-256 GCM**, период ротации **1 год**.
Разделение обязанностей сохраняется: KMS-админ видит ключи, но не может ими шифровать;
разработчик может только попросить ключ.

**CMEK best practices** `[official]`
- Гранулярность: один ключ = одна локация + один продукт + один проект.
- Централизованный key-project на каждую среду (folder), НЕ в проекте с данными.
- Ключ и ресурс должны быть в одной локации (или `global`).
- Отслеживать использование через Cloud KMS Inventory API; ставить алерты на «schedule for
  destruction».
- Отключение/уничтожение ключа делает данные недоступными — то есть **kill switch реален**.

**Cloud EKM** `[official]`
- Партнёры: Fortanix, Futurex, Thales. Два режима: через интернет и через VPC.
- Версия ключа содержит **key URI или key path**, материал остаётся снаружи, «never sent to Google».
- Если внешний KMS недоступен — `FAILED_PRECONDITION`.
- **Жёсткая ловушка:** если CMEK-ключ недоступен > 30 суток подряд, Spanner **автоматически
  удаляет базу**. Это иллюстрация того, что «внешний ключ» переносит риск доступности в
  риск потери данных.

**Key usage tracking** `[official]` — KMS Inventory API показывает, какие ресурсы защищены ключом
(роль `Cloud KMS Viewer` для сводки, `Cloud KMS Protected Resources Viewer` для деталей).
Важная оговорка Google: данные «for informational purposes only», задерживаются, покрывают
только CMEK (не прикладные ключи) — **нельзя принимать решение об уничтожении версии, опираясь
только на них**.

**Org-policy для KMS** `[official]`
- `constraints/cloudkms.allowedProtectionLevels` — какие protection levels можно создавать.
- `constraints/gcp.resourceLocations` — где можно создавать key ring/ключи/версии.
  Ловушка: существующие ключи работают, но **автоматическая ротация упадёт**, если новая
  версия нарушит ограничение.
- Плюс упомянутые выше `minimumDestroyScheduledDuration` и `disableBeforeDestroy`.

---

### 2.2 Tink — эталон прикладного слоя над KMS

`[official]`

- **Keyset**, а не ключ: непустой список ключей, ровно один **primary**. Шифрует/подписывает
  primary; расшифровывает — тот, чей id совпал с префиксом.
- **Key id — 32-битный**, уникален внутри keyset. Wire format: **1 байт версии `0x01` + 4 байта
  big-endian key id** = 5-байтовый префикс. Legacy-ключи могут иметь версию `0x00`.
  Прямая цитата из доки: префикс **«is not authenticated and cannot be relied on for security
  purposes… Tink uses it as a hint to speed up decryption or verification»**.
  (Существование отдельных output prefix types `RAW`/`CRUNCHY`/`LEGACY` — `[secondary]`,
  на официальной wire-format странице названы только `0x01` и `0x00`.)
- **Процедура ротации (4 шага, и порядок несущий):**
  1. добавить новый ключ в keyset, **не делая его primary**;
  2. раскатать новый keyset на ВСЕ бинарники (чтобы каждый умел расшифровывать новым);
  3. только теперь сделать новый ключ primary;
  4. снова раскатать.
  Обоснование Google: «there is almost never an atomic switch to the next key» в распределённой
  системе. Старые ключи не удаляются, пока живы старые шифротексты.
- Статус ключа в keyset позволяет **отключать ключ, не удаляя его**.
- `KeysetHandle` — абстракция, ограничивающая контакт кода с сырым материалом.
- Примитивы: AEAD, Deterministic AEAD, MAC, Digital Signature, Hybrid Encryption, Streaming AEAD.
- **Cleartext keyset** — прямо помеченный анти-паттерн: «Reading or writing cleartext keysets is
  a bad practice, usage of this API should be restricted». Штатный путь — keyset, зашифрованный
  master-ключом из Cloud KMS / AWS KMS / HashiCorp Vault `[official + secondary]`.
- Tink + KMS: Tink сам генерирует DEK, шифрует данные, оборачивает DEK и возвращает **единый
  шифротекст = wrapped DEK + данные** (`KmsEnvelopeAead`).

---

### 2.3 Secret Manager

`[official]`

- Модель: `secret` (глобальный/региональный ресурс с метаданными) → `secret version`
  (собственно байты). Состояния: ENABLED / DISABLED / DESTROYED. Алиас `latest` + до **50
  пользовательских алиасов** на секрет.
- Репликация: **automatic** (Google выбирает регионы, платишь за одну локацию) или
  **user-managed** (сам перечисляешь регионы, платишь за каждую). Есть отдельные **regional
  secrets** — это и есть механизм data residency.
- **Максимальный payload — 64 KiB.**
- Квоты: access — 90 000/мин/проект (hard); read — 600/мин; write — 600/мин.
  `AddSecretVersion`/`UpdateSecret` — 2 QPS на секрет (global), 80 QPS (regional);
  Enable/Disable/Destroy — 1 QPS на версию (global), 50 QPS (regional).
- **Ротация: Secret Manager сам НИЧЕГО не ротирует.** Он публикует `SECRET_ROTATE` в Pub/Sub в
  момент `next_rotation_time`. `rotation_period` ≥ 1 час; `next_rotation_time` ≥ 5 минут в
  будущем; недоставленные сообщения ретраятся до 7 суток; параллельные ротации запрещены —
  «in-flight rotations must complete before another rotation can be started».
- Best practices (дословно по смыслу):
  - **не использовать `latest`**, а пинить номер версии — иначе плохая новая версия мгновенно
    ломает продакшн и её нельзя откатить штатным релизным процессом;
  - **disable → подождать неделю → destroy**, чтобы поймать «залипшие» зависимости;
  - «delay secret version destroy» (`version_destroy_ttl`): по умолчанию destroy **немедленный и
    необратимый**, а с включённой задержкой версия сначала переводится в disabled и планируется
    к уничтожению, и её можно восстановить.
- CMEK для секретов: ключ **в той же локации**, что реплика; сервисный агент
  `service-PROJECT_NUMBER@gcp-sa-secretmanager.iam.gserviceaccount.com` должен иметь
  `roles/cloudkms.cryptoKeyEncrypterDecrypter`; используется **primary-версия** ключа (нельзя
  прибить к конкретной версии); при ротации ключа **старые версии секрета не перешифровываются**;
  уничтожил ключ — потерял секреты.

---

### 2.4 Service accounts: ключи, федерация, импersonation

**User-managed keys** `[official]`
- До **10 ключей** на service account. Форматы JSON и PKCS#12 (P12); P12 не рекомендован.
- **По умолчанию ключи не истекают вообще.**
- Позиция Google дословно: «We recommend that you avoid using service account keys whenever
  possible»; ключ — bearer-токен, «there is no reliable way to tell who used the key»
  (проблема **неотказуемости**, не только утечки).
- **Удаление ключа НЕ отзывает уже выданные короткоживущие токены.** Чтобы реально закрыть
  доступ, надо отключить/удалить сам service account. Это отдельная и очень важная ловушка.

**Org policies** `[official]`
- `constraints/iam.disableServiceAccountKeyCreation`
- `constraints/iam.disableServiceAccountKeyUpload`
- Для организаций, созданных **с 3 мая 2024**, обе включены **по умолчанию**.
- `constraints/iam.serviceAccountKeyExpiryHours` — список допустимых значений:
  **8h, 24h, 168h, 336h, 720h, 1440h, 2160h** (до 90 суток). Применяется только к **новым**
  ключам; существующие не затрагиваются. Рекомендация Google — начинать с 8 часов.
- `constraints/iam.serviceAccountKeyExposureResponse` — реакция на обнаруженную утечку:
  `DISABLE_KEY` (по умолчанию с 16.06.2024) или `WAIT_FOR_ABUSE` (opt-out).

**Автоотключение утёкших ключей** `[official, блог Google Cloud]`
- С **16 июня 2024** включено по умолчанию для новых и существующих клиентов.
- Партнёры-сканеры: **GitHub Secret Scanning**, **GitLab Secret Detection**.
- Действия: ключ отключается, владельцам проекта и security contacts уходит уведомление.
- Google **не гарантирует** обнаружение — это дополнительный слой, не замена гигиене.

**Ротация ключей** `[official]`
- Рекомендованный период — **не реже 90 дней**; немедленно при подозрении.
- Процедура из 5 шагов: найти → создать новый → раскатить → **отключить старый и понаблюдать** →
  удалить.
- Поиск старых ключей — через Cloud Asset Inventory:
  `gcloud asset search-all-resources --query="createTime < DATE" --asset-types="iam.googleapis.com/ServiceAccountKey"`.
- **Предупреждение Google:** не полагаться на истечение ключей как на механизм ротации —
  «expiring keys can cause outages if they aren't rotated properly».

**Workload Identity Federation** `[official]`
- Провайдеры: AWS, Azure, on-prem AD, GitHub, GitLab, Okta, Terraform, Kubernetes, любой
  OIDC/SAML 2.0, X.509-клиентские сертификаты.
- Ресурсы: **workload identity pool** (рекомендуется отдельный пул на каждую внешнюю среду) →
  **provider** (маппинг атрибутов + условия).
- Attribute mapping на CEL: `google.subject` (обязателен, ≤ 127 символов), `google.groups`,
  до **50** `attribute.NAME`.
- **Attribute conditions** — CEL-фильтр: true → пускаем, иначе отвергаем.
  Предупреждение доки: давать доступ «всему пулу» рискованно, ограничивайте атрибутами.
- Два режима: direct resource access (внешняя личность прямо в IAM) или импersonation
  service account через `roles/iam.workloadIdentityUser`.
- Основа — стандарт **OAuth 2.0 Token Exchange**.

**Короткоживущие креденшелы** `[official]`
- `generateAccessToken`: дефолт-максимум **1 час (3600 с)**; до **12 часов (43 200 с)** только
  если SA внесён в org-policy `constraints/iam.allowServiceAccountCredentialLifetimeExtension`.
- ID-токен (`generateIdToken`): фиксированно **1 час**, продлить нельзя.
- Роли: `roles/iam.serviceAccountTokenCreator` (access token, signJwt/signBlob),
  `roles/iam.serviceAccountOpenIdTokenCreator` (ID token).
- Отзыв выданного короткоживущего токена до истечения в доке не описан ⇒ **их нельзя отозвать**,
  окно жизни = окно риска. `[inference из отсутствия механизма + прямого предупреждения про
  удаление ключа]`

**Activity Analyzer (Policy Intelligence)** `[official]`
- `serviceAccountLastAuthentication` и **`serviceAccountKeyLastAuthentication`** — «когда этот
  конкретный ключ последний раз использовался». До 10 ключей за запрос.
- Timestamp всегда с временем `T07:00:00Z` — **гранулярность суточная**, не поминутная.
- Прямая рекомендация: отключать/удалять неиспользуемые SA и ключи, т.к. они «create an
  unnecessary security risk».

---

### 2.5 API keys (Cloud)

`[official]`

- **Не идентифицируют принципала**: «A standard API key doesn't authenticate a principal» —
  только проект для биллинга/квот, IAM-проверок по нему нет.
- Пример строки в доке Google: `AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe` — префикс `AIza`,
  длина 39 символов `[official — пример; подсчёт длины мой, `[inference]`]`.
- Второй тип — **authorization keys**, привязанные к service account; прямое предупреждение:
  «For APIs that create or manage resources in Google Cloud, **don't use authorization keys in
  production**».
- **Restrictions** — две независимые оси:
  - *application*: HTTP referrers / IP-адреса (IPv4, IPv6, CIDR) / Android (package + SHA-1) /
    iOS (bundle ID) — можно выбрать **только одну** из них;
  - *API*: список сервисов, которые ключ вправе звать.
  «Unrestricted API keys are insecure».
- **Строку нельзя посмотреть после создания** — копируй сразу.
- Удалённый ключ **восстанавливается в течение 30 дней**.
- Ротация = создать копию с теми же restrictions → переключить приложения → удалить старый.
- Транспорт: заголовок **`x-goog-api-key`**, а не query-параметр (чтобы не текло в логи/Referer).
- Best practices: не коммитить в репозиторий, не класть в клиентский код, удалять лишние,
  «свой ключ каждому члену команды на каждое приложение» (для аудита), мониторинг и алерты.
  Периодичность ротации на этой странице не названа; отдельные источники называют 90 дней
  `[secondary]`.

---

### 2.6 OAuth 2.0 как провайдер для сторонних приложений

**Client secret** `[official]`
- Формат: префикс **`GOCSPX-`** + ~24+ символов `[secondary]`. Новый формат введён в 2021 г.
  как соответствие RFC 6749 `[secondary]`.
- **Хэширование и показ один раз:** с **июня 2025** консоль маскирует секреты новых клиентов;
  с **ноября 2025** — распространяется на существующие. Показываются **последние 4 символа**.
  Восстановить нельзя — только создать новый.
- **Максимум 2 секрета на клиент одновременно** — прямая поддержка бесшовной ротации.
  Процедура: создать новый → переключить приложение → **disable старый** → удалить.
- Google рекомендует хранить секреты в Secret Manager, не в VCS.

**Жизненный цикл клиента** `[official]`
- Удалённый OAuth-клиент восстанавливается **не менее 30 дней** (страница Deleted Credentials).
- **Неактивные 6 месяцев клиенты удаляются автоматически** (нет ни обменов токенов, ни правок
  конфигурации), с уведомлением за 30 дней. Действует с июня 2025.

**PKCE и нативные приложения** `[official]`
- PKCE у Google для installed apps — **«Recommended», не обязательный параметр**.
- `code_challenge_method`: `S256` (рекоменд.) или `plain`; если метод не указан, а
  `code_challenge` есть — считается `plain`.
- `code_verifier`: символы `[A-Z][a-z][0-9]-._~`, длина **43–128**.
- Redirect: custom URI scheme (не рекомендуется) или loopback `http://127.0.0.1:port` /
  `http://[::1]:port`. **OOB (`urn:ietf:wg:oauth:2.0:oob`) больше не поддерживается.**
  Loopback **deprecated для Android / iOS / Chrome app** client types, остаётся для
  desktop (macOS/Linux/Windows).
- `client_secret` «не применим» к Android/iOS/Chrome-клиентам: «installed apps cannot keep secrets».

**Размеры токенов** `[official]`: authorization code — 256 байт, access token — 2048 байт,
refresh token — 512 байт. (Google советует не хардкодить размеры колонок меньше этого.)

**Истечение refresh-токена** `[official, дословные условия]`
- пользователь отозвал доступ;
- refresh token не использовался **6 месяцев**;
- пользователь сменил пароль **и** токен содержит Gmail-скоупы;
- приложение в статусе **Testing** → токены живут **7 дней**, кроме случая, когда запрошены
  только `name`/`email`/`profile`;
- админ ограничил сервисы в скоупах приложения;
- пользователь выдал time-based access, и он истёк;
- **лимит 100 refresh-токенов на Google-аккаунт на один client_id**; при превышении
  «creating a new refresh token automatically **invalidates the oldest refresh token without
  warning**». На service accounts лимит не распространяется.
  (Лимита «50 на service account» в официальной доке я не нашёл — см. §6.)

**Инкрементальная авторизация и гранулярное согласие** `[official]`
- `include_granted_scopes=true` — новый токен покрывает и ранее выданные скоупы.
- `access_type=offline` — выдать refresh token; `prompt=consent` — принудительно переспросить.
- **Granular permissions**: при запросе нескольких скоупов пользователь видит чекбоксы и может
  разрешить только часть. Обязанность приложения — **проверить фактически выданные скоупы** и
  корректно отключить соответствующие функции. При одном скоупе чекбоксов нет.

**Верификация приложения** `[official]`
- Скоупы делятся на обычные / **sensitive** / **restricted**.
- Sensitive/restricted требуют прохождения OAuth app verification (обычно **3–5 рабочих дней**):
  верификация бренда, обоснование каждого скоупа, демо-видео потока согласия.
- Неверифицированное приложение: экран «unverified app» + **user cap** на число аккаунтов,
  которые могут выдать доступ (конкретное число на этой странице не приведено; широко
  цитируется 100 `[secondary]`).
- Требование независимой оценки безопасности (CASA) для restricted-скоупов первоисточником
  подтвердить не удалось — см. §6.

**Device flow (для POS/IoT/TV)** `[official]`
- Эндпоинты: `https://oauth2.googleapis.com/device/code` (запрос кода),
  `https://oauth2.googleapis.com/token` (polling), `https://oauth2.googleapis.com/revoke`.
- Ответ: `device_code`, `user_code`, `verification_url`, `expires_in` (в примере **1800 с**),
  `interval` (в примере **5 с**). Дока прямо требует **не хардкодить** эти значения.
- Требования к UI: место под 15 символов 'W' для `user_code`, до 40 символов для URL;
  `user_code` case-sensitive, менять нельзя.
- Ошибки polling: `authorization_pending` (428), `slow_down` (403), `access_denied` (403),
  `invalid_client` (401), `admin_policy_enforced` (400).
- **Скоупы ограничены**: только OIDC (`email`, `openid`, `profile`), Drive
  (`drive.appdata`, `drive.file`) и YouTube. Это важнейший урок: Google **не даёт** device flow
  доступ к «тяжёлым» данным, потому что поток фишится тривиально.

**Отзыв** `[official]` — POST на `https://oauth2.googleapis.com/revoke` с параметром `token`;
успех = 200; после отзыва попытки использования дают `invalid_grant`.

**Cross-Account Protection (RISC)** `[official]`
- Google **push-уведомляет сторонние приложения** о событиях в аккаунте пользователя.
- Типы событий: `sessions-revoked`, `tokens-revoked`, `token-revoked`, `account-disabled`,
  `account-enabled`, `account-credential-change-required`, `verification`.
- Формат — **Security Event Token (SET)**: подписанный JWT с `iss`/`aud`, `jti` (для дедупликации),
  `events`, `subject`.
- Регистрация: service account с ролью RISC Configuration Admin, включить RISC API, поднять
  HTTPS-эндпоинт, зарегистрировать его аутентифицированным вызовом.

**Проверка ID-токена на бэкенде** `[official]`
1. подпись по публичным ключам `https://www.googleapis.com/oauth2/v3/certs` (ключи **ротируются**,
   период кэша брать из заголовка `Cache-Control`);
2. `iss` ∈ {`accounts.google.com`, `https://accounts.google.com`};
3. `aud` == ваш client ID (иначе токен чужого приложения пустят к вам);
4. `exp` не истёк;
5. опционально `hd` — домен Workspace.
Прямое предупреждение: **никогда не принимать «голый» user id с клиента** — «A modified client
application can send arbitrary user IDs to your server to impersonate users».

**Workspace как «организация-арендатор»** `[official]`
- Уровни доступа приложения: **Trusted** (все скоупы, включая restricted) / **Limited** (только
  нерестриктированные сервисы) / **Specific Google Data** (только перечисленные скоупы) /
  **Blocked**.
- Дефолт для ненастроенных сторонних приложений — **разрешающий**: «Allow users to access any
  third-party apps».
- Есть предопределённые списки high-risk скоупов для Gmail, Drive, Docs, Chat.
- Ловушка из доки: «the list of OAuth scopes includes **all scopes that the app has ever
  requested**».
- Чекбокс «Trust internal apps» разом доверяет всем внутренним приложениям.
- **Domain-wide delegation**: клиент (service account или OAuth client) получает доступ к данным
  **всех** пользователей домена **без их согласия**. Настраивается парой (client ID, список
  скоупов). Google требует регулярного ревью и удаления неиспользуемых.

---

### 2.7 Consumer-аккаунты (B2C-уроки)

`[official]`

- **App passwords**: 16-значный код, работает только при включённой 2SV, недоступен при
  Advanced Protection / «только security keys» / обычно недоступен для рабочих аккаунтов.
  **Автоматически отзывается при смене пароля аккаунта.** Позиция Google: «App passwords aren't
  recommended and are unnecessary in most cases».
- **Свёртывание Less Secure Apps / Google Sync** (Workspace Updates) — три вехи:
  - **15 июня 2024** — настройка LSA убрана из Admin console, новые Google Sync-подключения
    заблокированы;
  - **30 сентября 2024** — LSA выключены для всех Workspace-аккаунтов;
  - **14 марта 2025** — финальный дедлайн; протоколы CalDAV, CardDAV, IMAP, SMTP, POP и
    Google Sync больше не принимают пароль, только **OAuth**.
  App passwords как механизм остались (для устройств без OAuth — сканеры и т.п.), но
  вторичные источники указывают, что через них нельзя тянуть почту по IMAP/POP `[secondary]`.
- **Passkeys**: поддержка раскатана в мае 2023; позже сделаны опцией по умолчанию для личных
  Google-аккаунтов (переключатель «Skip password when possible»). Точная дата перевода в
  дефолт по первоисточнику не подтверждена — см. §6.
- **Страница «Third-party apps & services»**: перечисляет приложения трёх видов — вошедшие через
  «Sign in with Google», связанные account-linking'ом, и имеющие доступ к данным. «Remove access»
  отзывает доступ, но **не удаляет аккаунт и данные в стороннем сервисе** — Google это отдельно
  проговаривает пользователю.
- **Step-up аутентификация в Cloud**: перед «sensitive actions» требуется повторный ввод пароля
  или MFA, **если не было реаутентификации в последние 15 минут**; включено по умолчанию;
  мотив прямо назван — защита от кражи cookie. Админ может настроить Google Cloud session control
  (полный логин / только пароль / аппаратный ключ).

---

### 2.8 Устройства, IoT, POS

- **Cloud IoT Core закрыт 16 августа 2023** `[official — дата подтверждена в доках/ToS;
  формулировка причины — [secondary]]`. Официальная мотивировка — партнёры лучше обслужат
  IoT-заказчиков. Урок для нас: **не строить бизнес-критичный слой идентичности устройств на
  чужом управляемом сервисе**, особенно на нишевом.
- **Android Keystore** `[official]`:
  - материал ключа **никогда не попадает в процесс приложения**; `KeyStore.getKey()` отдаёт
    ссылку, а не байты;
  - два уровня: `TRUSTED_ENVIRONMENT` (TEE) и `STRONGBOX` (отдельный чип с собственным CPU,
    TRNG, защитой от вскрытия, secure timer); проверка — `KeyInfo.getSecurityLevel()` (API 29+)
    или `PackageManager.FEATURE_STRONGBOX_KEYSTORE`;
  - StrongBox поддерживает RSA-2048, AES-128/256, ECDSA/ECDH P-256, HMAC-SHA256 (ключ 8–64 байта),
    3DES; он **медленнее** — Google советует включать только при реальной угрозе физического
    доступа;
  - **key attestation** — доказательство, что ключ рождён в защищённом железе;
  - привязка к пользователю: `setUserAuthenticationParameters(timeout, authType)` —
    либо окно в секундах после аутентификации, либо **per-operation** авторизация через
    `BiometricPrompt`;
  - `setKeyValidityStart/End` есть, но **железо обычно не обеспечивает** временные рамки
    (нет доверенных часов) — важная ловушка;
  - импорт зашифрованного ключа (API 28+) через `WrappedKeyEntry` и ASN.1-структуру
    `SecureKeyWrapper` — ключ никогда не появляется в памяти в открытом виде.
- **Play Integrity API** `[official]`: вердикты `appLicensingVerdict` (ожидаем `LICENSED`),
  `appRecognitionVerdict` (`PLAY_RECOGNIZED`), `deviceIntegrity`
  (`MEETS_BASIC_INTEGRITY` / `MEETS_DEVICE_INTEGRITY` / `MEETS_STRONG_INTEGRITY`).
  Привязка запроса: `requestHash` (standard) или `nonce` (classic) — против replay и подмены.
  Дефолтная квота — **10 000 запросов в сутки** на все установки. Прямые указания:
  **никогда не кэшировать вердикт**; ответ должен быть не бинарным (allow / allow с лимитами /
  allow после CAPTCHA / deny) — «harder to replicate than binary responses».
- **Chrome Verified Access** `[official]` — модель «идентичность устройства» для корпоративного
  парка: расширение получает challenge, подписывает его через `enterprise.platformKeys`,
  сервис проверяет ответ через Verified Access API (управляемость, соответствие политике,
  свежесть challenge). Клиентские сертификаты **на TPM**, приватный ключ не покидает устройство.
- **Titan** `[official]` — аппаратный root of trust на серверах Google: криптографически измеряет
  прошивку; **прошивка Titan подписана ключом из офлайн-HSM под кворумным контролем**; boot ROM
  проверяет подпись при каждой загрузке; уникальный материал каждого чипа записывается в
  реестр происхождения; поток, похожий на **DICE**.

---

### 2.9 AI-агенты: Google уже сделал отдельный тип принципала

`[official]`

- **Agent Identity** — first-class principal, отличный и от человека, и от service account.
- Основа — **SPIFFE**. Формат:
  `spiffe://TRUST_DOMAIN/resources/SERVICE/RESOURCE_PATH`,
  IAM-принципал: `principal://TRUST_DOMAIN/resources/SERVICE/RESOURCE_PATH`.
- **X.509-сертификат действует 24 часа** и автоматически обновляется.
- Отличия от service account (дословно по смыслу): нельзя создать long-lived ключ;
  **нельзя импersonate**; по умолчанию **не разделяется** между воркладами.
- Для походов наружу — **Agent Identity auth manager** с «auth providers»: API-ключи,
  OAuth client ID + secret, **делегированные end-user OAuth токены (3-legged)**, 2-legged OAuth
  для machine-to-machine.
- Поддерживается всем стеком политик: IAM allow/deny, Principal Access Boundary, VPC-SC.

**Вывод для нас:** Google не стал выдавать агентам «обычный сервисный аккаунт с ключом». Он ввёл
отдельный вид личности с коротким сертификатом и отдельным хранилищем внешних креденшелов.
Это ровно грань (F) нашего ТЗ.

---

### 2.10 Исходящие вебхуки: Google не использует HMAC

`[official]`

- **Pub/Sub push**: Pub/Sub подписывает **OIDC JWT** и кладёт его в заголовок `Authorization`.
  Подписывающий service account должен иметь `iam.serviceAccounts.getOpenIdToken`
  (входит в `roles/iam.serviceAccountTokenCreator`). `audience` — строка, которую эндпоинт
  обязан сверить.
- **Google Chat → эндпоинт приложения**: `Authorization: Bearer <token>`;
  - issuer — **`chat@system.gserviceaccount.com`**;
  - audience — либо URL эндпоинта (тогда это Google-подписанный **ID token**), либо номер
    проекта (тогда self-signed JWT);
  - публичные сертификаты:
    `https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com`;
  - шаги проверки: подпись → `audience` совпадает → `email == chat@system.gserviceaccount.com`;
    иначе **401**.
  - На Cloud Run / Cloud Functions проверка делается платформой, если дать
    `chat@system.gserviceaccount.com` роль invoker.

**Ключевой урок:** асимметричная подпись + обязательная сверка `audience` устраняет и класс
«секрет вебхука утёк», и класс «replay на другой эндпоинт». Ротация сводится к ротации JWKS,
которую делает отправитель.

---

### 2.11 Философия самого Google

`[official: Cloud KMS deep dive, Infrastructure Security Design Overview, BeyondProd, Titan]`

**Иерархия обёрток (все ключи симметричные):**

```
данные
  └─ DEK                      (на объект/чанк, AES-256-GCM)
      └─ KEK                  (живёт в Cloud KMS; это и есть CMEK)
          └─ KMS master key   (на локацию)
              └─ Keystore master key
                  └─ Root keystore master key
```

- «Key material never leaves the Cloud KMS system boundary»; «In Cloud KMS, the key material is
  always encrypted at rest and in transit».
- Инженеры с доступом к датастору **не видят plaintext** ключевого материала; датастор сам
  шифрует всё перед записью.
- **Все метаданные аутентифицированы HMAC**; **ежечасный джоб** проверяет, что HMAC валидны и
  что ключевой материал реально расшифровывается.
- Бэкапы: 4-дневная история изменений строк, ежечасные снапшоты (хранятся 4 дня), ежедневные
  полные бэкапы на диск и в архив.
- KMS master key переобёртывается Keystore master key периодически, «refreshed every day»;
  клиентские ключи переобёртываются ежемесячно.
- На HSM «key material is never accessed in a decrypted state by Cloud KMS API jobs».

**Идентичность сервисов:**
- каждый сервис инфраструктуры имеет свою учётную запись и криптографические креденшелы;
- **ALTS** — mutual auth + шифрование для внутренних RPC (аналог mTLS, оптимизированный под ДЦ);
- когда сервис действует **от имени человека**, он предъявляет **end-user permission ticket** —
  короткоживущий «контекстный тикет», выданный центральным сервисом личности. То есть у Google
  делегирование от пользователя к сервису — это отдельный короткоживущий артефакт, а не
  «сервис ходит своими правами».
- **BeyondProd**: доверие к воркладу строится на происхождении кода и идентичности сервиса,
  а не на IP/хостнейме; сертификаты и ключи машинных личностей регулярно ротируются, старые
  отзываются.
- Доступ сотрудников Google к данным логируется «через низкоуровневые хуки инфраструктуры»
  с постоянным мониторингом аномалий.

---

## 3. Инциденты, уязвимости и выводы

| # | Инцидент | Что произошло | Урок для `core/keys` |
|---|---|---|---|
| 1 | **Google Docs OAuth worm**, май 2017 `[secondary]` | Приложение, названное «Google Docs», просило доступ к Gmail и контактам на **настоящем** экране согласия Google; распространилось червём по контактам; оценка — около 1 млн аккаунтов. | Имя стороннего приложения — **вектор атаки**. В нашем экране согласия имя приложения обязано быть верифицированным и визуально отделённым от бренда платформы; «издатель» должен быть подтверждён. |
| 2 | **GhostToken (CVE-less)**, найдена Astrix 19.06.2022, пропатчена Google 07.04.2023 `[secondary]` | Удаление GCP-проекта переводило его в `pending deletion` на 30 дней. В этом состоянии OAuth-приложение и **его токены продолжали работать**, но **исчезали** со страницы «Apps with access». Цикл delete/restore делал троян невидимым и неудаляемым. | **Любое «мягко удалённое» состояние обязано оставаться видимым в UI отзыва.** Лист выданных доступов должен строиться от токенов/грантов, а не от «живых» приложений. И реакция вендора заняла 9+ месяцев — значит, у нас должен быть собственный kill switch. |
| 3 | **DeleFriend**, Hunters, ноябрь 2023 `[secondary]` | Domain-Wide Delegation привязывается к **OAuth client ID**, а не к конкретному ключу service account. Обладатель права создавать ключи для SA (без Super Admin) мог перебором JWT-комбинаций найти уже выданные DWD-делегации и получить доступ к почте/дискам всего домена. | Делегирование **никогда не привязывать к «приложению вообще»**. Привязка должна быть к конкретному креденшелу + конкретному набору scope + конкретному арендатору, и перечисление комбинаций должно быть невозможно (rate limit + аудит неудачных попыток). |
| 4 | **MultiLogin / регенерация cookie**, CloudSEK, конец 2023 — начало 2024 `[secondary]` | Инфостилеры (Lumma, Rhadamanthys, RisePro, Meduza, Stealc, WhiteSnake) вытаскивали из Chrome `token_service` и через **недокументированный** эндпоинт `MultiLogin` бесконечно регенерировали сессионные cookie — **смена пароля не помогала**. | Недокументированный внутренний эндпоинт = такая же поверхность атаки, как публичный API. У нас: любой механизм «обновить сессию» обязан слушать `tokenEpoch`/revocation, а смена пароля обязана убивать ВСЕ производные артефакты на ВСЕХ путях. |
| 5 | **«Sign in with Google» и брошенные домены**, Truffle Security, январь 2025 `[secondary]` | `hd` и `email` не отражают смену владельца домена: купив домен закрытого стартапа, можно войти в аккаунты бывших сотрудников в Slack/Notion/Zoom/HR-системах. Найдено **116 481** доступных доменов. Заявлено также, что `sub` **меняется примерно в 0,04% логинов** — то есть на него нельзя опираться как на вечный ID. Google сперва закрыл тикет как «won't fix», после доклада на Shmoocon переоткрыл и выплатил $1 337. | Прямое попадание в наше правило «один `user_id` навсегда». **Нельзя делать домен/e-mail первичным ключом личности.** Нужен собственный неизменяемый внутренний ID + отдельный неизменяемый ID организации; e-mail и домен — только атрибуты, подлежащие ре-верификации. |
| 6 | **Массовые утечки service account keys в публичные репозитории** `[official реакция]` | Масштаб заставил Google: (а) с 3 мая 2024 включить запрет создания ключей по умолчанию для новых организаций; (б) с 16 июня 2024 **автоматически отключать** ключи, найденные партнёрами-сканерами. | Долгоживущий bearer-креденшел в файле — проигранная позиция. Нужны: узнаваемый **префикс** для секрет-сканеров, хранение только хэша, срок жизни, автоотзыв по сигналу сканера, «последнее использование» в UI. |
| 7 | **Закрытие Cloud IoT Core**, 16.08.2023 `[official дата]` | Сервис идентичности устройств прожил 5 лет и был закрыт с переводом клиентов на партнёров. | Идентичность устройств (POS/IoT) — **наш собственный слой**, не внешний managed-сервис. |
| 8 | **Cloud EKM ↔ доступность** `[official]` | Недоступность внешнего ключа > 30 суток подряд приводит к **автоматическому удалению базы Spanner**. | Внешний/самохостящийся KMS превращает риск доступности в риск потери данных. Нужен кэш DEK/KEK, graceful degradation и запрет «автоудаления по недоступности ключа». |

---

## 4. Что SuperApp6 стоит скопировать

### 4.1 Дизайн самохостящегося `core/keys` в духе Cloud KMS + Tink

**Ресурсная модель (копируем 1:1 по смыслу, с поправкой на арендаторов):**

```
keyring   (scope: platform | workspace:<id>, purpose-группа)
  └─ key        (стабильное имя, неизменяемые purpose и protection level)
       └─ key_version  (целое, монотонное; ровно одна primary)
```

Правила, которые надо перенести дословно:
- `purpose` и `protection_level` **иммутабельны** после создания;
- имя ключа **никогда не переиспользуется** (уникальный индекс без возможности удаления строки —
  только tombstone);
- key ring **не удаляется** (защита от «переиспользовал имя → расшифровал не то»);
- ротация создаёт **новую primary-версию**, старые остаются активны на расшифровку;
- у каждого шифротекста хранится **key id версии** (см. ниже про формат).

**Состояния версии** — берём машину Google целиком:
`pending → enabled ⇄ disabled → destroy_scheduled → destroyed`,
восстановление из `destroy_scheduled` возвращает в **`disabled`** (обязательный явный
второй шаг «включить»). Задержка уничтожения — **30 суток по умолчанию**, задаётся при создании
ключа, минимум 24 часа; отдельный флаг «нельзя планировать уничтожение, пока не disabled».

**Формат шифротекста — заимствуем Tink, но исправляем его слабое место.**
Google честно пишет, что 5-байтовый префикс Tink **не аутентифицирован**. Нам стоит:

```
[1 байт version][4 байта BE key_version_id][12 байт nonce][ciphertext][16 байт tag]
```

…и **положить `key_version_id` (и `keyring/key`) в AAD**, чтобы подмена префикса ломала
расшифровку, а не просто указывала на другой ключ. Это дешёвое улучшение относительно Tink.

**AAD — обязательный контракт, а не опция.** Правило: AAD = каноническая строка
`"<entity_type>|<entity_id>|<field>|<workspace_id>"`. Тогда:
- шифротекст OAuth refresh-токена Google, перенесённый из строки пользователя А в строку Б, не
  расшифруется;
- перенос между организациями невозможен физически, а не только по проверке в коде —
  это второй, криптографический контур B2B-изоляции поверх `X-Workspace-Id`.
**AAD не хранить рядом с шифротекстом и не писать в логи** (как у Google).

**Иерархия обёрток** — три уровня достаточно (у Google пять, но у него — планетарный масштаб):

```
данные ─ DEK (AES-256-GCM, на запись/на объект)
          └─ KEK (в core/keys, на (workspace, purpose))
              └─ root master key (в HSM / в файле под управлением ОС / в отдельном модуле)
```

- DEK **не ротируется** — генерируется на каждую запись (правило Google дословно);
- ротируется только KEK, и это **не требует перешифрования** данных;
- root master key — единственная вещь, требующая кастодианов и кворума.
  Здесь копируем Titan: **подпись/распечатка root-ключа под кворумным контролем, офлайн**.

**Разделение обязанностей — в способности `core/access`:**
- `keys.admin` — создавать/ротировать/планировать уничтожение, **без** encrypt/decrypt;
- `keys.encrypt`, `keys.decrypt`, `keys.sign`, `keys.verify` — отдельные способности,
  выдаются **на конкретный ключ**, не на keyring;
- обязательный страж (по образцу SCC «KMS Role Separation»): **никто не должен иметь
  одновременно `keys.admin` и `keys.decrypt` на одном ключе** — прогонять в `pnpm lint:guard`
  или в отдельном `check:keys`.

**Аудит — но с поправкой на ошибку Google.** У Google использование ключа логируется только при
явно включённом Data Access. Для нас использование ключа — **всегда** запись в хронику
(`core/chatter`) или в отдельный `key_audit`, синхронно в той же транзакции. Отключаемого
режима быть не должно.

**Кэш DEK и квоты.** 64 KiB-лимит Google — намёк: никогда не гонять через движок объём.
У нас: `core/keys` отдаёт **обёрнутый DEK**, разворачивает его в памяти процесса с TTL
(например, 5 минут) и метрикой «unwrap/сек». Это же спасает при недоступности KMS-бэкенда.

**Kill switch.** Как у CMEK: `disabled` KEK ⇒ данные организации недоступны мгновенно, без
перешифрования. Это готовый механизм «заморозить арендатора» и «ответ на инцидент».
Но — с оговоркой из инцидента EKM: **никакого автоудаления данных по факту недоступности ключа**.

**Key Access Justifications в миниатюре.** Очень дешёвая и очень сильная идея: каждый вызов
`decrypt` несёт машинный `reason` (`user_request`, `background_job`, `support_access`,
`export`, `migration`). Политика ключа может запрещать `support_access` без активного
step-up-подтверждения. Для казахстанского регулятора и для доверия B2B это готовый аргумент.

### 4.2 Программные креденшелы (грань B)

Собираем из лучших кусков Google:

| Свойство | Решение (источник идеи) |
|---|---|
| Показ | **Один раз при создании**; далее только последние 4 символа (OAuth client secrets, июнь 2025) |
| Хранение | Только **хэш** (Argon2id/scrypt по секрету, HMAC-SHA256 по длинному high-entropy — достаточно) |
| Префикс | Обязательный узнаваемый префикс на тип: `sa6_org_`, `sa6_pat_`, `sa6_bot_`, `sa6_whk_` — для секрет-сканеров и для поддержки партнёрской программы GitHub/GitLab (идея Google + GitHub secret scanning) |
| Одновременных секретов | **Ровно 2** на клиент/интеграцию — принудительная бесшовная ротация (Google OAuth) |
| Ротация | Создать → раскатить → **disable старый и подождать** → удалить (5-шаговая процедура Google для SA-ключей; «disable, подожди неделю» из Secret Manager) |
| Срок жизни | Явный `expires_at`, значения из фиксированного списка (8h / 24h / 7d / 14d / 30d / 60d / 90d — список Google `serviceAccountKeyExpiryHours`) |
| Политика арендатора | Аналог org-policy: организация может запретить создание долгоживущих ключей, задать максимальный TTL, запретить key upload |
| Last used | Обязательно, как Activity Analyzer; можно с суточной гранулярностью (у Google именно так) |
| Автоотзыв | Реакция на сигнал секрет-сканера: `DISABLE` по умолчанию, `WAIT_FOR_ABUSE` — осознанный opt-out (Google, 16.06.2024) |
| Удаление | Soft-delete + **восстановление 30 дней** (API keys, OAuth clients) |
| Неактивность | Автоудаление после **6 месяцев** без использования, уведомление за 30 дней (OAuth clients, июнь 2025) |
| Restrictions | Две независимые оси, как у API keys: **где можно использовать** (IP allow-list / origin / приложение) и **что можно вызывать** (скоупы = наши способности) |
| Транспорт | Свой заголовок (`X-SuperApp-Key`), **никогда не query-параметр** (правило `x-goog-api-key`) |
| Идентичность | Ключ организации **не несёт личность человека**. Если нужна личность — отдельный тип (PAT), и он наследует ограничения роли владельца в момент **исполнения**, а не выдачи |
| Неотказуемость | Прямая цитата Google как обоснование дизайна: «there is no reliable way to tell who used the key» ⇒ у каждого ключа **один** владелец и одно назначение, «общих» ключей не бывает |

**Отдельно: неотзываемость производных токенов.** Урок Google — «удаление ключа не отзывает уже
выданные короткоживущие токены». У нас: если выдаём короткоживущий JWT по API-ключу, он обязан
нести `key_id` + `epoch`, и проверка эпохи должна стоять на пути валидации, иначе отзыв ключа
будет фикцией.

### 4.3 OAuth2-провайдер для сторонних приложений (грань D)

- Client secret: `GOCSPX-`-подобный префикс, хэш, показ один раз, **2 секрета** на клиента.
- **PKCE обязателен** для всех public clients (Google оставил его «recommended» — это его
  legacy-совместимость, нам незачем её наследовать). `S256` только, `plain` не поддерживать.
- Redirect: запретить OOB, запретить wildcard; для мобильных — только app-links/universal links;
  loopback — только для desktop.
- Согласие: **гранулярные чекбоксы по скоупам** + обязанность приложения проверять фактически
  выданный набор. Инкрементальная авторизация (`include_granted_scopes`).
- Refresh-токены: лимит на пару (пользователь, client_id) с вытеснением самого старого —
  но, в отличие от Google, **с уведомлением**, а не «without warning».
- Отзыв: `/oauth/revoke`, плюс **RISC-подобный исходящий канал** — подписанный SET-JWT на
  эндпоинт приложения при событиях `sessions-revoked`, `tokens-revoked`, `account-disabled`,
  `credential-change-required`. Для экосистемы на 100+ сервисов это критично: партнёр обязан
  узнать, что сотрудник уволен, за секунды.
- Верификация приложения перед публикацией + экран «неподтверждённое приложение» + **user cap**
  до верификации.
- Панель организации: уровни **Trusted / Limited / Specific scopes / Blocked**.
  ⚠️ Но дефолт делаем **противоположный** Google — см. §5.
- ID-токен: чек-лист проверки из доки Google (подпись по JWKS с ротацией, `iss`, `aud` == client
  id, `exp`, плюс наш `workspace_id`) — и **никогда** не принимать «голый user id» от клиента.

### 4.4 Вебхуки (грань C)

**Копируем модель Google целиком и отказываемся от HMAC-секретов:**
- подписываем исходящий вебхук **асимметрично** (JWT, EdDSA/ES256), ключ — из `core/keys`,
  purpose `ASYMMETRIC_SIGN`;
- `aud` = **URL эндпоинта получателя** (защита от пересылки на другой эндпоинт);
- `iss` = стабильный идентификатор нашей платформы; `jti` для дедупликации; короткий `exp`;
- публикуем JWKS по стабильному URL, ротируем ключи, оставляя старые до `exp` последнего токена;
- документируем обязательный чек-лист верификации и возврат 401.

Это убирает целый класс задач: «хранение секрета эндпоинта», «ротация секрета вебхука»,
«секрет утёк». Если партнёр требует HMAC — поддержать как legacy-опцию, но не как дефолт.

### 4.5 Устройства и POS (грань E)

- **Не делать device credential долгоживущим bearer-токеном.** Модель Chrome Verified Access:
  на устройстве — приватный ключ в защищённом хранилище (Android Keystore / StrongBox / TPM /
  secure element POS-терминала), сервер шлёт challenge, устройство подписывает, сервер выдаёт
  короткоживущий access-token.
- **Attestation при регистрации**: Android key attestation / Play Integrity — проверять, что ключ
  действительно рождён в железе, а не сгенерирован в эмуляторе.
- Device flow (для «привязать терминал кодом») — брать схему Google, включая **ограниченный
  набор скоупов** и `slow_down`/`authorization_pending`/`expired_token`. Никогда не давать
  device flow доступ к деньгам напрямую.
- Не полагаться на `setKeyValidityStart/End` — на устройстве нет доверенных часов;
  срок жизни обеспечивает сервер.
- Вердикт целостности **не кэшировать**; реакция — градуированная (разрешить / разрешить с
  лимитом / потребовать подтверждения / отказать).

### 4.6 AI-агенты (грань F)

Прямо копируем Agent Identity:
- **отдельный тип принципала** (не человек, не сервисный аккаунт);
- идентификатор в стиле SPIFFE, привязанный к ресурсу-носителю агента;
- креденшел — **короткоживущий (24 ч) сертификат/токен с авторотацией**, долгоживущие ключи
  запрещены на уровне схемы;
- агента **нельзя импersonate**, идентичность не разделяется между запусками;
- отдельный **auth manager** для внешних креденшелов агента (API-ключи, OAuth client secret,
  делегированные end-user токены) — то есть агент не хранит секреты у себя;
- при действии от имени человека — аналог **end-user permission ticket** Google: короткий
  делегационный токен с явным `on_behalf_of`, набором способностей ≤ способностей человека и
  сроком жизни минутами. Деньги — по правилу CLAUDE.md — только через сервисные API, и
  делегационный токен для денежных операций должен требовать step-up.

---

## 5. Что копировать НЕ надо / ловушки

1. **Дефолт Workspace «Allow users to access any third-party apps».** Google по историческим
   причинам разрешает всё ненастроенное. Для B2B-арендатора это ровно тот дефолт, который
   породил инцидент 2017 года. У нас дефолт должен быть **Blocked**, а разрешение — явным
   действием админа организации.
2. **PKCE как «recommended».** Google не может сломать легаси. Мы стартуем с нуля — PKCE
   обязателен, `plain` не поддерживаем.
3. **Тихое вытеснение самого старого refresh-токена** при достижении лимита 100
   («without warning»). Это источник неотлаживаемых багов у интеграторов. Лимит — да,
   вытеснение — только с событием/уведомлением и с записью в аудит.
4. **Data Access-логи по умолчанию выключены.** Не повторять: использование ключа логируем всегда.
5. **Пятиуровневая обёртка ключей.** У нас нет планетарного масштаба; каждый лишний уровень —
   лишний класс отказов. Трёх уровней (DEK → KEK → root) достаточно.
6. **Долгоживущие «ключи сервисного аккаунта» в JSON-файле.** Google сам объявил это
   анти-паттерном и включает запрет по умолчанию. Не воспроизводить даже «на первое время».
7. **Срок годности ключа как механизм ротации.** Прямое предупреждение Google:
   «expiring keys can cause outages if they aren't rotated properly». Срок годности — да, но
   вместе с дашбордом «истекает через N дней», уведомлениями и возможностью иметь 2 активных
   секрета.
8. **Domain-wide delegation в том виде, как у Google.** Делегирование, привязанное к
   «приложению вообще» и дающее доступ к данным ВСЕХ пользователей без их согласия, —
   это DeleFriend. У нас: делегирование всегда «конкретный креденшел × конкретные способности ×
   конкретный арендатор», перечисление недоступно, каждая неудачная попытка в аудит.
9. **`email`/`domain` как идентичность.** Инцидент Truffle Security. Один `user_id` навсегда —
   и он должен быть внутренним, не производным ни от почты, ни от домена, ни от номера телефона.
   Соответственно и `workspace_id` не должен выводиться из домена.
10. **Мягко удалённые сущности, исчезающие из UI отзыва** (GhostToken). Экран «кому я выдал
    доступ» строим от **грантов/токенов**, а не от списка живых приложений; всё, что может
    ходить в API, обязано быть видно.
11. **Невозможность отозвать выданный короткоживущий токен.** У Google это данность. У нас
    есть `tokenEpoch` — обязательно распространить его на все производные токены
    (агентские, устройственные, OAuth-производные).
12. **Автоудаление данных при недоступности ключа** (поведение Spanner+EKM). Никогда.
    Максимум — read-only и алерт.
13. **API-ключ как носитель личности.** Соблазн «ключ организации = действует от имени владельца»
    ломает и аудит, и least privilege. Google явно запрещает authorization keys в продакшне.
14. **Незаверенный key-id префикс Tink.** Не копировать буквально — класть идентификатор
    версии ключа ещё и в AAD.
15. **Device flow с широкими скоупами.** Google ограничил его OIDC + Drive-файлами + YouTube
    не случайно. Терминал не должен получать через device flow ничего денежного.
16. **`latest` вместо номера версии** (Secret Manager best practice наоборот). Конфигурация
    должна пинить версию секрета/ключа, чтобы откат был штатным релизным действием.

---

## 6. Открытые вопросы (не подтверждено первоисточником)

1. **Дата изменения `destroyScheduledDuration` с 24 часов на 30 суток** (называется 01.02.2024)
   и **границы 24 ч / 120 суток** — найдены только во вторичных источниках и в результате
   поиска; страница `control-key-destruction` их не содержит.
2. **Невозможность изменить `destroyScheduledDuration` после создания ключа** — `[secondary]`.
3. **Точное число аккаунтов в user cap для неверифицированных OAuth-приложений** (часто
   называют 100) — на официальной странице verification числа нет.
4. **CASA (Cloud Application Security Assessment) для restricted-скоупов**: тиры, ежегодная
   переоценка, стоимость — первоисточник не открылся; подтвердить не удалось.
5. **Лимит «50 refresh-токенов на service account на клиента»** — в официальной доке такого
   лимита нет; там только 100 на Google-аккаунт на client_id, и указано, что на service accounts
   он **не распространяется**. Упоминание «большего общего лимита на все клиенты» есть
   `[secondary]`, но без числа.
6. **Точная дата, когда passkeys стали дефолтом** для личных Google-аккаунтов — блог найден,
   дата по первоисточнику не зафиксирована.
7. **Работают ли app passwords для IMAP/POP после 14.03.2025** — вторичные источники говорят
   «нет», официальная страница App passwords об этом не пишет, а Workspace Updates упоминает
   app password как обходной путь для устройств. Противоречие не разрешено.
8. **Формальная длина и алфавит Google API key** (`AIza…`, 39 символов) — из примера в доке;
   спецификации формата Google не публикует.
9. **Длина и алфавит `GOCSPX-` client secret** — `[secondary]`.
10. **Отзыв уже выданных короткоживущих токенов IAM до истечения** — механизма в доке не найдено;
    вывод «нельзя» — `[inference]`.
11. **Явная рекомендация Google кэшировать DEK ради квоты/латентности** — на страницах
    envelope-encryption и quotas не найдена; связь выведена мной `[inference]`.
12. **Наличие у Cloud API keys собственного поля expiry/annotations** — в overview не описано;
    вероятно, нет, но подтвердить не удалось.
13. **Официальная формулировка причины закрытия Cloud IoT Core** («партнёры обслужат лучше») —
    `[secondary]`; подтверждена только дата 16.08.2023.
14. **Output prefix types `RAW` / `CRUNCHY` / `LEGACY` в Tink** — на официальной wire-format
    странице описаны только версии `0x01` и `0x00`; остальное `[secondary]`.
15. **Статистика Google о доле взломов из-за SA-ключей** — в блогах Google цифр нет, только
    качественные формулировки. Любые «X% breaches» из вторичных источников я не переношу.

---

## 7. Список источников

### Cloud KMS
1. [official] Cloud KMS resources (иерархия, resource IDs, protection levels) — https://docs.cloud.google.com/kms/docs/resource-hierarchy
2. [official] Key rotation — https://docs.cloud.google.com/kms/docs/key-rotation
3. [official] Envelope encryption — https://docs.cloud.google.com/kms/docs/envelope-encryption
4. [official] Additional authenticated data — https://docs.cloud.google.com/kms/docs/additional-authenticated-data
5. [official] Cloud KMS overview (protection levels, цены, FIPS) — https://docs.cloud.google.com/kms/docs/key-management-service
6. [official] Algorithms (purposes + enum-имена, PQC) — https://docs.cloud.google.com/kms/docs/algorithms
7. [official] Permissions and roles — https://docs.cloud.google.com/kms/docs/reference/permissions-and-roles
8. [official] Key version states — https://docs.cloud.google.com/kms/docs/key-states
9. [official] Destroy and restore key versions (30 дней, 45 дней хранения) — https://docs.cloud.google.com/kms/docs/destroy-restore
10. [official] Control key version destruction (org-policy) — https://docs.cloud.google.com/kms/docs/control-key-destruction
11. [official] Quotas — https://docs.cloud.google.com/kms/quotas
12. [official] Cloud KMS deep dive (иерархия обёрток, HMAC метаданных, бэкапы) — https://docs.cloud.google.com/docs/security/key-management-deep-dive
13. [official] Audit logging — https://docs.cloud.google.com/kms/docs/audit-logging
14. [official] Separation of duties — https://docs.cloud.google.com/kms/docs/separation-of-duties
15. [official] CMEK best practices — https://docs.cloud.google.com/kms/docs/cmek-best-practices
16. [official] Org policy constraints for Cloud KMS — https://docs.cloud.google.com/kms/docs/org-policy-constraints
17. [official] Importing a key (import job, 3 дня, wrapping) — https://docs.cloud.google.com/kms/docs/importing-a-key
18. [official] Autokey overview — https://docs.cloud.google.com/kms/docs/autokey-overview
19. [official] Cloud EKM — https://docs.cloud.google.com/kms/docs/ekm
20. [official] View key usage (KMS Inventory API) — https://docs.cloud.google.com/kms/docs/view-key-usage
21. [official] Key Access Justifications — коды причин — https://docs.cloud.google.com/assured-workloads/key-access-justifications/docs/justification-codes
22. [official] Key Access Justifications overview — https://docs.cloud.google.com/assured-workloads/key-access-justifications/docs/overview
23. [secondary] Изменение дефолта destroy-duration 24h→30d, границы 24h/120d — сводка поисковой выдачи по docs.cloud.google.com/kms/docs/release-notes

### Tink
24. [official] Tink — Keysets — https://developers.google.com/tink/design/keysets
25. [official] Tink — Key concepts — https://developers.google.com/tink/key-concepts
26. [official] Tink — Wire format (префикс `0x01` + 4 байта key id, «not authenticated») — https://developers.google.com/tink/wire-format
27. [official] Tink — Create and store a keyset in plaintext (предупреждения) — https://developers.google.com/tink/generate-plaintext-keyset
28. [secondary] `CleartextKeysetHandle` — исходники tink-crypto/tink (Java/Python) — https://github.com/tink-crypto/tink

### Secret Manager
29. [official] Secret Manager overview — https://docs.cloud.google.com/secret-manager/docs/overview
30. [official] Secret rotation (Pub/Sub `SECRET_ROTATE`, ≥1h) — https://docs.cloud.google.com/secret-manager/docs/secret-rotation
31. [official] Secret Manager best practices (pin version, disable before destroy) — https://docs.cloud.google.com/secret-manager/docs/best-practices
32. [official] Secret Manager quotas and limits (64 KiB, 50 алиасов, 90k/мин) — https://docs.cloud.google.com/secret-manager/quotas
33. [official] Destroy a secret version (delayed destroy) — https://docs.cloud.google.com/secret-manager/docs/destroy-secret-version
34. [official] CMEK for Secret Manager — https://docs.cloud.google.com/secret-manager/docs/cmek

### IAM / service accounts / федерация
35. [official] Best practices for using service accounts — https://docs.cloud.google.com/iam/docs/best-practices-service-accounts
36. [official] Create and delete service account keys (10 ключей, JSON/P12, org-policies) — https://docs.cloud.google.com/iam/docs/keys-create-delete
37. [official] Service account key rotation (90 дней, 5 шагов, Asset Inventory) — https://docs.cloud.google.com/iam/docs/key-rotation
38. [official] Workload Identity Federation — https://docs.cloud.google.com/iam/docs/workload-identity-federation
39. [official] Create short-lived credentials (1ч / 12ч, org-policy, роли) — https://docs.cloud.google.com/iam/docs/create-short-lived-credentials-direct
40. [official] Блог: Automatically disabling leaked service account keys (16.06.2024, GitHub/GitLab, `constraints/iam.serviceAccountKeyExposureResponse`) — https://cloud.google.com/blog/products/identity-security/automatically-disabling-leaked-service-account-keys-what-you-need-to-know
41. [official] Блог: Introducing time-bound key authentication (`iam.serviceAccountKeyExpiryHours`, значения 8h…2160h) — https://cloud.google.com/blog/products/identity-security/introducing-time-bound-key-authentication-for-service-accounts
42. [official] Activity Analyzer — last authentication для SA и ключей — https://docs.cloud.google.com/policy-intelligence/docs/activity-analyzer-service-account-authentication
43. [official] Restrict IAM service account usage (org policies) — https://docs.cloud.google.com/organization-policy/restrict-service-accounts
44. [official] Reauthentication for sensitive actions (15 минут) — https://docs.cloud.google.com/docs/authentication/reauthentication

### API keys
45. [official] Manage API keys / authentication with API keys — https://docs.cloud.google.com/docs/authentication/api-keys
46. [official] Best practices for managing API keys — https://docs.cloud.google.com/docs/authentication/api-keys-best-practices
47. [official] API Keys API overview — https://docs.cloud.google.com/api-keys/docs/overview

### OAuth 2.0 / идентичность
48. [official] Using OAuth 2.0 to Access Google APIs (потоки, размеры токенов, истечение refresh) — https://developers.google.com/identity/protocols/oauth2
49. [official] OAuth 2.0 for Web Server Applications (`access_type`, `include_granted_scopes`, `/revoke`) — https://developers.google.com/identity/protocols/oauth2/web-server
50. [official] OAuth 2.0 for Mobile & Desktop Apps (PKCE, 43–128, OOB removed, loopback deprecated) — https://developers.google.com/identity/protocols/oauth2/native-app
51. [official] OAuth 2.0 for TV and Limited-Input Devices — https://developers.google.com/identity/protocols/oauth2/limited-input-device
52. [official] Блог: Usability and safety updates to Google Auth Platform (маскирование секретов, автоудаление неактивных клиентов) — https://developers.googleblog.com/en/usability-and-safety-updates-to-google-auth-platform/
53. [official] Manage OAuth Clients (2 секрета, 30 дней восстановления, 6 месяцев неактивности) — https://support.google.com/cloud/answer/15549257
54. [official] How to handle granular permissions — https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions
55. [official] Sensitive scope verification — https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
56. [official] Cross-Account Protection (RISC) — https://developers.google.com/identity/protocols/risc
57. [official] Verify the Google ID token on your backend — https://developers.google.com/identity/sign-in/web/backend-auth
58. [secondary] Префикс `GOCSPX-`, длина client secret — детектор `gcpoauth2client` в google/osv-scalibr — https://pkg.go.dev/github.com/google/osv-scalibr/veles/secrets/gcpoauth2client
59. [secondary] GitHub secret scanning — поддерживаемые Google-паттерны (API Key, SA Credentials, OAuth Client ID/Secret, Access/Refresh Token) — https://docs.github.com/en/code-security/secret-scanning/introduction/supported-secret-scanning-patterns

### Workspace
60. [official] Control which third-party & internal apps access Workspace data (Trusted/Limited/Specific/Blocked) — https://knowledge.workspace.google.com/admin/apps/control-which-apps-access-google-workspace-data
61. [official] Control API access with domain-wide delegation — https://knowledge.workspace.google.com/admin/apps/control-api-access-with-domain-wide-delegation
62. [official] Workspace Updates: winding down Google Sync and LSA (15.06.2024 / 30.09.2024 / 14.03.2025) — https://workspaceupdates.googleblog.com/2023/09/winding-down-google-sync-and-less-secure-apps-support.html
63. [official] Verify requests from Google Chat (issuer `chat@system.gserviceaccount.com`, audience, x509 JWKS) — https://developers.google.com/workspace/chat/verify-requests-from-chat

### Consumer
64. [official] Sign in with app passwords (16 цифр, требует 2SV, отзыв при смене пароля) — https://support.google.com/accounts/answer/185833
65. [official] Manage third-party apps & services with access to your account — https://support.google.com/accounts/answer/13533235
66. [official] Блог: Passkeys are now enabled by default for Google users — https://blog.google/technology/safety-security/passkeys-default-google-accounts/

### Устройства, IoT, железо
67. [official] Android Keystore system (TEE/StrongBox, attestation, SecureKeyWrapper) — https://developer.android.com/privacy-and-security/keystore
68. [official] Play Integrity API overview (вердикты, requestHash/nonce, 10 000/сутки) — https://developer.android.com/google/play/integrity/overview
69. [official] Chrome Verified Access overview / developer guide (challenge-response, TPM) — https://developers.google.com/chrome/verified-access/overview
70. [official] Titan hardware chip (офлайн-HSM, кворум, DICE) — https://docs.cloud.google.com/docs/security/titan-hardware-chip
71. [secondary] Дата и мотивы закрытия Cloud IoT Core (16.08.2023) — https://www.itnews.com.au/news/google-cloud-iot-core-goes-on-the-end-of-life-list-583990 · https://cloud.google.com/architecture/connected-devices/iot-core-migration [official — дата]

### Инфраструктура Google
72. [official] Google infrastructure security design overview (Titan, ALTS, end-user permission tickets) — https://docs.cloud.google.com/docs/security/infrastructure/design
73. [official] BeyondProd — https://docs.cloud.google.com/docs/security/beyondprod
74. [official] Application Layer Transport Security — https://docs.cloud.google.com/docs/security/encryption-in-transit/application-layer-transport-security

### AI-агенты и вебхуки
75. [official] Agent Identity overview (SPIFFE, X.509 24 ч, auth manager) — https://docs.cloud.google.com/iam/docs/agent-identity-overview
76. [official] Authentication for push subscriptions (OIDC JWT, audience, `getOpenIdToken`) — https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions

### Инциденты
77. [secondary] GhostToken — Astrix Security — https://astrix.security/learn/blog/ghosttoken-exploiting-gcp-application-infrastructure-to-create-invisible-unremovable-trojan-app-on-google-accounts/
78. [secondary] GhostToken — The Hacker News / BleepingComputer — https://thehackernews.com/2023/04/ghosttoken-flaw-could-let-attackers.html
79. [secondary] DeleFriend — Hunters Security — https://www.hunters.security/en/blog/delefriend-a-newly-discovered-design-flaw-in-domain-wide-delegation-could-leave-google-workspace-vulnerable-for-takeover
80. [secondary] MultiLogin / регенерация cookie — CloudSEK — https://www.cloudsek.com/blog/compromising-google-accounts-malwares-exploiting-undocumented-oauth2-functionality-for-session-hijacking
81. [secondary] «Millions at risk due to Google's OAuth flaw» — Truffle Security — https://trufflesecurity.com/blog/millions-at-risk-due-to-google-s-oauth-flaw
82. [secondary] Google Docs OAuth worm 2017 — Threatpost / Auth0 — https://threatpost.com/1-million-gmail-users-impacted-by-google-docs-phishing-attack/125436/
83. [official] Security Command Center — Initial Access: Leaked Service Account Key Used — https://docs.cloud.google.com/security-command-center/docs/findings/threats/leaked-sa-key-used
