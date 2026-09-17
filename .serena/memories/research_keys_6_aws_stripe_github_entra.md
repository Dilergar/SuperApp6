# Бенчмарк `core/keys`: AWS · Stripe · GitHub · Microsoft Entra/Azure

**Дата исследования:** 2026-09-13
**Метод:** только внешние источники (WebSearch/WebFetch), приоритет — официальная документация вендоров и официальные security-advisory. Локальный репозиторий не читался.
**Маркировка достоверности:** каждый факт в §8 помечен `[official]` (первоисточник вендора/госоргана), `[secondary]` (пресса, блоги третьих лиц), `[inference]` (мой вывод, не утверждение источника). В тексте спорные/непроверенные места помечены **⚠ НЕ ПОДТВЕРЖДЕНО**.

---

## 1. Executive summary (20 пунктов)

1. **Все четыре гиганта сходятся в одном: долгоживущий bearer-секрет — это долг, а не фича.** AWS прямо пишет «(Not recommended) Use long-term credentials»; Microsoft рекомендует «secretless» (managed identity / federated credential); GitHub рекомендует GitHub Apps вместо OAuth Apps именно потому, что у Apps токены короткоживущие; Stripe рекомендует RAK вместо `sk_`.
2. **Префикс + контрольная сумма в теле секрета — индустриальный стандарт де-факто.** GitHub (2021) перевёл все токены на `ghp_/gho_/ghu_/ghs_/ghr_/github_pat_` + CRC32 в base62 (последние 6 символов) — false-positive rate secret-scanning упал до ~0.5%. AWS: `AKIA` (долгоживущий) vs `ASIA` (STS). Stripe: `sk_/pk_/rk_/whsec_` + `live/test`.
3. **Один и тот же префикс должен различать «этот ключ вечный» и «этот ключ временный»** — AWS `AKIA` vs `ASIA` даёт это бесплатно в логах и в grep.
4. **«Ровно два ключа на субъект» — это не ограничение, а механизм ротации без простоя** (AWS: максимум 2 access key на IAM-пользователя; у Entra `keyCredentials` — multi-valued по той же причине).
5. **Ротация с перекрытием (grace) — обязательна.** Stripe: при rotate старый и новый ключ живут **до 7 дней**; webhook-секрет — **до 24 часов**, и Stripe в это время шлёт **по одной подписи на каждый активный секрет** в одном заголовке.
6. **`last used` — это продукт, а не лог.** AWS хранит `access_key_N_last_used_date/_region/_service` (гранулярность 15 минут) и отдаёт их в credential report (не чаще раза в 4 часа); Stripe показывает request logs на ключ; GitHub — «last used» у PAT и автоотзыв неиспользуемого год токена.
7. **Автоматический отзыв по неиспользованию** — у GitHub это правило платформы: OAuth-токен или PAT, не использованный год, **отзывается автоматически**.
8. **Утечка → автоматический отзыв.** GitHub автоматически отзывает свой токен, запушенный в публичный репозиторий. Stripe: «If Stripe detects an exposed key, we notify you… In some cases, Stripe deactivates the key proactively». AWS: при сигнале от GitHub вешает на IAM-пользователя managed-policy `AWSCompromisedKeyQuarantineV*` (deny на ~30 высокорисковых действий) `[secondary]`.
9. **Push protection дешевле отзыва.** GitHub блокирует push с секретом до попадания в историю; для публичных репозиториев у пользователей это включено по умолчанию.
10. **Scope — это матрица «ресурс × (none|read|write)», а не список строк.** Stripe RAK: по каждому ресурсу None/Read/Write, write ⊃ read. GitHub fine-grained PAT: владелец ресурса + выбор репозиториев + permission per resource. Это ровно то, что ложится на ReBAC-модель SuperApp6.
11. **Сетевая привязка ключа вытесняет «IP allowlist».** Stripe в 2025+ заменил IP-ограничения на **access policies**: IPv4/CIDR ИЛИ «advanced» (разрешённые ASN, разрешённые страны, блок anonymous VPN / public proxy / residential proxy / Tor exit).
12. **Подпись запроса (SigV4) ≠ bearer.** Секрет никогда не уходит в провод: ключ подписи выводится цепочкой HMAC `kSecret→kDate→kRegion→kService→kSigning`, подписывается канонический запрос + timestamp; окно валидности ~15 минут. Это единственная схема из четырёх, где перехват трафика не даёт credential.
13. **Webhook-подпись: `HMAC-SHA256(secret, "{timestamp}.{raw_body}")`, заголовок `t=…,v1=…`, толерантность по умолчанию 5 минут, сравнение constant-time, схемы кроме `v1` игнорировать (downgrade-атака).** Это готовый чертёж для `core/keys` (C).
14. **Envelope encryption + encryption context как AAD — канон AWS KMS.** Encryption context не секретен, пишется в CloudTrail, криптографически связан с шифротекстом, и его же можно использовать как условие в политике (`kms:EncryptionContext:<key>`). Для SuperApp6 это готовый способ привязать шифротекст к `workspace_id`/`user_id`.
15. **Ротация KMS-ключа меняет только «текущий материал», key id остаётся.** Старый материал хранится вечно (для дешифровки), выбор версии при decrypt — автоматический. Дефолт 365 дней, период настраиваемый; on-demand ротация есть. Иерархия: domain key (ротация **ежедневно**) → HSM backing key (ротация **ежегодно**) → derived encryption key (одноразовый) → customer data key.
16. **Удаление ключа — только через окно ожидания 7–30 дней (дефолт 30)**, ключ в статусе `Pending deletion` не участвует в крипто-операциях и не ротируется. Azure — тот же принцип: soft-delete 7–90 дней (дефолт 90, задаётся **только при создании** и потом неизменяем), purge protection выключена по умолчанию и **необратима после включения**.
17. **Делегирование «AI-агент от имени человека» уже стандартизировано** — OAuth 2.0 On-Behalf-Of у Microsoft: middle-tier меняет токен пользователя на токен к downstream API; работает **только для user principal**, только по **delegated scopes**, application roles не переносятся, приложение с собственным signing key в OBO участвовать не может.
18. **Отзыв в реальном времени решается не коротким TTL, а «разговором» между issuer и resource server.** Microsoft CAE: токен живёт **до 28 часов**, но критические события (удаление/отключение аккаунта, смена пароля, включение MFA, revoke-all, высокий риск) прилетают подписчику, а клиент получает `401 + claims challenge`. Заявленная задержка — «near real time», до 15 минут; IP-enforcement — мгновенный.
19. **Инциденты гигантов дают три повторяющихся урока:** (a) ключ подписи из 2016 года жил до 2023 — **не было автоматической ротации** (Storm-0558); (b) валидацию issuer/scope нельзя оставлять «на усмотрение разработчика» — Azure AD SDK не валидировал issuer автоматически, и consumer-ключ подписал enterprise-токен; (c) забытое тестовое приложение с высокими правами = полный доступ (Midnight Blizzard: legacy test OAuth app → `full_access_as_app` в Exchange Online).
20. **Реакция Microsoft на (19) — ровно та архитектура, которую стоит закладывать сразу:** подписные ключи Entra ID и MSA генерируются, хранятся и **автоматически ротируются** в Azure Managed HSM; ~90% токенов валидируются одним «hardened identity SDK»; удалено 730 000 неиспользуемых приложений и 5,75 млн неактивных тенантов.

---

## 2. Находки по вендорам

### 2.1 AWS

#### 2.1.1 IAM access keys — форматы и лимиты

| Факт | Значение | Источник |
|---|---|---|
| Префикс долгоживущего ключа | `AKIA…` (пример `AKIAIOSFODNN7EXAMPLE`) | [official] IAM UG, reference_identifiers |
| Префикс временного (STS) ключа | `ASIA…` — «unique only in combination with the secret access key and the session token» | [official] там же |
| Прочие префиксы | `AIDA` (IAM user), `AROA` (role), `AGPA` (group), `AIPA` (EC2 instance profile), `ANPA` (managed policy), `ANVA` (версия политики), `APKA` (public key), `ASCA` (certificate), `ABIA` (STS bearer token), `ACCA` (context-specific credential) | [official] |
| Максимум ключей на IAM-пользователя | **2** («You can have a maximum of two access keys per user») — именно чтобы ротировать без простоя | [official] |
| Secret access key | Показывается **один раз** при создании, восстановить нельзя — только удалить и создать новый | [official] |
| Пример секрета | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` (40 символов base64-подобных) | [official] |
| Формулировка AWS | «IAM users with access keys are an account security risk», «Do NOT use your account's root credentials to create access keys» | [official] |

**Root-user ключи.** Полного запрета на создание root access keys нет; AWS настойчиво не рекомендует. Новые member-аккаунты в AWS Organizations **создаются вообще без root-креденшелов**, и есть централизованное управление root-доступом. `[secondary]` — из поисковой выдачи по docs.aws.amazon.com; прямую страницу `id_root-user_manage_add-key.html` я не открывал. **⚠ Требует перепроверки, если это важно для решения.**

#### 2.1.2 Альтернативы долгоживущим ключам (доктрина AWS)

AWS явно перечисляет (страница «Programmatic access with AWS security credentials»):
- не встраивать ключи в код → Secrets Manager;
- IAM roles → временные креды всегда, когда возможно;
- вне AWS → **IAM Roles Anywhere**;
- для людей → IAM Identity Center (permission sets), не access keys;
- внутри AWS compute → instance profile / роль, а не сохранённый ключ.

**EKS Pod Identity** (новее, чем IRSA): связка «IAM role ↔ Kubernetes service account» без OIDC-провайдера; credentials выдаёт DaemonSet-агент на ноде по link-local адресу `169.254.170.23`; trust policy роли — один принципал `pods.eks.amazonaws.com` для всех кластеров; лимит 5000 association на кластер. Мотивация — least privilege + credential isolation (контейнер не видит кредов других подов, если IMDS ограничен) + масштабируемость (assume делает EKS Auth один раз на ноду, а не каждый SDK в каждом поде). `[official]`

#### 2.1.3 STS — временные креды

- `AssumeRole.DurationSeconds`: **мин 900 с (15 мин), макс 43200 с (12 ч)**, но не выше `MaxSessionDuration` роли (её можно задать от 1 до 12 часов). **Default 3600 с.** `[official]`
- **Role chaining ограничивает сессию 1 часом**: «if you assume a role using role chaining and provide a DurationSeconds parameter value greater than one hour, the operation fails». `[official]`
- Session policies: inline + до **10 managed policy ARNs**, суммарный plaintext ≤ **2048 символов**; результирующие права = пересечение identity-based policy роли и session policy — **повысить права нельзя**. `[official]`
- `PackedPolicySize` — процент от лимита упакованного бинарного представления (policy + session tags); >100% → `PackedPolicyTooLarge`. `[official]`
- Session tags: до **50**, ключ ≤128, значение ≤256; transitive tags переживают role chaining. `[official]`
- `SourceIdentity` переживает цепочку ролей и используется в CloudTrail, чтобы понять «кто на самом деле» — прямой аналог нужного нам «AI-агент действует от имени user_id». `[official]`
- `ExternalId` (2–1224 символа) — защита от confused deputy при кросс-аккаунтном доступе. `[official]`
- MFA в `AssumeRole`: `SerialNumber` + `TokenCode` (ровно 6 цифр) — step-up встроен в выдачу временных кредов. `[official]`

#### 2.1.4 IAM Roles Anywhere (X.509 для нагрузок вне AWS)

- **Trust anchor** = ссылка на AWS Private CA или внешний CA-сертификат. Нагрузка предъявляет X.509, выпущенный доверенным CA, и получает временные креды.
- **Profile** = «какие роли можно принять» + **одна** session policy на профиль (может быть managed или inline).
- Роль должна доверять service principal Roles Anywhere; связь с trust anchor — через `aws:SourceArn` в trust policy.
- **Граница доверия — аккаунт**: «Certificates issued by any trust anchor in the account can be used to assume any target role in that same account, unless you specify conditions in the role's trust policy». Это важная ловушка: без явных условий любой trust anchor открывает любую роль аккаунта.
- Нет автоматической интеграции с org-wide контролями. `[official]`

#### 2.1.5 KMS

**Иерархия ключей (из «Cryptographic Details» / concepts):** `[official]`

| Ключ | Что | Ротация |
|---|---|---|
| Domain key | 256-бит AES-GCM, только в памяти HSM, оборачивает версии KMS-ключа | **ежедневно** (иногда до еженедельно) |
| HSM backing key (HBK) | 256-бит симметричный / RSA / EC private; составляет KMS key | **ежегодно** (опционально) |
| Derived encryption key | 256-бит AES-GCM, выводится из HBK на **каждое** шифрование | одноразовый |
| Customer data key (CDK) | то, что отдаётся наружу в plaintext+ciphertext | управляет приложение |

**Ротация:** `[official]`
- Автоматическая ротация — только для **symmetric encryption KMS keys с origin `AWS_KMS`**; дефолтный `RotationPeriodInDays` = **365**; период настраивается; есть condition key `kms:RotationPeriodInDays`.
- On-demand ротация поддержана и для `EXTERNAL` origin.
- **Не ротируются автоматически:** asymmetric, HMAC, ключи в custom key stores — только «ручная ротация» (новый ключ + alias).
- AWS managed keys ротируются принудительно раз в год (с мая 2022; до этого — раз в 3 года).
- Ротация **не меняет key id**; старый материал хранится, пока ключ не удалён; decrypt сам выбирает нужную версию.
- Ротация **не перешифровывает данные** и **не спасает от скомпрометированного data key**.
- Биллинг: плата берётся за 1-ю и 2-ю ротацию, дальше — нет.
- События: `KMS CMK Rotation` в EventBridge + `RotateKey` в CloudTrail; `ListKeyRotations` / `GetKeyRotationStatus`.

**Удаление:** окно ожидания **7–30 дней, дефолт 30**; фактическая дата может быть на сутки позже; в состоянии `Pending deletion` ключ не используется и не ротируется; можно повесить CloudWatch alarm на попытки использования. Для asymmetric-ключей отдельная опасность: публичный ключ вне KMS продолжает шифровать, и эти шифротексты станут нерасшифруемыми. `[official]`

**Encryption context = AAD:** необязательный набор **несекретных** key-value; криптографически связан с шифротекстом (тот же контекст обязателен при decrypt); **пишется в CloudTrail открытым текстом**; используется как grant constraint (`EncryptionContextEquals` / `EncryptionContextSubset`) и как policy condition. Рекомендация AWS — хранить рядом с шифротекстом только фрагмент, из которого контекст реконструируется. `[official]`

**Grants:** третий механизм авторизации наряду с key policy и IAM policy; один grant = один KMS key, только allow, только из фиксированного списка операций; **лимит 50 000 grants на ключ**; eventual consistency лечится **grant token** (несекретная base64-строка, действует пока grant не разошёлся, обычно <5 мин); удаление — `retire` (делает принципал из grant) или `revoke` (делает админ ключа). `[official]`

**FIPS:** AWS KMS HSM — **FIPS 140-3 Level 3** (страница AWS Compliance/FIPS подтверждает уровень; дата сертификации ~20 февраля 2025 — `[secondary]`, из AWS Security Blog через поиск). Ранее: FIPS 140-2 Level 3 c мая 2023. AWS CloudHSM — FIPS 140-3 Level 3 на `hsm2m.medium`; сертификат `hsm1.medium` переведён в historical list 4 января 2026. `[official]` (compliance/fips) + `[secondary]` (даты).

#### 2.1.6 Secrets Manager

- Секрет = значение + метаданные (ARN с **6 случайными символами в конце**, чтобы пересоздание секрета с тем же именем дало другой ARN и не унаследовало права). `[official]`
- **Версии и staging labels:** `AWSCURRENT` (всегда ровно одна, возвращается по умолчанию), `AWSPREVIOUS`, `AWSPENDING` (во время ротации). Свои метки тоже можно: до **20 меток** на секрет, одна метка не может быть на двух версиях, у версии может быть несколько меток. **Версии без меток считаются deprecated; Secrets Manager удаляет их, когда их больше 100, и не трогает версии моложе 24 часов.** `[official]`
- **Ротация Lambda'ой — 4 шага:** `create_secret` → `set_secret` → `test_secret` → `finish_secret`; в вызов передаются `SecretId`, `ClientRequestToken` (идемпотентность), `RotationToken` (для cross-account/assumed-role). При падении любого шага повторяется **вся** ротация. `[official]`
- **Managed rotation** (Aurora, RDS, DocumentDB, Redshift, ECS Service Connect TLS, partner secrets): без Lambda, обычно <1 минуты; расписание `rate()`/`cron()`, минимум **раз в 4 часа**, окно ротации задаётся `Duration`. Во время ротации новые соединения могут получить предыдущую версию — отсюда рекомендация alternating-users. `[official]`

#### 2.1.7 Подпись запросов — SigV4

- Канонический запрос: `METHOD\nURI\nQUERY\nCANONICAL_HEADERS\nSIGNED_HEADERS\nHASHED_PAYLOAD`. `[official]`
- String to sign: `AWS4-HMAC-SHA256\n{ISO8601 UTC}\n{YYYYMMDD/region/service/aws4_request}\n{hex(sha256(canonical_request))}`. `[official]`
- Цепочка вывода ключа: `kDate = HMAC("AWS4"+secret, YYYYMMDD)` → `kRegion` → `kService` → `kSigning = HMAC(kService, "aws4_request")`. **Секрет никогда не передаётся**; подписной ключ ограничен датой, регионом и сервисом. `[official]`
- Временные креды добавляют `X-Amz-Security-Token`. `[official]`
- Явный запрет подписывать hop-by-hop заголовки (`connection`, `user-agent`, `transfer-encoding`, `proxy-*` …) — иначе прокси ломают подпись. `[official]`
- SigV4a (multi-region): ECDSA P-256, из secret выводится **пара ключей**, регион выносится в `X-Amz-Region-Set` и не входит в credential scope. `[official]`
- Окно валидности подписанного запроса — **15 минут**; presigned URL — максимум **7 дней** (`X-Amz-Expires` ≤ 604800). `[official]` (S3 API docs; **⚠ прочитано через суммаризатор, дословная цитата не зафиксирована**).

#### 2.1.8 Аудит и «мёртвые» ключи

- **Credential report:** CSV, генерируется **не чаще раза в 4 часа**; колонки включают `access_key_1_active`, `access_key_1_last_rotated`, `access_key_1_last_used_date/_region/_service`, то же для ключа 2, `cert_1/2_*`, `mfa_active`, `password_*`. Гранулярность «last used» — **первое использование в 15-минутном окне**. Отчёт покрывает только первые два ключа пользователя; всё остальное — через `ListAccessKeys` / `ListServiceSpecificCredentials`. `[official]`
- **IAM Access Analyzer, unused access analyzer:** непрерывно мониторит все роли и пользователей организации, генерирует findings на **неиспользуемые роли, неиспользуемые access keys, неиспользуемые пароли**, и для активных — на неиспользуемые сервисы/действия. Тарифицируется по числу проанализированных ролей/пользователей. Есть также external access (логическое доказательство по resource-based политикам) и internal access analyzers, policy validation, custom policy checks, генерация политики по CloudTrail. `[official]`

#### 2.1.9 Устройства / IoT

- **X.509 client certificates:** сертификат должен быть зарегистрирован, в статусе `ACTIVE`, и не истёкшим; обязателен SNI; рекомендация — **уникальный сертификат на устройство** (иначе нет гранулярного отзыва); поддерживаются RSA ≥2048 и EC P-256/384/521; сертификаты, выпущенные самим AWS IoT, истекают **31.12.2049**. Multi-account registration позволяет перенести устройство между аккаунтами по SNI. `[official]`
- **Fleet provisioning by claim:** на устройстве зашит *provisioning claim* сертификат с политикой, разрешающей только темы `$aws/certificates/create/*` и `$aws/provisioning-templates/<T>/provision/*`. Устройство меняет его на постоянный (`CreateKeysAndCertificate` или `CreateCertificateFromCsr` + `RegisterThing`), после чего **обязано переподключиться** уже постоянным. `certificateOwnershipToken` живёт **1 час**; если за это время сертификат не привязан — он удаляется. `[official]`
- **Fleet provisioning by trusted user:** мобильное приложение монтажника вызывает `CreateProvisioningClaim`, получает **временный** claim-сертификат с TTL **5 минут**, который не появляется в списке сертификатов аккаунта. `[official]`
- **Pre-provisioning hook** (Lambda) может отклонить регистрацию (`allowProvisioning:false`) — «белый список серийников» на стороне облака. `[official]`

---

### 2.2 Stripe

#### 2.2.1 Типы ключей и префиксы `[official]`

| Тип | Префикс | Можно ли публиковать | Комментарий |
|---|---|---|---|
| Publishable | `pk_live_` / `pk_test_` | **Да** | Для Stripe.js/Elements/мобильных SDK; нельзя expire |
| Restricted (RAK) | `rk_live_` / `rk_test_` | Нет | Права по ресурсам, **рекомендуемый по умолчанию** |
| Secret | `sk_live_` / `sk_test_` | Нет | Полный доступ; Stripe: «we don't recommend using secret keys for new use cases» |
| Organization | `sk_org_…` | Нет | Уровень организации (много Stripe-аккаунтов) |
| Managed | — | Нет | Выдаёт и ротирует хостинг-платформа; Dashboard показывает, но не раскрывает |
| Webhook signing secret | `whsec_` | Нет | **Не API-ключ**; свой на каждый endpoint, разный для test/live |

Sandbox-ключи используют те же `*_test_` префиксы. Sandbox — изолированное окружение; для новых интеграций Stripe советует именно отдельный general sandbox, а не test-mode аккаунта.

#### 2.2.2 Restricted API keys — модель прав `[official]`

- По каждому ресурсу Stripe API выбирается **None / Read / Write**; дефолт всех — **None**. **Write включает Read.**
- Отдельно настраивается разрешение для доступа к connected accounts (Connect).
- Маппинг для аудита прав: `GET` → read, `POST`/`DELETE` → write.
- Предусмотрен «клонировать ключ» (Duplicate key) — новый ключ наследует permission-матрицу.
- Рекомендация: **один RAK на сервис/сценарий** (billing-service, reporting-service, webhook-handler).
- Отдельная явная рекомендация: «Stripe recommends always using RAKs instead of unrestricted secret keys, **especially when giving a key to an AI agent**».
- Методика миграции с `sk_` на `rk_`: прочитать request logs старого ключа → собрать список ресурсов → выдать RAK в sandbox → гонять тесты → смотреть `403 ERR` в логах ключа → сузить.

#### 2.2.3 Жизненный цикл ключа `[official]`

- **Show-once:** live-mode secret/RAK показывается один раз. Раскрыть повторно можно **только те ключи, которые создал сам Stripe** (дефолтный secret key или ключ, созданный плановой ротацией). Созданный вручную — нельзя.
- **Sandbox:** там все ключи видно всегда.
- **Создание secret key требует 2FA-кода** (email/SMS), создание RAK — «two-factor verification».
- **Note-поле:** Stripe просит записать, *где* вы сохранили ключ (в vault) — UX-приём, который убирает «ключ потерялся».
- **Rotate:** выдаёт замену, старый умирает по расписанию. **Grace до 7 дней** («both the old and new keys work for up to 7 days»). Можно `Now` (мгновенное удаление). Плановая ротация по расписанию тоже есть.
- Рекомендуемый порядок отключения старого ключа: смотреть request logs и гасить только после того, как объём запросов старым ключом держится на нуле «a few hours or days».
- **Expire key:** явное «убить сейчас»; publishable нельзя.
- **Limited access:** если ключом >180 дней не создавали transfers/payouts и не меняли payout destination — ключ **автоматически теряет** эти права; нужно явное «Restore access». Это очень дешёвый и очень сильный приём: «спящие деньги-права отмирают сами».
- **View request logs** на каждый ключ — прямо из списка ключей.

#### 2.2.4 Access policies (замена IP allowlist) `[official]`

- Два типа: **IP addresses** (IPv4/CIDR) и **Advanced** (ASN allow, страны allow, блок источников: anonymous VPN, public proxy, residential proxy, Tor exit nodes).
- Правила комбинируются по **AND**.
- Политика привязывается к ключу; изменение политики применяется **немедленно ко всем ключам**, где она назначена; удаление политики — ключи снова открыты отовсюду.
- Stripe рекомендует вешать access policy **на все live-ключи** — «That notifies you of any unauthorized access, so you can rotate the keys accordingly»: политика тут не только защита, но и **детектор компрометации**.
- Документация прямо говорит: «Access policies have replaced IP address restrictions. Use policies, not restrictions».

#### 2.2.5 Webhooks (то, что напрямую ложится на §C задачи) `[official]`

- Заголовок: `Stripe-Signature: t=1492774577,v1=<hex>,v0=<hex>` — одна строка, без переносов.
- `signed_payload = "{t}" + "." + raw_body`; `expected = HMAC-SHA256(endpoint_secret, signed_payload)`, hex.
- **Игнорировать все схемы, кроме `v1`** — иначе downgrade-атака (`v0` Stripe шлёт только для тестовых событий).
- **Сравнение constant-time.**
- **Толерантность по умолчанию 5 минут**; «Don't use a tolerance value of 0» (это выключает проверку свежести, а не ужесточает её).
- При retry Stripe **генерирует новую подпись и новый timestamp**.
- **Roll secret:** старый секрет можно оставить живым **до 24 часов**; в это время у endpoint несколько активных секретов и **Stripe кладёт по одной подписи `v1=` на каждый** в тот же заголовок.
- Двойная защита: подпись **плюс** IP-allowlist (Stripe публикует список своих исходящих IP).
- Доставка: до **16 endpoints**; только HTTPS в live; только TLS 1.2/1.3; редиректы 3xx считаются провалом; ретраи с экспоненциальным backoff **до 3 суток** в live (в sandbox — 3 попытки за несколько часов); **порядок событий не гарантируется**; дедуп — по `event.id` (не по `created`); ручной resend — 15 дней из Dashboard, 30 дней из CLI.
- Версия payload фиксируется **версией API аккаунта на момент события** (или версией, заданной при создании endpoint) и задним числом не меняется.

#### 2.2.6 Идемпотентность `[official]`

- Заголовок `Idempotency-Key`, до **255 символов**, рекомендация — UUIDv4; **не класть туда PII**.
- Сохраняется статус-код и тело **первого** ответа, включая `500`.
- Ключи вычищаются после **≥24 часов**; повтор после вычистки создаст новый запрос.
- Повтор с тем же ключом, но другими параметрами → ошибка.
- Результат не сохраняется, если запрос упал на валидации или конфликтует с параллельным — такие можно ретраить.
- Только `POST`; `GET`/`DELETE` идемпотентны по определению.

#### 2.2.7 Мультиарендность и приложения `[official]`

- **Connect:** заголовок `Stripe-Account: acct_…` поверх ключа платформы — один ключ, много арендаторов. Клиентские SDK принимают `stripeAccount` параметром.
- **Организации:** `sk_org_…` работает над несколькими Stripe-аккаунтами; в webhook-событиях приходит `context`, по которому продюсер выбирает нужный ключ/контекст (`Stripe-Context` заголовок).
- **Stripe Apps, два режима авторизации:**
  - **OAuth** (`stripe_api_access_type: oauth`): authorization code **одноразовый и живёт 5 минут**; **access token 1 час**, **refresh token 1 год**, refresh token **роллируется при каждом обмене** (старый умирает). Обмен делается секретным ключом разработчика. `state` обязателен по best practice (CSRF). Redirect URIs — белый список в манифесте, live обязан быть HTTPS.
  - **RAK auth** (`restricted_api_key`): при установке приложения генерируется RAK **ровно с правами из манифеста**; пользователь копирует его на сайт партнёра. Плюс: drop-in замена `sk_`. Минус: требует ручного шага пользователя и ломает часть UI-расширений. **Режим авторизации нельзя поменять после загрузки приложения.**

#### 2.2.8 Best practices, которые Stripe формулирует явно `[official]`

- Секреты — в vault (AWS Secrets Manager / GCP Secret Manager / Azure Key Vault / HashiCorp Vault), не в env, если есть выбор.
- Периодический греп по кодовой базе и CI на `sk_live_` и `rk_live_`; **pre-commit hook, отклоняющий коммит** по этим паттернам.
- Разделять «exposure» (секрет засветился) и «compromise» (есть следы использования) — **но ротировать в обоих случаях**.
- «Stripe never asks you for your secret API key».
- Stripe детектит утёкшие ключи и **может деактивировать ключ проактивно**, уведомив владельца; гарантии детекта нет.

---

### 2.3 GitHub

#### 2.3.1 Форматы токенов (редизайн 2021) `[official]`

- Префиксы: `ghp_` (PAT classic), `gho_` (OAuth access token), `ghu_` (user-to-server), `ghs_` (server-to-server / installation), `ghr_` (refresh token); позже добавились `github_pat_` (fine-grained PAT) и `github_app_` (app installation access token).
- Схема префикса: «сигнатура компании `gh` + первая буква типа токена + `_`».
- **Контрольная сумма:** 32-битная CRC32, закодированная base62, занимает **последние 6 символов** — позволяет проверять токен **офлайн**, без обращения к БД, сводя false positives «почти к нулю».
- Мотивация редизайна: старый формат — 40 hex-символов, **неотличим от SHA-хеша**, из-за чего secret scanning плохо работал.
- Энтропия не снизилась, а выросла: OAuth-токены с 160 до **178 бит**.
- Подчёркнутая деталь: `_` — **не символ base64**, значит префикс не может случайно возникнуть внутри закодированных данных, и двойной клик выделяет токен целиком.
- Заявленный эффект: «false positive rate for secret scanning will be down to 0.5%».
- Дата: 5 апреля 2021 (обновление 10 мая 2023).

#### 2.3.2 Новый stateless-формат installation token (2026) `[official]`

- С **27 апреля 2026** GitHub поэтапно переводит installation tokens на **stateless** формат: `ghs_APPID_JWT` — `ghs_`-префиксный JWT длиной **~520 символов**, содержащий **две точки**.
- Мотив: «token issuance performance under increased load… higher reliability at scale».
- JWT подписан внутренне, **клиент не должен его валидировать** — токен по-прежнему opaque для потребителя.
- Ломающие допущения: регулярки вида `ghs_[A-Za-z0-9]{36}` и колонки БД под 40 символов. Рекомендованная регулярка `ghs_[A-Za-z0-9\.\-_]{36,}` `[secondary]`; колонка ≥520 символов `[official]`.
- Тестовый переключатель: заголовок `X-GitHub-Stateless-S2S-Token` на `POST /app/installations/:id/access_tokens` переопределяет rollout для одного запроса `[secondary]`.
- Только GitHub Enterprise Cloud и Data Residency; GHES пока не затронут.

> **Урок для `core/keys`:** если вы вводите формат токена — сразу закладывайте (а) переменную длину, (б) «токен непрозрачен для потребителя», (в) документируйте регулярку для сканеров. GitHub наступил на собственную фиксированную длину спустя 5 лет.

#### 2.3.3 Fine-grained PAT vs classic PAT `[official]`

| | Fine-grained PAT | Classic PAT |
|---|---|---|
| Префикс | `github_pat_` | `ghp_` |
| Владелец ресурса | **Один** user или организация | Все организации, к которым есть доступ, + личные репозитории |
| Права | Гранулярные permissions по ресурсам + явный выбор репозиториев | Широкие scopes (`repo` даёт и чтение, и запись) |
| Expiration | **Требуется**, дефолт 30 дней (или меньше, если политика организации) | Дефолт 30 дней; expiration не обязателен |
| Одобрение организацией | Может требоваться (owner approve) | Не подчиняется approval-политике |
| Автоудаление | — | GitHub удаляет неиспользуемые токены через год |

**Организационные политики PAT:** `[official]`
- Доступ: «Restrict access» / «Allow access» — раздельно для fine-grained и classic (по умолчанию оба разрешены). Публичные ресурсы доступны в любом случае.
- **Maximum lifetime:** для fine-grained дефолтный максимум **366 дней**, настраивается. Для classic принудительного expiration нет. Нарушающие политику токены **не отзываются**, но им отказывают в доступе к API.
- **Approval:** «Require approval» — дефолт; одобряют **только owner'ы организации**; токены самих owner'ов не требуют одобрения.

**Ограничения fine-grained PAT** (важно как предупреждение): не может контрибьютить в публичные репозитории, где пользователь не участник; не работает для outside collaborator; **не может обращаться к нескольким организациям одновременно**; нет доступа к Packages; нельзя вызывать Checks API; нет доступа к Projects личного аккаунта.

#### 2.3.4 GitHub Apps — эталон «приложение как субъект» `[official]`

Трёхуровневая схема:
1. **App JWT:** алгоритм **RS256**, приватный RSA-ключ в PEM; `iss` = client id / app id (по нему ищут публичный ключ); `exp` — **не более 10 минут вперёд**; `iat` рекомендуется сдвинуть **на 60 секунд назад** от clock drift. Используется только чтобы попросить installation token.
2. **Installation access token** (`ghs_`): живёт **1 час**; можно сузить на выдаче — параметры `repositories`/`repository_ids` (до **500** репозиториев) и `permissions` (подмножество прав установки; расширить выше установки нельзя).
3. **User access token** (`ghu_`): **8 часов**; refresh token (`ghr_`) — **6 месяцев**; после использования refresh-токена **и старый refresh, и старый access перестают работать** (rotation-on-use). Опция «User-to-server token expiration» включается в Optional Features, GitHub рекомендует включать.

**Почему GitHub Apps, а не OAuth Apps** (официальная формулировка): гранулярные permissions вместо широких scopes; **«OAuth app tokens do not expire until the person who authorized the OAuth app revokes the token»**; масштабируемые rate limits; приложение может действовать само по себе и явно помечает «от имени пользователя»; приложение **не привязано к личному аккаунту** и переживает уход сотрудника; установщик выбирает, к каким репозиториям есть доступ.

**Deploy keys:** SSH-ключ, привязанный **к одному репозиторию**; по умолчанию **read-only**; write-ключ даёт права, эквивалентные admin-коллаборатору; **нельзя переиспользовать один deploy key на несколько репозиториев**. Альтернативы — machine user (жрёт лицензию) или installation token (не жрёт лицензию, живёт 1 час, узко ограничен).

**API отзыва:** `POST /applications/{client_id}/token` — проверить токен без штрафа за неудачные логины; `PATCH …/token` — перевыпустить (эффект немедленный); `DELETE …/token` — отозвать один; `DELETE /applications/{client_id}/grant` — снести **весь** grant пользователя со всеми токенами.

**Sudo mode:** для чувствительных действий (смена email, авторизация стороннего приложения, добавление SSH-ключа, **создание PAT или приложения**) требуется повторная аутентификация; сессия sudo — **2 часа**, продлевается любым новым чувствительным действием; принимаются пароль, passkey, security key, GitHub Mobile, TOTP; **SMS-2FA для sudo не принимается**.

#### 2.3.5 Secret scanning `[official]`

- Сканируется **вся история git по всем веткам**, плюс описания и комментарии в issues, PR, Discussions, wiki и gists.
- Публичные репозитории и npm-пакеты сканируются на партнёрские паттерны **бесплатно для всех**.
- **Партнёрский алерт идёт напрямую провайдеру**, минуя владельца репозитория; провайдер сам решает — отозвать, перевыпустить или связаться с пользователем.
- Каталог поддерживаемых паттернов — порядка **179 провайдеров** (число из таблицы «supported secret scanning patterns»; **⚠ прочитано через суммаризатор, точную цифру стоит перепроверить**).
- **Validity checks** — опциональная проверка «а жив ли секрет» обращением к сервису-эмитенту, чтобы приоритизировать.
- **Push protection:** блокирует push с секретом *до* попадания в репозиторий; покрывает CLI-push, коммиты через UI, загрузку файлов, REST API и GitHub MCP server. Три причины обхода: «используется в тестах» / «ложное срабатывание» (алерт закрывается) / «починю потом» (алерт остаётся). По умолчанию обойти может **любой с write-доступом**; delegated bypass позволяет ограничить круг. На уровне репозитория выключена по умолчанию, **но для пользователей включена по умолчанию при push в публичные репозитории**.
- **Требования к провайдеру, чтобы вступить в партнёрскую программу** (бесплатно): дать регулярки; поднять webhook-приёмник алертов; **проверять подпись** входящего webhook; **реализовать отзыв секрета и уведомление пользователя** `[secondary]` (из docs через поиск, страница программы не открывалась дословно).

#### 2.3.6 Отзыв токенов — правила платформы `[official]`

Токен отзывается автоматически, если:
1. наступил срок expiration;
2. **валидный OAuth-токен, GitHub App token или PAT запушен в публичный репозиторий или публичный gist**;
3. OAuth-токен или PAT **не использовался год**;
4. отозвана авторизация OAuth-приложения (гибнут все его токены);
5. пользователь отозвал креды в настройках.

Дополнительно: есть **API отзыва скомпрометированных кредов, не требующий аутентификации** — любой может сообщить об утечке токена. Для приватных репозиториев в алерте secret scanning есть кнопка **Report leak**, после которой GitHub обращается с токеном как с публично утёкшим `[secondary]`.

#### 2.3.7 OIDC в Actions `[official]`

GitHub выдаёт JWT на каждый запуск workflow, обменивающийся у облачного провайдера на короткоживущие креды — «without having to store any credentials as long-lived GitHub secrets». Обязательно задать **хотя бы одно условие доверия**, иначе чужие репозитории смогут просить токены. Срок действия итоговых кредов определяет провайдер, не GitHub. (Формат subject-claim `repo:org/repo:ref:…` на прочитанной странице не приведён — **⚠ не подтверждено первоисточником в этом исследовании**.)

---

### 2.4 Microsoft Entra ID / Azure

#### 2.4.1 Учётные данные приложений и политика на них

- **Client secret:** максимальный срок жизни — **24 месяца**, задать больше нельзя; Microsoft рекомендует <12 месяцев и ротацию раз в 6 месяцев. `[secondary]` — Microsoft 365 Developer Blog «Client Secret expiration now limited to a maximum of two years» + Microsoft Q&A, страница не открывалась дословно. **⚠ Проверить перед цитированием.**
- **Application management policies** (Microsoft Graph, портального UI нет) — реальный механизм, официальная документация: `[official]`
  - `applicationRestrictions.passwordCredentials[]` с `restrictionType`: `passwordAddition`, `customPasswordAddition`, `symmetricKeyAddition`, плюс `passwordLifetime`, `symmetricKeyLifetime`;
  - `keyCredentials[]` с `restrictionType: asymmetricKeyLifetime`;
  - `maxLifetime` в ISO-8601 (`"P180D"`); `null` = без ограничения;
  - `restrictForAppsCreatedAfterDateTime` — **политика применяется только к приложениям, созданным после указанной даты** (ключевой приём: не ломать существующее, зажать новое; можно держать несколько политик с разными датами);
  - `isEnabled`; тенант-политика по умолчанию `isEnabled:false`, `id` = нулевой GUID, пока не создана реальная.
  - **Рекомендации Microsoft прямым текстом:** отключить client secrets вовсе; **отключить симметричные ключи**; ограничить срок жизни сертификата **180 днями**; настроить автоматическую ротацию через Key Vault.
- **Certificate credentials / client assertion (`private_key_jwt`)** — рекомендуемая замена секрету: `[official]`
  - header: `alg` = **PS256**, `typ` = JWT, `x5t#S256` = base64url SHA-256 отпечатка DER;
  - claims: `aud` = `https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token`, `iss` = `sub` = client id, `jti` (уникальный, коллизии недопустимы), `nbf`, `iat`, `exp`;
  - **«keep it short — 5-10 minutes after `nbf` at most»** (Entra сейчас не ограничивает `exp`, но так делать нельзя);
  - подпись — PSS padding;
  - `keyCredentials` — **multi-valued**, можно держать несколько сертификатов (ротация внахлёст);
  - в запросе: `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` + `client_assertion=<JWT>` вместо `client_secret`.
- **Workload identity federation (federated identity credentials)** — «ноль секретов»: `[official]`
  - доверие токенам внешнего IdP (GitHub Actions, любой Kubernetes — AKS/EKS/GKE/on-prem, Google Cloud, AWS через IAM Outbound Identity Federation, SPIFFE/SPIRE, Azure Pipelines);
  - вешается на app registration **или** на user-assigned managed identity;
  - `issuer`, `subject`, `audience` сравниваются **регистрозависимо** и должны совпасть точно;
  - **токены, выпущенные самим Entra ID, для federated-flow не годятся**;
  - Entra хранит **только первые 100 signing keys** из OIDC-эндпоинта внешнего IdP — больше ста ключей ломают сценарий;
  - лимит **20 FIC**, когда managed identity используется как credential у Entra-приложения.
- **Managed identities** — «credentials aren't even accessible to you»: `[official]`
  - system-assigned (жизненный цикл ресурса; удаляется вместе с ним; нельзя шарить) vs user-assigned (независимый ресурс, можно на много ресурсов) — **Microsoft рекомендует user-assigned**;
  - **token lifetime policy для managed identity сконфигурировать нельзя**;
  - Conditional Access **на managed identity не распространяется** (только access reviews).

#### 2.4.2 Время жизни токенов и отзыв

| Что | Значение | Источник |
|---|---|---|
| Access token по умолчанию | **случайно 60–90 минут** (в среднем 75), зависит от клиента/ресурса/наличия CA | `[official]` |
| Access token в CAE-сессии | **до 24–28 часов**; configurable token lifetime policy **не соблюдается** для CAE-сессий | `[official]` |
| ID token / SAML2 | 1 час (SAML — плюс clock skew 5 минут) | `[official]` |
| `AccessTokenLifetime` | мин `00:10:00`, макс `23:59:59`; управляет access, ID и SAML2 одновременно | `[official]` |
| Refresh token | **MaxInactiveTime 90 дней**, MaxAge — «Until-revoked»; **не настраивается с 30 января 2021** | `[official]` |
| Session token | non-persistent — 24 часа неактивности, persistent — 90 дней; при использовании окно продлевается | `[official]` |
| Приоритет политик | **организационная политика перекрывает прикладную** (контринтуитивно!) | `[official]` |

**CAE (Continuous Access Evaluation)** — стандарт OpenID CAEP: `[official]`
- Critical events (работают в любом тенанте, без Conditional Access): удаление/отключение аккаунта; смена/сброс пароля; включение MFA; **административный revoke всех refresh-токенов**; высокий user risk (Identity Protection).
- Conditional Access policy evaluation: ресурс-провайдер синхронизирует IP-based named locations и сам решает.
- Механика клиента: ресурс возвращает **401 + claims challenge**, клиент обязан **обойти кэш** и пойти за новым токеном.
- Заявленная скорость: «near real time», задержка до **15 минут** из-за распространения событий; **enforcement по IP — мгновенный**.
- Ограничения, о которых стоит знать заранее: изменения политик/членства в группах доезжают **до суток** (оптимизация до 2 часов); CAE видит **только IP-based named locations** (страны и MFA trusted IPs — нет); если суммарно в location-политиках **>5000 IP-диапазонов**, real-time location-enforcement отключается и выдаётся часовой токен; **гостевые аккаунты не поддерживаются**; включение пользователя после отключения доезжает 15 мин (SPO/Teams) и 35–40 мин (EXO).

**Token protection (token binding):** session control Conditional Access; принимаются только **device-bound** sign-in session tokens (PRT), криптографически привязанные к устройству при регистрации — украденный токен не работает с другой машины. GA для нативных приложений на Windows/iOS/macOS для Exchange Online, SharePoint Online, Teams (+ AVD/W365 на Windows); браузерные приложения — **preview**, только для Azure Resource Manager. `[official]`

#### 2.4.3 Делегирование (важно для AI-агентов, §F задачи)

**On-Behalf-Of flow** `[official]`:
- `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `requested_token_use=on_behalf_of`, `assertion=<входящий access token>`, плюс `client_secret` **или** `client_assertion`.
- Жёсткие правила, которые стоит скопировать дословно:
  - **только delegated scopes, никогда application roles** — «Roles remain attached to the principal (the user) and never to the application operating on the user's behalf… to prevent the user gaining permission to resources they shouldn't have access to»;
  - **`aud` входящего токена обязан быть равен `client_id` того, кто делает OBO** — чужой токен обменять нельзя, его надо отвергать;
  - **OBO работает только для user principal**; app-only токен так менять нельзя (для этого client credentials);
  - **SPA не делает OBO сам** — передаёт токен confidential middle-tier;
  - приложение с **custom signing key** (например, enterprise app с SSO) **не может быть middle-tier**: downstream не сможет проверить подпись, а токен, подписанный ключом клиента, принимать небезопасно;
  - id_token, полученный implicit-флоу у клиента с **wildcard reply URL**, для OBO не годится.
- **ЖИРНОЕ предупреждение Microsoft:** «DO NOT send access tokens that were issued to the middle tier to anywhere except the intended audience» — риски: перехват на скомпрометированном TLS, невозможность token binding и claim step-up, несовместимость с device-based политиками.
- Ошибку downstream-CA (`interaction_required` + `claims`) middle-tier обязан **пробросить клиенту** через `401` + `WWW-Authenticate`, а не ретраить кэшем.

**Consent** `[official]`:
- Три режима user consent: запретить полностью; `microsoft-user-default-low` (только приложения **verified publisher** или зарегистрированные в своём тенанте, и только permissions, классифицированные как low impact); `microsoft-user-default-legacy` (всё, что не требует admin consent).
- **Изменение политики согласия не отзывает уже выданные grants** — их надо ревьюить отдельно.
- **Admin consent workflow:** пользователь просит, назначенные reviewers видят запрос, у запроса настраиваемый срок жизни в днях, есть напоминания «скоро протухнет»; назначение reviewer'ом **не повышает прав** — одобрить может только тот, у кого и так есть право дать admin consent; для Microsoft Graph application permissions — **только Global Administrator**.
- Ловушка: новый reviewer **не увидит запросы, созданные до его назначения**, а снятый reviewer продолжит получать напоминания по старым.

**Conditional Access for workload identities** `[official]`:
- Применимо **только к single-tenant service principals своего тенанта**; multi-tenant и SaaS — нет; **managed identities — нет**.
- Условия: **исключительно** «вне известных публичных IP-диапазонов» и «риск по Identity Protection» (+ authentication context).
- Единственный доступный grant — **Block access**.
- **Политика, назначенная на группу, содержащую service principal, не работает** — SP надо назначать напрямую.
- Требует лицензии Workload Identities Premium.
- Microsoft честно перечисляет, почему workload identity опаснее пользователя: не может пройти MFA; часто нет формального lifecycle; обязан где-то хранить свой секрет.

**App instance property lock** — механизм защиты multi-tenant приложения от подмены credential'ов в чужом тенанте. **⚠ Страница `how-to-configure-app-instance-property-locks` вернула 404, факт не подтверждён первоисточником в этом исследовании.**

#### 2.4.4 Azure Key Vault / Managed HSM

| Параметр | Значение | Источник |
|---|---|---|
| Standard tier | софт-крипто, **FIPS 140 Level 1** | `[official]` |
| Premium tier | HSM-protected keys (RSA-HSM/EC-HSM/OCT-HSM), **FIPS 140-3 Level 3**, Marvell LiquidSecurity | `[official]` |
| Managed HSM | **single-tenant**, кластер партиций, **FIPS 140-3 Level 3**, своя **security domain** на клиента, **local RBAC** поверх Azure RBAC (даже владелец подписки не перебьёт), private endpoints, Secure Key Release по Azure Attestation | `[official]` |
| Авторизация Vault | Azure RBAC (и control, и data plane) **или** legacy access policies (только data plane) | `[official]` |
| Soft-delete | **on by default, выключить нельзя**; retention **7–90 дней, дефолт 90**; задаётся **только при создании** и потом неизменяем; имя vault нельзя переиспользовать до конца retention | `[official]` |
| Purge protection | **выключена по умолчанию**; включается только поверх soft-delete; **после включения purge невозможен до конца retention**; требуется большинством Azure-сервисов (Storage) | `[official]` |
| Purge-роль | `Key Vault Purge Operator` (или owner подписки) | `[official]` |
| Ловушка | При soft-delete vault **удаляются интегрированные вещи — RBAC-назначения и Event Grid подписки, и восстановление vault их НЕ возвращает** | `[official]` |
| Rotation policy | `lifetimeActions`: trigger `timeAfterCreate` (напр. `P18M`) или `timeBeforeExpiry`, action `Rotate`; отдельный action `Notify` с `timeBeforeExpiry` (напр. `P30D`) → событие Event Grid; `attributes.expiryTime` (напр. `P2Y`) | `[official]` |
| Минимальный интервал ротации | **7 дней** от создания и 7 дней от expiry | `[official]` |
| Роль для ротации | `Key Vault Crypto Officer` (при access policies — права `Rotate`, `Set Rotation Policy`, `Get Rotation Policy`) | `[official]` |
| Рекомендация | ротировать ключи шифрования **минимум раз в 2 года**; Azure Policy «Keys should have a rotation policy…» с параметром максимума дней | `[official]` |
| Ключевая семантика | Ротация создаёт **новую версию** ключа; потребители должны использовать **versionless key URI**, а данные — хранить **versioned URI**; ротация **re-wrap'ает DEK, но не перешифровывает данные**, поэтому **обе версии должны оставаться enabled** до завершения re-wrap; сервисы подхватывают новую версию **от часа до суток и более** | `[official]` |

#### 2.4.5 Azure IoT Hub DPS (устройства)

`[official]`
- Три механизма attestation: **X.509**, **TPM** (nonce-challenge по endorsement key, физический TPM не обязателен), **symmetric key** (SAS-токены с хешем и встроенным сроком).
- **Individual enrollment** — X.509 leaf или TPM SAS; **enrollment group** — X.509 (общий root/intermediate CA) или symmetric key (устройства предъявляют **SAS, выведенный из группового ключа**).
- Registration ID: у TPM даёт сам TPM; у X.509 — **subject CN сертификата**, отсюда ограничение **64 символа** (против 128 в symmetric key).
- `ID scope` — иммутабельный идентификатор экземпляра DPS, гарантирует уникальность при слияниях и переносах (и, обратная сторона, требует прошивки при переезде между DPS).
- Registration records можно удалить, но **нельзя обновить**.
- Microsoft настойчиво рекомендует HSM на устройстве: «Both X.509 certificates and SAS tokens can be stored in an HSM».

---

## 3. Сравнительная таблица

### 3.1 Типы и формат креденшелов

| | AWS | Stripe | GitHub | Entra/Azure |
|---|---|---|---|---|
| Долгоживущий ключ | `AKIA…` + 40-симв. secret | `sk_live_`, `rk_live_` | `ghp_`, `github_pat_` | client secret (≤24 мес) |
| Короткоживущий | `ASIA…` + session token (15 мин – 12 ч) | Stripe Apps access token (1 ч) | `ghs_` installation (1 ч), `ghu_` (8 ч) | access token 60–90 мин / 24–28 ч CAE |
| Публичный ключ | — | `pk_live_` | — | — |
| Webhook-секрет | — (EventBridge/SNS иначе) | `whsec_` | секрет per-webhook | — |
| Контрольная сумма в токене | нет | нет (есть префикс) | **CRC32/base62, 6 символов** | нет (JWT) |
| Асимметрия | SigV4 HMAC + Roles Anywhere X.509 | нет | App JWT RS256, deploy keys SSH | client assertion PS256, FIC |
| Ключ = bearer? | **нет** (подпись запроса) | да | да | да (+ token protection = device-bound) |

### 3.2 Ротация

| | AWS | Stripe | GitHub | Entra/Azure |
|---|---|---|---|---|
| Перекрытие при ротации | 2 ключа на пользователя | **до 7 дней** (API), **до 24 ч** (whsec) | новый токен + revoke старого | несколько `keyCredentials` |
| Автоматическая ротация | KMS (365 дн, настраиваемо) · Secrets Manager (Lambda/managed, ≥4 ч) | плановая ротация ключа | — (только expiry) | Key Vault rotation policy (мин 7 дней) · signing keys Entra/MSA — авто в Managed HSM |
| Версионирование | KMS: key id стабилен, материал версионируется · SM: `AWSCURRENT/PENDING/PREVIOUS` | ключ = новый объект | токен = новый объект | key version в URI |
| Мульти-подпись при ротации | — | **да**: по одной `v1=` на каждый активный секрет | — | несколько сертификатов |

### 3.3 Скоупинг

| | AWS | Stripe | GitHub | Entra |
|---|---|---|---|---|
| Модель | IAM policy + session policy (пересечение) + KMS grants | ресурс × {None, Read, Write} | permissions per resource + выбор репозиториев + resource owner | delegated scopes / app roles + consent |
| Привязка к арендатору | аккаунт / `ExternalId` | `Stripe-Account: acct_…` / `sk_org_` | organization как resource owner | tenant id |
| Нельзя повысить права | session policy ≤ роли | RAK ≤ аккаунта | installation token ≤ прав установки | OBO ≤ delegated scopes пользователя |
| Сетевые ограничения | IAM condition `aws:SourceIp` + CA for workload | **access policies**: IP/CIDR, ASN, страна, VPN/proxy/Tor | — | CA for workload identities (только IP + risk, только Block) |

### 3.4 Отзыв

| | AWS | Stripe | GitHub | Entra |
|---|---|---|---|---|
| Ручной | delete access key, revoke grant | Expire / Rotate(Now) | DELETE token / grant, «revoke all» | revoke refresh tokens |
| По утечке | quarantine policy `[secondary]` | проактивная деактивация | **автоотзыв при push в public** | — |
| По неиспользованию | Access Analyzer findings (не отзыв) | **limited access через 180 дней** для payouts | **автоотзыв через 1 год** | — |
| Near-real-time для живых сессий | нет (только TTL) | нет | нет | **CAE + claims challenge** |
| Каскад | — | — | revoke OAuth grant убивает все токены | tokenEpoch-аналог = revokeSignInSessions |

### 3.5 Хранение и детект утечек

| | AWS | Stripe | GitHub | Entra |
|---|---|---|---|---|
| Show once | да (secret access key) | да (live secret/RAK, кроме созданных Stripe) | да | да (client secret) |
| Хранение на стороне вендора | не разглашается | не разглашается | **«tokens… are not stored by GitHub in their original, usable formats»** | не разглашается |
| Собственный сканер утечек | через партнёрство с GitHub | да + партнёрство | **secret scanning + push protection** | credential scanning (после Storm-0558 усилен) |
| Аудит использования | CloudTrail (каждое использование KMS-ключа) + credential report + Access Analyzer | request logs на ключ | audit log, «last used» | Azure Monitor / sign-in logs (service principal sign-ins) |

---

## 4. Инциденты и уроки

### 4.1 Storm-0558 (Microsoft, 2023) — учебник по всем ошибкам key management сразу

**Факты из официального блога MSRC (сентябрь 2023):** `[official]`
- Апрель 2021: **падение consumer signing system** породило crash dump.
- **Race condition** позволил ключу подписи попасть в crash dump, хотя штатно он должен был быть вырезан.
- Crash dump, «believed at the time not to contain key material», был **перенесён из изолированной production-сети в debugging-окружение в корпоративной сети с выходом в интернет**.
- После апреля 2021 актор **скомпрометировал корпоративный аккаунт инженера Microsoft**, имевший доступ к этому окружению.
- **«Our credential scanning methods did not detect its presence»** — сканер секретов не знал про этот тип ключа.
- **До июня 2023 Azure AD SDK не валидировал issuer автоматически**: «Microsoft provided an API to help validate the signatures cryptographically but did not update these libraries to perform this scope validation automatically». Разработчики полагали, что валидация полная. В результате **consumer-ключ подписал токены, принятые enterprise-почтой**.
- Пять исправлений: (1) устранена race condition; (2) усилены prevention/detection/response для key material в crash dumps; (3) усилено credential scanning на signing keys; (4) выпущены библиотеки, автоматизирующие scope validation; (5) поправлена документация.

**Факты из CSRB (отчёт от 20 марта 2024):** `[official/secondary]`
- Масштаб: скомпрометированы почтовые ящики **22 организаций и более 500 человек** (май–июнь 2023); токены подписаны **ключом, созданным Microsoft в 2016 году**.
- Формулировка Board: **«The Board finds that this intrusion was preventable and should never have occurred»** и «a cascade of security failures at Microsoft»; «Microsoft's security culture was inadequate and requires an overhaul» `[secondary]` — цитаты собраны из CISA-выдачи и прессы; **⚠ PDF отчёта (2,4 МБ) не удалось распарсить в этой сессии, дословные формулировки рекомендаций по key management не извлечены**.
- Ключевой пункт, о котором писали все: **спустя ~10 месяцев расследования Microsoft так и не установила достоверно, как именно был похищен ключ** — то есть crash-dump-версия осталась гипотезой `[secondary]`.

**Уроки для `core/keys` (мой вывод, `[inference]`):**
1. Ключ подписи **обязан иметь срок и автоматическую ротацию с первого дня**. Ключ, созданный «на старте проекта», через 7 лет всё ещё будет подписывать токены, если никто не заставит его умереть.
2. **Валидатор токена обязан проверять issuer и audience сам, в библиотеке, без опции «разработчик проверит»**. Если у нас появится отдельный контур (B2C vs B2B, consumer vs org), ключи должны быть **физически разными и невзаимозаменяемыми**, а проверка — жёсткой по умолчанию.
3. **Секреты утекают через диагностику**: crash dumps, heap dumps, логи ошибок, sentry-отчёты, трейсы. Нужен явный запрет на вынос дампов из прод-контура и сканер дампов на key material.
4. **Сканер секретов должен знать формат собственных ключей.** Отсюда — префиксы и контрольные суммы: это не косметика, а условие детекта.

### 4.2 Midnight Blizzard (Microsoft, январь 2024) — забытое тестовое приложение

`[official]`, Microsoft Security Blog 25.01.2024:
- Вход: **password spray по legacy non-production test tenant без MFA**, с низкой частотой попыток и через **residential proxy networks**, чтобы обойти IOC-детект.
- Пивот: **legacy test OAuth application с повышенными правами к корпоративной среде Microsoft**.
- Развитие: актор **создал новые вредоносные OAuth-приложения** и выдал себе роль **`full_access_as_app` в Office 365 Exchange Online** — доступ ко всем почтовым ящикам.
- Рекомендации Microsoft: аудит уровней привилегий **всех** identity и service principals; ревизия приложений с `ApplicationImpersonation` в Exchange Online; RBAC, ограничивающий приложение конкретными ящиками; алерты на выдачу повышенных прав OAuth-приложению и на consent пользователей неизвестным приложениям.

**Уроки `[inference]`:**
- **«Тестовое» приложение — это боевое приложение с теми же правами.** В `core/keys` не должно быть класса «тестовый ключ без ограничений»: тест = отдельный tenant/workspace, отдельные ключи, отдельные лимиты.
- Роль вида «полный доступ ко всем объектам сервиса» (`full_access_as_app`) не должна существовать. Максимум — «полный доступ к объектам, выданным адресно».
- **Создание нового API-ключа/приложения — это событие безопасности**, требующее алерта и (для опасных прав) второго человека. У нас уже есть «четыре глаза» в `core/platform` — этот механизм напрашивается на ключи с денежными/PII-правами.

### 4.3 GitHub, апрель 2022 — кража OAuth-токенов интеграторов

`[official]`, GitHub Security Alert:
- Украдены user-токены, выданные **Heroku Dashboard** (app id 145909, 628778, 313468, 363831) и **Travis CI** (app id 9216).
- Сценарий: аутентификация в GitHub API украденным токеном → `GET /user/repos` и `/orgs/{org}/repos` → клонирование приватных репозиториев → **майнинг секретов из склонированного кода для пивота в другую инфраструктуру**.
- **Токены были украдены не у GitHub:** «the tokens in question are not stored by GitHub in their original, usable formats which could be abused by an attacker».
- Таймлайн: 12 апреля — начало расследования (сигнал от несанкционированного доступа к npm), 13–14 — уведомление Heroku и Travis CI, 15 — публичный алерт, с 18 — уведомление жертв.
- Реакция: немедленный отзыв токенов, связанных с использованием этих приложений GitHub'ом и npm.

**Уроки `[inference]`:**
- **Хранить чужой токен в usable-виде — значит стать целью.** GitHub хранит не-восстановимое представление; нам нужно то же: только `hash(secret)` (медленный KDF или HMAC с server-side pepper), никогда не сам секрет.
- **Утечка ключа — это почти всегда утечка вторичных секретов**: атакующий не остановился на репозиториях, а искал секреты внутри. Значит наш `core/keys` должен не только защищать свои ключи, но и не позволять по одному ключу выкачать чужие секреты.
- **Отзыв должен быть массовым по измерению «приложение»**: «отозвать все токены этой интеграции» — обязательная операция.

### 4.4 GitHub, март 2023 — публикация приватного RSA SSH host key

`[official]`, GitHub Blog:
- 24 марта 2023 ~05:00 UTC приватный **RSA SSH host key GitHub.com** был **кратковременно опубликован в публичном репозитории** — «inadvertent publishing», не компрометация инфраструктуры.
- Затронуты **только** git-операции по SSH с RSA; ECDSA и Ed25519 — нет; веб-трафик, HTTPS-git, инфраструктура и данные клиентов — нет.
- Новый отпечаток: `SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s`.
- Последствие для миллионов пользователей: `REMOTE HOST IDENTIFICATION HAS CHANGED`, ручной `ssh-keygen -R github.com`, правка `known_hosts`, правка GitHub Actions с `ssh-key`.

**Урок `[inference]`:** «ротация ключа» ломает доверяющих, если у них ключ **запинен вручную**. Для наших ключей (JWT, webhook-подписи, подпись документов) обязательно нужен **JWKS-эндпоинт с несколькими активными `kid`** и правило «новый ключ публикуется раньше, чем начинает подписывать» — тогда экстренная ротация не превращается в инцидент у всех клиентов.

### 4.5 AWS — утёкшие ключи и карантин

`[secondary]` (Sysdig, Unit 42, Medium; страница AWS с описанием политики не открывалась):
- GitHub secret scanning находит `AKIA…` в публичном репозитории и **программно уведомляет AWS**.
- AWS автоматически вешает на IAM-пользователя managed policy `AWSCompromisedKeyQuarantine` / `…V2` / `…V3`, запрещающую высокорисковые действия (`iam:CreateAccessKey`, `ec2:RunInstances` и др.); **2 октября 2024 список расширен примерно на 29 действий**.
- Карантин **не является полной защитой** — часть привилегированных операций остаётся доступной; это сигнал для человека, а не решение.
- Типовой сценарий эксплуатации утёкшего ключа — криптомайнинг на `ec2:RunInstances` (Unit 42).

**Урок `[inference]`:** автоматическая реакция на утечку должна быть **deny-политикой поверх**, а не удалением ключа: удаление ломает легитимный сервис и уничтожает следы, а deny останавливает ущерб и оставляет время человеку.

### 4.6 Что Microsoft изменила после инцидентов (Secure Future Initiative)

`[official]`, SFI-отчёты сентябрь 2024 и апрель 2025:
- Entra ID и MSA **генерируют, хранят и автоматически ротируют** access token signing keys в **Azure Managed HSM**; плюс virtualization-based security в Windows.
- Стандартный hardened identity SDK для валидации токенов: **>73%** токенов Microsoft-приложений (сентябрь 2024) → **90%** (апрель 2025).
- MSA signing service перенесён на **Azure confidential VMs**; ~**95%** Entra ID signing VM мигрированы на Azure Confidential Compute.
- Расширено стандартизированное логирование security-токенов для threat hunting.
- Гигиена: удалено **730 000 неиспользуемых приложений** и **5,75 млн неактивных тенантов**.
- **92%** сотрудников используют phishing-resistant MFA; доступ к **4,4 млн** production managed identities ограничен конкретными сетевыми локациями; **81%** production-веток кода защищены MFA proof-of-presence; внедрён automated lifecycle management для всех production-приложений Entra ID.

---

## 5. Что SuperApp6 **стоит** скопировать

### 5.1 Формат секретов (A + B)

1. **Строгая схема префикса:** `sa_` (SuperApp) + буква типа + `_` + среда + `_` + тело.
   Пример набора: `sak_` organization API key, `sap_` personal access token, `sas_` service account / bot, `saw_` webhook signing secret, `sad_` device/POS, `saa_` AI-agent token, `sar_` refresh. Среду ставить отдельным сегментом (`live`/`test`), как Stripe, а не зашивать в букву.
2. **Контрольная сумма CRC32 в base62 в последних 6 символах** (GitHub) — даёт офлайн-валидацию, отсечение опечаток и почти нулевой false-positive у сканеров.
3. **`_` в префиксе обязателен** — не является символом base64/base62, значит префикс не возникнет случайно внутри хеша.
4. Энтропия тела — не меньше 160 бит.
5. **Разные префиксы для «вечного» и «временного»** (как `AKIA`/`ASIA`) — это бесплатная сигнализация в логах и в code review.
6. **Документировать регулярку для сканеров** и — сразу — **не завязываться на фиксированную длину** (урок GitHub 2026).

### 5.2 Хранение и выдача

7. **Show once** + поле «где вы сохранили ключ» (приём Stripe: `Add a note` про место хранения) — снижает число «ключ потерялся, выпустите новый».
8. **Хранить только необратимое представление.** Формулировка GitHub — «not stored in their original, usable formats» — должна стать нашим требованием: в БД лежит `HMAC-SHA256(pepper_from_KMS, secret)` + префикс + последние 4 символа для отображения. Lookup — по индексу на хеш, не по перебору.
9. **Создание ключа = step-up.** Stripe требует 2FA-код на создание secret key; GitHub — sudo mode (2 часа). У нас уже есть `core/verify` (SMS-OTP) и step-up в `core/platform` — переиспользовать, а не изобретать.
10. **Для ключей с денежными правами — «четыре глаза»** (уже есть в `core/platform`).

### 5.3 Скоупинг — прямо на нашу ReBAC-модель

11. **Матрица «ресурс × {none, read, write}»** (Stripe RAK) вместо строкового списка scope. `write ⊃ read`. Дефолт всех — `none`.
12. **Ключ всегда привязан к одному `workspace_id`** (аналог «resource owner» у fine-grained PAT и `Stripe-Account`). Ключ, который может ходить в несколько организаций, — запретить, как GitHub запретил fine-grained PAT доступ к нескольким организациям.
13. **Права ключа ≤ прав субъекта в момент вызова** (пересечение, как session policy у STS и installation token у GitHub). Важнейший следствие: понижение роли сотрудника автоматически понижает его PAT.
14. **Возможность сузить токен на выдаче** (GitHub: `repositories` + `permissions` при запросе installation token) — для AI-агента это критично: агент просит токен «только на эти объекты, только на эти действия, на 10 минут».
15. **Аудит прав по логам:** дать в UI «request logs этого ключа» (Stripe) и кнопку «сузить до фактически использованного» (аналог Access Analyzer policy generation).

### 5.4 Жизненный цикл

16. **Ротация с перекрытием — как первоклассная операция, а не «удалите и создайте».** Кнопка «Rotate», выбор срока смерти старого ключа (`Now` / 1 час / 24 часа / 7 дней), показ обратного отсчёта рядом с именем ключа. Дефолт — 24 часа для интеграций, 7 дней максимум (граница Stripe).
17. **Expiry обязателен.** Дефолт 30 дней (GitHub fine-grained), максимум для организации настраивается, «без срока» — только по явному исключению с обоснованием и алертом.
18. **Политика уровня организации с `restrictForAppsCreatedAfterDateTime`-семантикой** (Entra): новые ключи подчиняются жёсткой политике, старые — гриндфазерятся. Это единственный способ ужесточить правила в живой системе без аварии.
19. **`last_used_at` + `last_used_ip` + `last_used_service`** (AWS credential report), гранулярность — первое использование в 15-минутном окне, чтобы не писать в БД на каждый запрос.
20. **Автодеградация неиспользуемых прав** (Stripe, 180 дней → теряются права на payout): у нас — «ключ не использовал денежные способности 90 дней → денежные способности отключаются, нужно явное Restore». Это дешевле полного отзыва и не ломает чтение.
21. **Отзыв по неиспользованию** (GitHub, 1 год) — для personal access tokens.
22. **Отчёт «мёртвые ключи»** в Кабинете платформы: неиспользуемые ключи, ключи без expiry, ключи с правами шире фактического использования.

### 5.5 Сетевые и контекстные ограничения

23. **Access policies вместо голого IP-allowlist** (Stripe): именованная политика (CIDR-список ИЛИ «страна + ASN + блок VPN/proxy/Tor»), назначаемая на ключ; изменение политики применяется ко всем ключам сразу. Для Казахстана «разрешить только KZ + ASN хостера клиента» — реалистичный и сильный контроль.
24. **Отказ по политике = алерт владельцу**, а не просто 403. Stripe формулирует это как детектор компрометации.
25. **Ограничить область по умолчанию, а не по запросу**: для organization API key (интеграция с 1С) дефолт — только те справочники, что нужны обмену.

### 5.6 Подпись вместо bearer, где это возможно

26. **Для интеграций с высокими правами (1С, «открытая платформа») предложить SigV4-подобную подпись запроса**: `HMAC(kSecret→kDate→kScope)`, канонизация запроса, timestamp ±5 минут, `nonce` для anti-replay. Секрет не уходит в провод, перехват TLS ничего не даёт, а лог-файлы клиента не содержат bearer.
27. **Обязательно подписывать тело**, и запретить подписывать hop-by-hop заголовки (AWS-список) — иначе прокси клиента ломают подпись.

### 5.7 Исходящие webhooks (§C) — копировать Stripe почти дословно

28. Заголовок `X-SuperApp-Signature: t=<unix>,v1=<hex>`; `signed_payload = t + "." + raw_body`; `HMAC-SHA256`.
29. **Толерантность 5 минут**, документировать, что `0` — это выключение проверки, а не ужесточение.
30. **Constant-time сравнение** и **игнорирование всех схем, кроме `v1`** (защита от downgrade).
31. **Roll secret с перекрытием 24 часа и несколькими `v1=` в одном заголовке** — потребителю не нужно ничего координировать по времени.
32. **Ретраи с экспоненциальным backoff до 3 суток**, 3xx считать провалом, только HTTPS + TLS 1.2/1.3, требовать 2xx быстро, дедуп по `event_id`, **не гарантировать порядок** и написать это в документации.
33. Публиковать список наших исходящих IP, чтобы клиент мог сделать allowlist (двойная защита Stripe).
34. **Секрет endpoint'а — отдельная сущность** от API-ключа, с собственным префиксом (`whsec_` → у нас `saw_`).

### 5.8 Криптография и ключи (§A)

35. **Envelope encryption:** master key в KMS/HSM → DEK на сущность → данные. Никогда не шифровать данные напрямую master-ключом.
36. **Encryption context как AAD** с `{"workspace_id": …, "entity": …, "id": …}` — криптографическая привязка шифротекста к арендатору: перенос шифротекста в чужой workspace сделает его нерасшифруемым. И этот же контекст — условие в политике доступа.
37. **Encryption context — несекретный и логируемый**: никогда не класть туда PII (правило AWS дословно).
38. **`kid` в каждом шифротексте и в каждой подписи**, ротация меняет материал, а не идентичность ключа (KMS-семантика). Старый материал живёт, пока есть шифротексты.
39. **JWKS с несколькими активными `kid`**, публикация нового ключа **до** начала подписи им (урок GitHub RSA host key).
40. **Автоматическая ротация подписных ключей JWT с первого дня** (урок Storm-0558), период по умолчанию — недели, а не годы, и HSM/KMS-backed хранение (курс Microsoft SFI).
41. **Окно ожидания на удаление ключа 7–30 дней (дефолт 30)** + алерт на попытку использования в этом окне (KMS) — и soft-delete + purge protection для хранилища (Key Vault).
42. **Запрет отдавать private key наружу вообще** и раздельные ключи для разных контуров (B2C ≠ B2B ≠ платформа) — прямое следствие Storm-0558.
43. **Валидатор токена проверяет `iss`, `aud`, `kid` и «класс ключа» сам** — не оставлять это на вызывающего (главная техническая ошибка Storm-0558).

### 5.9 Секреты приложения и ротация (§A/B)

44. **Staging-метки как в Secrets Manager:** `CURRENT` / `PENDING` / `PREVIOUS` + собственные метки, «версии без меток — deprecated». Это даёт корректный четырёхшаговый протокол ротации: `create → set → test → finish`, идемпотентный по `ClientRequestToken`, с откатом всей ротации при падении любого шага.
45. **Alternating-users стратегия** там, где важна доступность (два набора кредов, ротируем попеременно) — иначе окно ротации = окно отказа.

### 5.10 OAuth2-провайдер для сторонних приложений (§D)

46. **Модель GitHub Apps, а не OAuth Apps:** приложение — самостоятельный субъект; установка в организацию; установщик выбирает объекты, к которым есть доступ; серверный токен короткий (1 час) и сужаемый; пользовательский токен 8 часов + refresh 6 месяцев с ротацией при использовании.
47. **Authorization code — одноразовый, 5 минут** (Stripe Apps).
48. **Refresh token роллируется при каждом обмене**, старый умирает (и Stripe, и GitHub).
49. **Приложение остаётся живым при уходе сотрудника** (GitHub прямо перечисляет это как преимущество перед OAuth App) — критично для B2B.
50. **Consent-политика организации:** три режима как в Entra (запретить пользовательское согласие / разрешить только verified publisher + низкорисковые права / разрешить всё) + **admin consent workflow** с reviewers, сроком жизни запроса и напоминаниями.
51. **Изменение политики согласия не отзывает уже выданные grants** — сразу планировать отдельный экран «ревизия выданных согласий».
52. **Suspension установки** (GitHub) — «временно отключить приложение, не удаляя» нужно для инцидент-реагирования.

### 5.11 Устройства и POS (§E)

53. **X.509 на устройство, уникальный на каждое** (AWS IoT: «each device or client be given a unique certificate to enable fine-grained client management actions, including certificate revocation»).
54. **Provisioning by claim / by trusted user:** POS-терминал приходит с ограниченным claim-креденшелом, разрешающим **только provision-операции**, и меняет его на постоянный при первом включении, затем **обязан переподключиться**.
55. **Жёсткие TTL на окно провижининга:** claim-сертификат от монтажника — **5 минут**; ownership token — **1 час**, по истечении неактивированный сертификат удаляется. Это защищает от «коробки украли по дороге».
56. **Pre-provisioning hook** — белый список серийных номеров на сервере, отклоняющий незнакомое железо.
57. **HSM/secure element на устройстве** там, где возможно; групповые enrollment'ы — только с выводом ключа устройства из группового (DPS symmetric key attestation), никогда не «один общий ключ на партию».
58. **Статусы сертификата `ACTIVE/INACTIVE/REVOKED`** и политика с переменными вида «`thing_name` из сертификата должен совпадать с темой» — устройство не может писать за другое устройство.

### 5.12 AI-агенты (§F)

59. **On-Behalf-Of-семантика Microsoft, целиком:**
    - агент получает токен **только на delegated-права пользователя**, application-роли не передаются;
    - `aud` входящего токена обязан совпадать с клиентом, который делает обмен, иначе — отказ (защита от «подсунули чужой токен»);
    - обмен возможен **только для user principal**;
    - выданный агенту токен **нельзя пересылать никуда, кроме целевой аудитории**.
60. **`SourceIdentity`-аналог, переживающий цепочку делегирования** (AWS STS): в каждом токене и в каждом chatter-логе должно быть видно «действие выполнено агентом X от имени user_id Y», и это должно быть неизменяемым при дальнейшем chaining.
61. **Role chaining ограничить 1 часом** (AWS) — агент, вызывающий агента, не должен продлевать TTL.
62. **Явное «сузить на выдаче»**: агент просит `{scopes, objects, ttl}` меньше своих прав; выдача больше запрошенного невозможна.
63. **Stripe формулирует это прямо: «especially when giving a key to an AI agent» — агенту выдаётся restricted key, никогда не unrestricted.**
64. **Логировать каждое использование ключа агента** (KMS пишет в CloudTrail каждое использование ключа) — для агентов это не роскошь, а обязательное условие разбирательств.

### 5.13 Детект утечек и реакция

65. **Собственный сканер по нашим префиксам** + pre-commit hook в наших репозиториях (правило Stripe: грепать `sk_live_`/`rk_live_`).
66. **Partner-программа в обратную сторону:** зарегистрировать наши префиксы у GitHub secret scanning partner program (бесплатно) — требуется webhook-приёмник с проверкой подписи и реализация отзыва + уведомления пользователя.
67. **Реакция на утечку — deny-политика поверх ключа, а не удаление** (модель AWS quarantine): мгновенно снять денежные и записывающие способности, оставить чтение, поднять алерт, дать человеку решить.
68. **Разделять «exposure» и «compromise», но ротировать в обоих случаях** (формулировка Stripe).
69. **Обязательный текст в интерфейсе: «SuperApp6 никогда не спрашивает ваш секретный ключ»** (Stripe) — дешёвая защита от социальной инженерии.

### 5.14 Отзыв в реальном времени

70. **CAE-подобный механизм**: вместо коротких TTL (которые бьют по производительности и UX) — подписка сервисов на критические события (`user disabled`, `password changed`, `role revoked`, `workspace membership removed`, `key revoked`, `high risk`) + ответ `401` с claims-challenge, заставляющий клиента обойти кэш. У нас уже есть `core/realtime` и `tokenEpoch` — это ровно половина механизма; вторая половина — challenge-протокол на клиенте.
71. **Честно задокументировать задержку** (Microsoft пишет «up to 15 minutes» для распространения событий и «instant» для IP) — иначе безопасники будут считать, что отзыв мгновенный везде.

---

## 6. Что **НЕ** копировать / ловушки

1. **Не делать «ключ с полным доступом» дефолтом.** Stripe сам пишет: «we don't recommend using secret keys for new use cases» — они живут с этим наследием. У нас нет legacy, значит `sk`-аналога быть не должно вообще: только restricted-ключи с явной матрицей прав. (Единственное исключение — ключ владельца организации, и тот с обязательной access policy.)
2. **Не заводить `full_access_as_app`-роль.** Именно она превратила инцидент Midnight Blizzard в катастрофу.
3. **Не оставлять «тестовые» тенанты/приложения без тех же политик, что у прода.** Обе крупные компрометации Microsoft начались с legacy/test-контура.
4. **Не полагаться на фиксированную длину токена** — GitHub наступил на это спустя 5 лет и ломает экосистему в 2026 году. Токен — opaque string переменной длины, колонка БД с запасом.
5. **Не валидировать чужой токен «на глазок».** Правило Microsoft: «Don't attempt to validate or read tokens for any API you don't own». И зеркально: наши токены обязаны валидироваться нашей библиотекой с полной проверкой `iss/aud/kid`.
6. **Не делать `z.coerce.boolean()`-подобных ловушек в конфигурации ключей.** (Наш собственный известный класс ошибок; здесь он проявится как «ключ помечен `restricted: 'false'` → считается restricted=true».)
7. **Не строить авторизацию ключа на одной «двери».** AWS-урок с `system*`-методами у нас уже усвоен; у Roles Anywhere ровно эта же ловушка: **любой trust anchor аккаунта открывает любую роль аккаунта**, если в trust policy нет условий. Значит: «ключ принадлежит workspace» должно проверяться **в каждой точке**, а не только при выдаче.
8. **Не наследовать хаос Entra с приоритетом политик.** У Microsoft организационная token lifetime policy **перекрывает** прикладную — контринтуитивно и ломает ожидания. Выберите один порядок (мы: «более строгая политика выигрывает») и напишите его в документации.
9. **Не копировать «retention задаётся только при создании и неизменяем»** (Key Vault soft-delete). Это порождает необратимые ошибки конфигурации. Делайте retention изменяемым в сторону увеличения.
10. **Не включать необратимые защиты без явного двойного подтверждения.** Azure purge protection после включения нельзя выключить — это правильный уровень защиты, но обязателен экран «это необратимо» и запись в журнал с автором.
11. **Осторожно с «удаление ключа = потеря данных».** У KMS удаление symmetric-ключа делает шифротексты невосстановимыми навсегда, а у asymmetric-ключей публичный ключ продолжает шифровать данные, которые уже никогда не расшифруются. У нас: запрет удаления ключа, пока есть хоть один шифротекст с этим `kid`; счётчик ссылок обязателен.
12. **Не считать quarantine/автоотзыв достаточной реакцией.** AWS-карантин **не блокирует всё** — это сигнал человеку (прямая формулировка вторичных источников; AWS её не опровергает).
13. **Не считать push protection непробиваемым:** по умолчанию обойти его может **любой с write-доступом**, просто указав причину. Нужен delegated bypass (ограниченный круг) для репозиториев с деньгами/PII.
14. **Не доверять «validity check» как разрешению.** Проверка «жив ли секрет» — приоритизация, не решение; ключ может быть жив и при этом скомпрометирован.
15. **Не хранить PII в encryption context / в идемпотентных ключах / в метаданных токена.** Encryption context пишется в аудит открытым текстом (AWS); Stripe прямо просит не класть email в `Idempotency-Key`.
16. **Не ставить толерантность webhook-подписи в 0** — это выключает проверку свежести (явное предупреждение Stripe), а не делает её строже.
17. **Не считать, что CAE/«мгновенный отзыв» работает везде.** У Microsoft он не покрывает гостей, не видит country-based локаций, ломается при >5000 IP-диапазонов и требует поддержки со стороны клиента. Наш аналог должен иметь явный список «где работает, где нет».
18. **Не делать ключ, который ходит в несколько организаций.** GitHub специально это запретил у fine-grained PAT; для нас это прямое нарушение B2B-изоляции.
19. **Не полагаться на «порядок событий» и «уникальность доставки» webhooks** — Stripe явно не гарантирует ни того, ни другого, и мы не сможем (at-most-once EventBus у нас уже есть, у исходящих webhooks будет at-least-once).
20. **Не давать сторонним приложениям бессрочные токены** — «OAuth app tokens do not expire until the person who authorized the OAuth app revokes the token» — это ровно то, что сделало инцидент Heroku/Travis CI таким тяжёлым.
21. **Не хранить secrets в env как основной путь.** Stripe ставит env ниже vault («If your platform doesn't provide a secrets vault, use environment variables instead») — это запасной вариант, а не целевой.
22. **Не ставить `alg: RS256` там, где можно `PS256`.** Entra для client assertion требует **PS256** (RSASSA-PSS), а RS256 остался только в legacy GitHub App JWT. Новый код — PS256 или EdDSA.
23. **Не делать «reveal key» для ключей, созданных пользователем.** Stripe раскрывает повторно **только ключи, созданные самим Stripe** — это правильная граница; раскрытие пользовательского ключа нарушает show-once.
24. **Не давать роль «reviewer» без реальных прав и наоборот.** Ловушка Entra: reviewer, снятый с роли, продолжает получать напоминания по старым запросам, а новый не видит старые. Продумайте перевыдачу очереди согласований.

---

## 7. Открытые вопросы (не удалось подтвердить первоисточником)

1. **Полный текст отчёта CSRB по Storm-0558.** PDF (2,4 МБ, `CSRBReviewOfTheSummer2023MEOIntrusion508.pdf`) не парсится доступными средствами (нет poppler-utils). Подтверждены только: дата публикации 20 марта 2024, масштаб (22 организации, 500+ человек), ключ создан Microsoft в 2016 году, и формулировка «this intrusion was preventable and should never have occurred». **Дословные рекомендации Board'а по key management и digital identity standards не извлечены.** Если они нужны — нужна отдельная обработка PDF.
2. **AWS `AWSCompromisedKeyQuarantineV2/V3`** — точный список запрещённых действий, дата расширения (2 октября 2024) и точная механика подтверждены только вторичными источниками (Sysdig, Unit 42, Medium). Официальную страницу AWS с описанием политики открыть не удалось.
3. **Максимальный срок client secret в Entra = 24 месяца** — подтверждено только через выдачу поиска (Microsoft 365 Developer Blog «Client Secret expiration now limited to a maximum of two years» и Microsoft Q&A). Дословная официальная страница не открывалась.
4. **App instance property lock** (Entra) — страница `how-to-configure-app-instance-property-locks` вернула 404; механизм не исследован.
5. **Точное количество партнёрских паттернов secret scanning у GitHub** (в тексте — ~179 провайдеров). Цифра получена через суммаризатор страницы, не через прямой подсчёт таблицы.
6. **Точная формулировка 15-минутного окна SigV4** — прочитана через суммаризатор страницы S3 API, дословная цитата не зафиксирована. Ограничение presigned URL в 7 дней (604800 с) — там же.
7. **Формат `subject`-claim у GitHub Actions OIDC** (`repo:org/repo:ref:refs/heads/main` и настройка кастомных claims) — на открытой странице отсутствует; нужна страница «About security hardening with OpenID Connect».
8. **Дата получения AWS KMS сертификата FIPS 140-3 Level 3** (≈20 февраля 2025) — вторичный источник; страница `aws.amazon.com/compliance/fips` подтверждает **уровень**, но дату я оттуда не извлёк. Ссылка на AWS Security Blog в выдаче имеет вводящий в заблуждение URL (`aws-kms-now-fips-140-2-level-3`) при заголовке про 140-3.
9. **Есть ли у Stripe лимит на количество RAK** — в документации лимит не назван («Create as many RAKs as you want»), но фактический предел не подтверждён.
10. **Хеширование секретов на стороне вендоров.** Ни AWS, ни Stripe, ни Microsoft не публикуют, как именно хранят секреты. Утверждение GitHub («not stored in their original, usable formats») — единственное прямое.
11. **Секреты AWS EventBridge/SNS webhook signing** — в задании упомянуты, но AWS не использует HMAC-подпись в стиле Stripe для SNS (там подпись сертификатом SNS); детально не исследовано.
12. **Точная семантика Entra `passwordLifetime` vs `passwordAddition`** — в примере документации `maxLifetime: null` используется вместе с `passwordAddition` (полный запрет). Комбинация «разрешить, но ограничить сроком» документирована словами, но примера с `passwordLifetime` в открытой странице не было.
13. **GitHub «Report leak» для приватных репозиториев** — подтверждено вторичным источником (docs через поиск); на странице token-expiration-and-revocation этой функции не описано, там описан **неаутентифицированный API отзыва**.
14. **Stripe managed API keys** — синхронизация ротации с хостинг-платформой описана, но список платформ и протокол синхронизации не раскрыты.

---

## 8. Источники

### AWS — официальная документация `[official]`
1. https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html — префиксы AKIA/ASIA/AIDA/AROA и т. д.
2. https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html — максимум 2 ключа, show-once, формулировки о риске
3. https://docs.aws.amazon.com/IAM/latest/UserGuide/security-creds-programmatic-access.html — «alternatives to long-term access keys»
4. https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html — 900–43200 с, role chaining 1 ч, session policies, SourceIdentity, ExternalId
5. https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html — ротация 365 дней, on-demand, что ротируется и что нет
6. https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys.html — окно 7–30 дней, дефолт 30
7. https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html — иерархия domain key / HBK / derived key / CDK, типы ключей
8. https://docs.aws.amazon.com/kms/latest/developerguide/encrypt_context.html — encryption context как AAD, логирование, условия политик
9. https://docs.aws.amazon.com/kms/latest/developerguide/grants.html — grants, grant tokens, 50 000 на ключ, retire vs revoke
10. https://docs.aws.amazon.com/kms/latest/cryptographic-details/intro.html — FIPS 140-3 validated HSMs
11. https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html — SigV4/SigV4a, цепочка HMAC
12. https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html — 15-минутное окно, presigned до 7 дней (**через суммаризатор**)
13. https://docs.aws.amazon.com/secretsmanager/latest/userguide/whats-in-a-secret.html — версии, staging labels, 20 меток, >100 deprecated, 24 ч
14. https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotate-secrets_lambda.html — 4 шага ротации, ClientRequestToken, RotationToken
15. https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotate-secrets_managed.html — managed rotation, расписание, минимум 4 ч
16. https://docs.aws.amazon.com/rolesanywhere/latest/userguide/introduction.html — trust anchors, profiles, граница доверия = аккаунт
17. https://docs.aws.amazon.com/iot/latest/developerguide/x509-client-certs.html — X.509, уникальный сертификат на устройство, алгоритмы
18. https://docs.aws.amazon.com/iot/latest/developerguide/provision-wo-cert.html — fleet provisioning, claim 1 ч / 5 мин, pre-provisioning hook
19. https://docs.aws.amazon.com/IAM/latest/UserGuide/what-is-access-analyzer.html — unused access findings
20. https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_getting-report.html — credential report, колонки, 4 ч / 15 мин
21. https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html — EKS Pod Identity vs IRSA
22. https://aws.amazon.com/compliance/fips/ — FIPS 140-3 Level 3 для KMS и CloudHSM, миграция hsm1→hsm2

### AWS — вторичные `[secondary]`
23. https://www.sysdig.com/blog/aws-launches-improvements-for-key-quarantine-policy — расширение quarantine-политики (2 октября 2024, ~29 действий)
24. https://unit42.paloaltonetworks.com/malicious-operations-of-exposed-iam-keys-cryptojacking/ — эксплуатация утёкших IAM-ключей, криптомайнинг
25. https://github.com/clutchsecurity/AWSKeyLockdown — автоматическая деактивация ключей, помеченных `AWSCompromisedKeyQuarantineV*`
26. https://aws.amazon.com/blogs/security/aws-kms-now-fips-140-2-level-3-what-does-this-mean-for-you/ — блог AWS о FIPS 140-3 Level 3 (**URL и заголовок расходятся; дата ≈20.02.2025 из выдачи**)

### Stripe — официальная документация `[official]`
27. https://docs.stripe.com/keys — все типы ключей и префиксы, rotate с grace 7 дней, access policies, limited access 180 дней, reveal-правила
28. https://docs.stripe.com/keys/restricted-api-keys — матрица None/Read/Write, миграция с sk, «especially when giving a key to an AI agent»
29. https://docs.stripe.com/keys-best-practices — vault, pre-commit hook, exposure vs compromise, проактивная деактивация
30. https://docs.stripe.com/webhooks — Stripe-Signature, 5 минут, roll secret 24 ч, ретраи 3 суток, 16 endpoints, TLS 1.2/1.3, порядок не гарантирован
31. https://docs.stripe.com/webhooks/signature — формат `t=…,v1=…,v0=…`, raw body
32. https://docs.stripe.com/api/idempotent_requests — Idempotency-Key, 255 символов, 24 часа, UUIDv4, без PII
33. https://docs.stripe.com/api/versioning — версия аккаунта, Stripe-Version, версия webhook-endpoint
34. https://docs.stripe.com/connect/authentication — `Stripe-Account: acct_…`
35. https://docs.stripe.com/stripe-apps/api-authentication/oauth — код 5 минут, access 1 ч, refresh 1 год с роллингом, state/CSRF
36. https://docs.stripe.com/stripe-apps/api-authentication/rak — RAK при установке приложения, права из манифеста, нельзя сменить режим после upload
37. https://docs.stripe.com/sandboxes — изолированные окружения, ключи `*_test_`

### GitHub — официальная документация и блог `[official]`
38. https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/ — префиксы, CRC32/base62, 178 бит, 0.5% FP, 05.04.2021
39. https://github.blog/changelog/2026-04-24-notice-about-upcoming-new-format-for-github-app-installation-tokens/ — stateless `ghs_APPID_JWT`, ~520 символов, 27.04.2026
40. https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens — fine-grained vs classic, 30 дней, ограничения
41. https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization — max lifetime 366 дней, approval owner'ами
42. https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app — RS256, exp ≤ 10 минут, iat −60 с
43. https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app — 1 час, до 500 репозиториев, сужение permissions
44. https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens — 8 часов / 6 месяцев, ротация refresh
45. https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app — почему Apps > OAuth Apps, «OAuth app tokens do not expire»
46. https://docs.github.com/en/rest/apps/oauth-applications — check/reset/delete token, delete grant
47. https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation — 5 правил автоотзыва, неаутентифицированный API отзыва
48. https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/sudo-mode — 2 часа, список действий, SMS не принимается
49. https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys — один репозиторий, read-only по умолчанию, сравнение с installation token
50. https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning — вся история, issues/PR/wiki/gists, validity checks
51. https://docs.github.com/en/code-security/secret-scanning/introduction/supported-secret-scanning-patterns — список префиксов GitHub, ~179 провайдеров
52. https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection — bypass-причины, delegated bypass, дефолты
53. https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning-for-partners — алерт напрямую провайдеру, бесплатно для public repos
54. https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-cloud-providers — OIDC без долгоживущих секретов, обязательные условия доверия
55. https://github.blog/news-insights/company-news/security-alert-stolen-oauth-user-tokens/ — Heroku/Travis CI, апрель 2022, «not stored in usable formats»
56. https://github.blog/news-insights/company-news/we-updated-our-rsa-ssh-host-key/ — 24.03.2023, новый отпечаток, что затронуто

### GitHub — вторичные `[secondary]`
57. https://docs.github.com/en/code-security/secret-scanning/secret-scanning-partnership-program/secret-scanning-partner-program — требования к партнёру (через поисковую выдачу)
58. https://github.blog/changelog/2024-10-02-secret-scanning-on-demand-revocation-for-github-pats-public-beta/ — «Report leak» для приватных репозиториев
59. https://github.blog/changelog/2026-05-15-github-app-installation-tokens-per-request-override-header/ — заголовок `X-GitHub-Stateless-S2S-Token`

### Microsoft Entra / Azure — официальная документация `[official]`
60. https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/tutorial-enforce-secret-standards — application management policies, `P180D`, `restrictForAppsCreatedAfterDateTime`
61. https://learn.microsoft.com/en-us/entra/identity-platform/certificate-credentials — PS256, `x5t#S256`, claims, «5–10 минут», multi-valued keyCredentials
62. https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation — FIC, сценарии, case-sensitive issuer/subject/audience, лимит 100 signing keys
63. https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/overview — system vs user assigned, лимит 20 FIC
64. https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow — OBO, delegated-only, aud-правило, запреты
65. https://learn.microsoft.com/en-us/entra/identity-platform/configurable-token-lifetimes — 60–90 мин, 24–28 ч CAE, 10 мин–23:59:59, refresh не настраивается с 30.01.2021
66. https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-continuous-access-evaluation — critical events, claims challenge, 28 часов, 15 минут, лимит 5000 IP
67. https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-token-protection — device-bound PRT, платформы и ресурсы
68. https://learn.microsoft.com/en-us/entra/identity/conditional-access/workload-identity — только single-tenant SP, только Block, managed identities не покрыты
69. https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent — три режима, `microsoft-user-default-low`, grants не отзываются
70. https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-admin-consent-workflow — reviewers, срок запроса, напоминания, ловушки
71. https://learn.microsoft.com/en-us/azure/key-vault/general/overview — Standard FIPS 140 L1 vs Premium FIPS 140-3 L3, RBAC vs access policies
72. https://learn.microsoft.com/en-us/azure/key-vault/general/soft-delete-overview — 7–90 дней, дефолт 90, неизменяемость, purge protection, потеря RBAC/Event Grid
73. https://learn.microsoft.com/en-us/azure/key-vault/keys/how-to-configure-key-rotation — rotation policy, минимум 7 дней, Crypto Officer, versionless URI, re-wrap DEK
74. https://learn.microsoft.com/en-us/azure/key-vault/managed-hsm/overview — single-tenant, FIPS 140-3 L3, security domain, local RBAC, SKR
75. https://learn.microsoft.com/en-us/azure/iot-dps/concepts-service — TPM/X.509/symmetric key, individual vs group, 64 vs 128 символов, ID scope

### Microsoft — инциденты и SFI `[official]`
76. https://www.microsoft.com/en-us/msrc/blog/2023/09/results-of-major-technical-investigations-for-storm-0558-key-acquisition — crash dump, race condition, SDK не валидировал issuer, 5 исправлений
77. https://www.microsoft.com/en-us/security/blog/2024/01/25/midnight-blizzard-guidance-for-responders-on-nation-state-attack/ — password spray, residential proxies, legacy test OAuth app, `full_access_as_app`
78. https://www.microsoft.com/en-us/security/blog/2024/09/23/securing-our-future-september-2024-progress-update-on-microsofts-secure-future-initiative-sfi/ — Managed HSM + автоматическая ротация, 73% токенов, 730k приложений, 5,75M тенантов
79. https://www.microsoft.com/en-us/security/blog/2025/04/21/securing-our-future-april-2025-progress-report-on-microsofts-secure-future-initiative/ — 90% токенов, confidential VMs, 92% MFA, 4,4M managed identities

### CSRB / CISA `[official]` (не распарсено) и `[secondary]`
80. https://www.cisa.gov/sites/default/files/2025-03/CSRBReviewOfTheSummer2023MEOIntrusion508.pdf — отчёт CSRB, 20.03.2024 (**PDF не удалось распарсить**)
81. https://www.cisa.gov/resources-tools/resources/CSRB-Review-Summer-2023-MEO-Intrusion — страница CISA с отчётом
82. https://www.techtarget.com/searchsecurity/news/366577765/Cyber-Safety-Review-Board-slams-Microsoft-security-failures — «cascade of security failures», «security culture was inadequate»
83. https://www.bleepingcomputer.com/news/security/microsoft-still-unsure-how-hackers-stole-msa-key-in-2023-exchange-attack/ — Microsoft не установила способ кражи ключа
84. https://www.helpnetsecurity.com/2024/04/03/microsoft-storm-0558-key/ — сводка выводов Board

### Прочее `[secondary]`
85. https://devblogs.microsoft.com/microsoft365dev/client-secret-expiration-now-limited-to-a-maximum-of-two-years/ — максимум 24 месяца для client secret (через выдачу поиска)
86. https://learn.microsoft.com/en-us/answers/questions/2115751/entra-app-registration-policy-to-restrict-client-s — отсутствие Azure Policy для секретов app registration
87. https://stripe.dev/blog/securing-stripe-api-keys-aws-automatic-rotation — пример автоматической ротации Stripe-ключа через AWS Secrets Manager (ссылка из документации Stripe)

---

**Итого источников:** 87 ссылок, из них **79 первоисточников** (документация вендоров, их собственные блоги безопасности, страница CISA).
