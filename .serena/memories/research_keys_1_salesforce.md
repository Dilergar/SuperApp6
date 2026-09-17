# Бенчмарк для `core/keys`: SALESFORCE

> **Важно про расположение файла.** Задание требовало записать отчёт в
> `…/scratchpad/research/01-salesforce.md`. На момент записи сессия находится в **plan mode**,
> который разрешает редактировать ТОЛЬКО этот plan-файл. Поэтому полный отчёт лежит здесь;
> содержимое готово к копированию в требуемый путь без изменений.

Дата исследования: 2026-09-13. Источник фактов — официальная документация Salesforce
(help.salesforce.com, developer.salesforce.com, admin.salesforce.com), официальные
release notes, Google Threat Intelligence / Mandiant, GitHub Docs. Всё, что не подтверждено
первоисточником, помечено `[secondary]` или `[inference]` прямо в тексте.

---

## 1. Executive summary (15 пунктов)

1. **Salesforce переписывает свою модель «приложение-клиент» с нуля.** `Connected App` (2013)
   заменяется на `External Client App` (ECA). С Winter '26 создание connected app через UI
   выключено по умолчанию в новых орг-ах, с **Spring '26 — выключено во всех орг-ах, и в UI, и
   в API**, включить можно только заявкой в Salesforce Support. Главная причина — не фичи, а
   **невозможность разделить «настройки разработчика» и «политики администратора»** в старой
   модели. Нам этот раскол надо заложить в схему СРАЗУ.
2. **Ротация секрета у них — двухфазная (staged → apply), а не «сгенерировал и всё сломалось».**
   Админ генерирует *staged* consumer key/secret, раздаёт интеграциям, потом жмёт Apply. Это
   ровно тот UX, который нужен нам для org API keys.
3. **Но apply у них отзывает ВСЕ access и refresh токены приложения** и даёт ~10 минут
   «нестабильного» поведения, когда старый и новый секрет работают вперемешку. Это анти-паттерн:
   у нас должно быть N одновременно валидных секретов с явными `kid` и датой истечения, а не
   мутный переходный период.
4. **Refresh Token Rotation с reuse-detection у Salesforce есть и включается флажком**: каждый
   refresh token одноразовый; попытка использовать уже провёрнутый токен убивает текущий refresh
   token и все связанные access-токены. Это обязательный минимум для нас (RFC 6819 §5.2.2.3).
5. **Password-flow они убивают по расписанию**: заблокирован по умолчанию для орг-ов, созданных
   в Summer '23+; release update с принудительным отключением; орг-и Summer '26+ не смогут его
   включить вовсе. Вывод для нас: **никогда не заводить «логин по паролю для API»**, даже как
   временный режим.
6. **Client Credentials flow у них обязан иметь «Run As» пользователя** — токен всегда выпущен
   от имени конкретного человека/интеграционной учётки, а не «от имени приложения». Salesforce
   при этом принудительно вырезает из client-credentials-токена scopes `full`, `web`,
   `refresh_token/offline_access`. Нам это прямо ложится на «service account = пользователь в
   `user_roles` с урезанными capability».
7. **Отдельная лицензия «Salesforce Integration»** (API-only, без UI, 5 штук бесплатно) —
   продуктовое признание того, что интеграционная учётка это отдельный класс субъекта.
   Для нас: `service_account` — не «юзер с флажком», а отдельный тип identity с отдельным
   жизненным циклом.
8. **Ключевая иерархия Shield: KDF seed (бывш. master secret) + tenant secret → DEK.**
   Деривация — PBKDF2 на HSM на отдельном key derivation server; **DEK не хранится нигде**,
   живёт только в шифрованном кэше и передеривируется. У нас это калькируется 1:1 на
   `master key (KMS/env) + per-workspace secret → DEK`.
9. **Ключи у них — не «версия строкой», а объект со статусом**: Active / Archived / Destroyed,
   до 50 активных+архивных tenant secrets на тип. Ротация НЕ перешифровывает данные: нужен
   отдельный процесс «Synchronize Your Data Encryption». Нам нужен такой же явный статус и
   отдельный фоновой ре-энкрипт (`core/jobs`).
10. **Три уровня «клиент владеет ключом»**: BYOK (загрузи материал), Cache-Only Key (ключ живёт
    только у клиента, Salesforce тянет его callout-ом и никогда не персистит), EKM (root key в
    AWS KMS, Salesforce хранит только *wrapped* DEK). Полезно как дорожная карта для B2B-клиентов
    уровня банка; в v1 — не строить.
11. **Инцидент Salesloft Drift (UNC6395, август 2025)**: украдены OAuth-токены *одного*
    интегратора → массовая выкачка данных из сотен орг-ов Salesforce. Платформа Salesforce не
    была уязвима — уязвимой была **модель доверия к долгоживущему refresh-токену третьей стороны**.
    Главный урок: `full`-скоуп + бессрочный refresh token + отсутствие IP-привязки = мастер-ключ.
12. **Инцидент UNC6040 (вишинг, 2025)**: злоумышленники по телефону вели сотрудника на страницу
    device-flow и просили ввести 8-значный код, авторизуя перекрашенный Data Loader. Ответ
    Salesforce (сентябрь 2025): **устройственный flow для неустановленных приложений заблокирован
    полностью**, обычные пользователи больше не могут само-авторизовать неустановленные
    приложения; появились permissions `Approve Uninstalled Connected Apps` и `Use Any API Client`.
13. **Их админ-UX — эталон и его надо копировать**: страница `Connected Apps OAuth Usage` с
    колонками «сколько пользователей / когда впервые / когда последний раз / сколько раз»,
    кнопки Revoke / Revoke All / Block / Uninstall; у пользователя в личных настройках —
    свой список «OAuth Connected Apps» с собственной кнопкой Revoke. Объект `OAuthToken` с полями
    `LastUsedDate`, `UseCount` доступен через SOQL.
14. **Исходящие webhooks у Salesforce — слабое место и копировать их нельзя**: Outbound Messages
    **не имеют HMAC-подписи**; получатель проверяет `OrganizationId` в теле SOAP и (опционально)
    mTLS клиентским сертификатом. Нам нужна нормальная HMAC-подпись с timestamp и `kid`.
15. **Phishing-resistant MFA для привилегированных** (админы, Modify All Data, View All Data,
    Customize Application, Author Apex) включается принудительно с июля 2026: остаются только
    WebAuthn/passkeys/CBA; Salesforce Authenticator, TOTP, SMS для этих ролей — запрещены.
    Для нас: step-up при работе с ключами должен быть НЕ SMS-OTP.

---

## 2. Находки по фасетам

### 2.1. Connected Apps vs External Client Apps (фасет D + B)

#### Что это такое

- `Connected App` — старая сущность: одновременно и «паспорт разработчика» (consumer key/secret,
  callback URL, scopes), и «политика админа» (кому разрешено, IP, refresh-политика). Именно
  слипание этих двух ролей Salesforce называет главным дефектом: *«there are aspects of the
  framework that make it impossible to define separate user roles and difficult to package
  connected apps»* [official].
- `External Client App` — новая сущность, **«next generation of connected apps»**; Salesforce
  прямо пишет: *«We recommend that you use external client apps in all situations and migrate
  existing local connected apps to local external client apps»* [official].

#### Официальная таблица сравнения (help.salesforce.com, `connected_apps_and_external_client_apps_features`)

| Возможность | Connected App | External Client App |
|---|---|---|
| 2GP packaging | Restricted | Available |
| 1GP packaging | Available | Available |
| Distribution State Management | нет | есть |
| **Distinct Developer/Admin Roles** | **нет** | **есть** |
| Subscriber Association/Disassociation | нет | есть |
| Metadata API | Restricted | Available |
| OAuth 2.0 / SAML / OpenID Connect | есть | есть |
| **OAuth Key/Secret Rotation** | есть | есть |
| Trusted IP Ranges | есть | есть |
| Sandbox Cloning | есть | Limited (только packaged) |
| **API Access Control** | есть | **«Not needed»** |
| Custom Attributes / Audit / Logging | есть | есть |
| OAuth Access Policies / IP Relaxation / Session Policy / Mobile Policy | есть | есть |
| **User Provisioning** | есть | **нет** |
| OAuth Usage Management | есть | есть |
| Canvas / Notifications | есть | есть |

#### Метаданные (разделение ролей — самое ценное для нас)

- `ExternalClientApplication` — сама сущность, поле `distributionState` (local / distributed).
- `ExtlClntAppOauthSettings` — настройки разработчика; **упаковывается в 2GP**.
- `ExtlClntAppGlobalOauthSettings` — **не упаковывается**: живёт на DevHub и
  реплицируется/синхронизируется в орг-и подписчиков.
- `ExtlClntAppConfigurablePolicies`, `ExtlClntAppOauthConfigurablePolicies` — **единственное,
  что может менять орг-подписчик** [official metadata guide + `[secondary]` Metazoa].

> Вывод для `core/keys`: у нас должен быть тот же раскол —
> **`app_definition` (издатель: redirect URI, допустимые grant types, scopes, требование PKCE)**
> vs **`app_installation` (организация-арендатор: кому разрешено, IP allow-list, лимиты,
> срок жизни refresh, требование step-up)**. Это ровно наш `X-Workspace-Id`.

#### Сроки отключения connected apps

- **Winter '26**: создание connected app через UI выключено по умолчанию **в новых орг-ах**.
- **Spring '26**: создание выключено по умолчанию **во всех орг-ах**, через UI *и* API;
  исключение — установка пакета. Включение — только заявка в Salesforce Support.
- Существующие connected apps продолжают работать; их можно редактировать/устанавливать/удалять.
- Миграция: App Manager → открыть connected app → **Migrate to External Client App**; после
  миграции connected app остаётся как read-only запись в App Manager.
  `[official help + release notes; часть деталей подтверждена secondary-источниками]`
- По `[secondary]`-источникам единственный flow, который НЕ поддерживается в ECA, —
  username-password.

#### Полный список OAuth-flows Salesforce (official `remoteaccess_oauth_flows`)

| Flow | Назначение / примечание Salesforce |
|---|---|
| Web Server (authorization code) | сервер умеет хранить client secret |
| User-Agent (implicit) | *«considered insecure and aren't recommended»* |
| Refresh Token | продление сессии |
| JWT Bearer | server-to-server, сертификат, **без участия пользователя** |
| Client Credentials | app-to-app, требует Run As user |
| Device | IoT / CLI с ограниченным вводом |
| **Asset Token** | IoT: JWT-токен устройства + автопривязка к Asset |
| Token Exchange | обмен токена внешнего IdP на токен Salesforce |
| Hybrid App Flows | связка access/refresh токена с web-сессией |
| Username-Password | *«Blocked by default»* для орг-ов Summer '23+ |
| SAML Bearer Assertion / SAML Assertion | федерация |
| OIDC Dynamic Client Registration | Salesforce как authorization server для внешнего API-gateway |

Общая рекомендация Salesforce дословно: *«We recommend avoiding the user-agent and
username-password flows because they transmit credentials. Instead, choose a flow that frees the
app from having to manage, store, and protect credentials.»*

#### Настройки «Enable OAuth Settings» (official)

- **Callback URL** — можно несколько (по строкам), суммарный лимит **2000 символов**.
- **Require Secret for Web Server Flow** / **Require Secret for Refresh Token Flow**.
- **Require Proof Key for Code Exchange (PKCE) Extension for Supported Authorization Flows** —
  отдельный флажок, блокирует flow без PKCE.
- **Enable Refresh Token Rotation** — см. ниже, ключевая вещь.
- Device flow — включается отдельно, callback URL становится заглушкой.
- Сертификат (X.509) для JWT-подписи — **не больше 4 KB**.
- **ID Token**: срок жизни настраивается в диапазоне **1–720 минут**, задаются audiences и claims.
- **Asset Token**: срок жизни, сертификат подписи, audiences, custom attributes.
- Single Logout URL.

#### Политики доступа (official `connected_app_manage_oauth`)

- **Permitted Users**:
  - `All users may self-authorize` — **дефолт** (и это, как показал 2025 год, дефолт-дыра);
  - `Admin approved users are pre-authorized` — только профили/permission sets.
- **IP Relaxation**: `Enforce IP restrictions` (дефолт) / `…but relax for refresh tokens` /
  `Relax IP restrictions for activated devices` / `Relax IP restrictions`.
- **Refresh Token Policy**: `Valid until revoked` (**дефолт**) / `Immediately expire` /
  `Expire if not used for N` (скользящее окно) / `Expire after N` (жёсткий срок).
- Session Policy (в т.ч. требование High Assurance), Timeout Value, Single Logout,
  Mobile Policy, Custom Attributes.

#### Ротация consumer key / consumer secret (official `connected_app_rotate_consumer_details`)

Процедура:
1. Setup → App Manager → View → **Manage Consumer Details**.
2. **Подтверждение личности** (identity verification); доступ действителен **5 минут**.
3. **Generate** → создаются *staged* consumer key/secret. Каждая новая генерация **перезатирает**
   предыдущие staged-значения.
4. Раздать staged-значения интеграциям.
5. **Apply** (жмётся дважды).

Права: `Customize Application` **И** (`Modify All Data` **ИЛИ** `Manage Connected Apps`),
**плюс** отдельное `Allow consumer key and secret rotation`.

Последствия (дословно): *«All existing access and refresh tokens associated with the connected
app are revoked when you apply the new consumer details.»* Операция необратима. После Apply —
**до 10 минут нестабильного поведения**, когда старые и новые значения работают вперемешку.

#### Токены и scopes (official `remoteaccess_oauth_tokens_scopes`)

Типы токенов: access token, refresh token («*can have an indefinite lifetime*»), ID token (JWT),
authorization code, **asset token**, delete token.

Полный перечень scopes: `api`, `web`, `openid`, `id`, `refresh_token`/`offline_access`,
`visualforce`, `chatter_api`, `custom_permissions`, **`full`** («*all data accessible by the
logged-in user*»), `cdp_query_api`, `cdp_profile_api`, `cdp_ingest_api`, `cdp_api`, `pardot_api`,
`wave_api`, `eclair_api`, `sfap_api`, `lightning`, `content`, `chatbot_api`,
`user_registration_api`, `forgot_password`, `interaction_api` (зарезервирован).
Scopes **сохраняются вместе с refresh token**.

Лимиты:
- **5 уникальных одобрений (approvals) на пользователя на приложение**; шестое отзывает самое
  старое.
- При достижении орг-лимита отзывается access token, дольше всех не использовавшийся.
- Dynamic Client Registration: **максимум 100** зарегистрированных OAuth 2.0 connected apps.

Эндпоинты: `/services/oauth2/token`, `/services/oauth2/revoke`,
**`/services/oauth2/introspect`** (RFC 7662, client_id/secret в Basic или в теле),
**`/services/oauth2/register`** (dynamic client registration).

#### Refresh Token Rotation (official, важнейшее)

- При включении *«the connected app issues a new refresh token along with the access token each
  time the flow is invoked»*.
- *«each refresh token is used only one time per user»*.
- **Reuse detection**: *«If someone tries to use a refresh token that's been rotated out,
  Salesforce invalidates the current refresh token and any associated access tokens.»*
  Клиент обязан пройти авторизацию заново.
- Grace period в документации **не указан** (`[не проверено]`); есть предупреждение про
  параллельные одинаковые запросы → ошибка «Token request is already being processed».

#### JWT Bearer flow (official `remoteaccess_oauth_jwt_flow`)

- `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`.
- Claims: `iss` = consumer key приложения; `aud` = `https://login.salesforce.com` /
  `https://test.salesforce.com`; `sub` (или `prn`, у которого приоритет при наличии обоих) =
  username; `exp` = epoch-секунды.
- **Буфер на рассинхрон часов — 3 минуты.**
- Подпись — **RSA SHA256**, сертификат **≤ 4 KB**.
- **Refresh token не выдаётся никогда.**
- Требует либо `Admin approved users are pre-authorized`, либо ранее выданного
  пользовательского согласия.

#### Client Credentials flow (official `remoteaccess_oauth_client_credentials_flow`)

- Обязателен **integration user («Run As»)** — токен выпускается от его имени.
- **Refresh token не поддерживается.**
- Salesforce **автоматически вычищает** из выданных scopes: `full`, `web`,
  `refresh_token/offline_access`.
- Дословное предупреждение: *«any person or app that has access to your external client app's
  consumer key and consumer secret can get an access token. Maintain security by periodically
  changing your consumer secret, and change it immediately if it becomes compromised.»*

#### Device flow (official `remoteaccess_oauth_device_flow`)

- `response_type=device_code` → ответ с `user_code` (**8-значный буквенно-цифровой**),
  `verification_uri` вида `https://<domain>/setup/connect`, `interval`.
- **device_code и user_code живут 10 минут.**
- Опрос: `grant_type=device` + `code`.
- **Именно этот экран стал вектором вишинга UNC6040** — см. §3.2.

#### Asset Token flow (IoT) (official `remoteaccess_oauth_asset_token_flow`)

- Обмениваются **access token + actor token** → **asset token**.
- Actor token — подписанный JWT с данными устройства: имя, серийный номер, привязка к
  Contact/Account.
- Автоматическая регистрация: если в claim есть `id` — привязка к существующему Asset по Id;
  если `serial number` — по серийнику; если только `name` — **создаётся новый Asset**.
- Т.е. «регистрация устройства» и «выдача токена устройству» — **одна атомарная операция**.

#### Token Exchange flow (official `remoteaccess_token_exchange_overview`)

- POST `/services/oauth2/token`, параметры: `grant_type` (token-exchange URN), `subject_token`,
  `subject_token_type` (opaque access token / refresh token / ID token / SAML assertion / JWT),
  `client_id`.
- Токен внешнего IdP передаётся в **Apex token exchange handler** (класс, расширяющий
  `Oauth2TokenExchangeHandler`; метаданные `OauthTokenExchangeHandler`), который решает вопрос
  сопоставления/провижининга пользователя.
- Приложение должно быть **явно включено** для token exchange handler.
- Editions: Enterprise, Performance, Unlimited, Developer.

#### API Access Control (official `security_api_access_control_about`)

- Запрещает **всем** пользователям доступ к API, кроме как через allowlisted connected apps.
- **Включается только заявкой в Salesforce Customer Support.**
- Две независимые настройки: для внутренних пользователей и для внешних (Experience Cloud).
- При включении все connected apps фактически переводятся в
  `Admin approved users are pre-authorized` `[secondary]`.
- Обход — только permission `Use Any API Client`.
- В ECA эта функция помечена как **«Not needed»** — ECA сами по себе deny-by-default.

### 2.2. Security tokens, password flow, интеграционные пользователи, Named Credentials (фасет B)

#### Security token (official `user_security_token`)

- *«a case-sensitive alphanumeric code»*, приписывается к паролю (или вводится отдельным полем).
- Нужен при доступе через desktop-клиент/API **с IP вне доверенного диапазона орг-и**.
- Сброс: личные настройки → Reset My Security Token; **новый токен уходит на e-mail**.
- Сбрасывается также при смене пароля.
- **Нельзя сбросить**, если у профиля заданы Login IP Ranges, либо есть permission
  `API Only User`, либо `Multi-Factor Authentication for API Logins`.
- Длина «24/25 символов» в документации **не заявлена** — `[не проверено]`.

> Это «пароль номер два», отправляемый по почте — **классический анти-паттерн**, который
> Salesforce тащит с 2000-х. Копировать нельзя ни в каком виде.

#### Отмирание username-password flow

- Заблокирован **по умолчанию** для орг-ов, созданных в **Summer '23** и позже; управляется
  настройкой `Allow OAuth Username-Password Flows` в *OAuth and OpenID Connect Settings*
  `[official release note + secondary]`.
- Release Update «Retirement of OAuth 2.0 Username-Password Flow for Connected Apps»:
  принудительное применение **20 февраля 2027**; орг-и, созданные в **Summer '26** и позже, не
  смогут использовать flow вовсе `[secondary — конкретную дату подтвердить не удалось,
  официальная страница release note не отдалась WebFetch]`.

#### Лицензия «Salesforce Integration» `[secondary: Salesforce Ben, admin.salesforce.com blog]`

- Введена в **марте 2023**.
- **5 бесплатных лицензий** в Enterprise/Unlimited/Performance; далее ~$10/user/month.
- Пользователь **не может войти в UI**, только API.
- Профиль `Salesforce API Only System Integrations` — нередактируемый, права выдаются
  **только permission sets**.
- Официальная best practice: **одна интеграционная учётка на одну интеграцию** (трассируемость +
  минимальные права).

#### Named Credentials / External Credentials (исходящие секреты)

- **Named Credential** = endpoint + HTTP-транспорт. **External Credential** = протокол
  аутентификации + principals. Разделение сделано именно затем, чтобы секрет не лежал в
  «настройке эндпоинта».
- Протоколы External Credential: `No Authentication`, `Basic`, `OAuth 2.0` (Browser flow,
  Client Credentials, JWT Assertion/Bearer), `JWT`, `AWS Signature V4`, `Custom`.
  Легаси Named Credentials дополнительно поддерживали `JWT Token Exchange`, которого в новых
  External Credentials нет `[secondary]`.
- **Principal types**: `Named Principal` — один набор кредов на всю орг-у;
  `Per User` — у каждого пользователя свои креды к внешней системе.
  Доступ к principal раздаётся **permission sets** (`Enable External Credential Principals`).
- **Metadata API не отдаёт секреты в открытом виде**; после установки пакета токены/сертификаты
  заполняются через UI или Connect REST API. То есть **секрет никогда не путешествует в
  метаданных деплоя**.

> Для нас это прямая калька: хранилище исходящих секретов (Google refresh token, креды
> коннекторов) — отдельная сущность с `owner_scope = org | user`, доступ к которой выдаётся
> через нашу модель прав, и она **не экспортируется** ни в один дамп/бэкап конфигурации.

### 2.3. Shield Platform Encryption — иерархия ключей (фасет A)

#### Иерархия и деривация (official)

```
HSM ──► KDF seed (бывш. "master secret", генерируется в начале КАЖДОГО релиза)
                 +
        master salt (генерируется в начале каждого релиза)
                 +
        tenant secret (уникален для орг-и; сгенерирован Salesforce или загружен клиентом)
                 │
                 ▼  PBKDF2, выполняется на key derivation server в дата-центре Salesforce
        Data Encryption Key (DEK)
                 │
                 ▼
        Encrypted key cache  (DEK НИКОГДА не персистится)
```

Дословные факты:
- *«Salesforce combines your tenant secret with the KDF seed (formerly master secret) using
  PBKDF2 on hardware security modules (HSMs) to derive the data encryption keys. Derived keys are
  never persisted — they're held in a secure, encrypted cache and re-derived when needed.»*
- *«Shield Platform Encryption uses HSMs to generate and store primary and per-release secret
  material.»*
- *«Data encryption keys aren't stored in Salesforce.»*
- *«Your key material is never saved or shared across orgs.»*
- Идентификация нужного master secret — **по дате создания tenant secret** (т.е. `kid` у них
  фактически = (тип ключа, версия, дата)).
- Стойкость — **256 бит** (Trailhead, official).
- Probabilistic-шифрование: AES-256 + **CBC** + padding **PKCS#5** + **случайный IV**
  `[official-adjacent: патенты Salesforce US 9087212 / US 10594490; в help-доке точные режимы не
  названы]`.
- Deterministic-шифрование: два варианта — **case-sensitive** и **exact-match case-insensitive**,
  включается **пофайлово/пополю**; платит утечкой равенства значений.

#### Статусы и ротация (official `security_pe_rotate_keys`)

- Статусы tenant secret: **ACTIVE** (шифрует и расшифровывает) / **ARCHIVED** (только
  расшифровывает) / **DESTROYED** (не может ничего).
- Ротация = сгенерировать новый tenant secret; старый **автоматически** уходит в ARCHIVED.
- **Лимит: до 50 active + archived tenant secrets каждого типа** (например 1 active + 49 archived
  для Fields and Files (Probabilistic), столько же для Analytics).
- **Ротация НЕ перешифровывает существующие данные.** Перед уничтожением ключа надо запустить
  «Synchronize Your Data Encryption» — массовый ре-энкрипт под активный ключ.
- *«Unlike passwords, you can't reset a tenant secret. Salesforce can't help with deleted,
  destroyed, or misplaced tenant secrets.»*

#### Разделение обязанностей

- Permission **`Manage Encryption Keys`** — отдельное от `Customize Application`/`Modify All Data`;
  позволяет **generate, archive, export, import, destroy** tenant secrets `[official help,
  получено через поисковую выдачу первоисточника; прямой fetch страницы не удался]`.

#### Клиентские варианты владения ключом

| Вариант | Где живёт ключ | Что хранит Salesforce | Особенности |
|---|---|---|---|
| **Salesforce-managed** | HSM Salesforce | tenant secret | дефолт, деривация PBKDF2 |
| **BYOK** | клиент генерирует материал, загружает | tenant secret (загруженный) | сертификат для обёртки |
| **Cache-Only Key** | **только у клиента** | ничего | callout за ключом по требованию |
| **EKM** | root key в AWS KMS клиента | **wrapped DEK** в БД | unwrap через KMS клиента |

**Cache-Only Key Service** (official):
- Ключ — **256-bit AES**, отдаётся в **JSON**, обёрнут в **JWE**.
- Поле `kid` — допустимые символы `a-z A-Z 0-9 . - _`; может быть числом, строкой или UUID
  (пример из доки: `982c375b-f46b-4423-8c2d-4d1a69152a0b`).
- *«Salesforce doesn't retain or persist your cache-only keys in any system of record or backups.»*
- **Cache-only key минует деривацию** и используется напрямую как DEK.
- Утилита обёртки — официальный репозиторий `forcedotcom/CacheOnlyKeyWrapper`.

**EKM Flow** (official `security_shield_pe_ekm_flow`):
- Админ клиентского KMS создаёт root key; админ Salesforce создаёт **key policy**, разрешающую
  Salesforce (а) запрашивать генерацию и обёртку DEK, (б) запрашивать разворачивание DEK.
- Клиентский KMS **создаёт DEK, оборачивает его и отдаёт** сервису шифрования по TLS.
- Salesforce хранит **только обёрнутую копию**; разворачивает через KMS клиента по требованию.
- Развёрнутый DEK кладётся в кэш, защищённый **org-specific AES 256-bit cache encryption key**.
- **Кэш валиден до отзыва/ротации DEK либо до сброса кэша — «типично каждые 72 часа»
  (~24 часа при некоторых операциях Salesforce).**

### 2.4. Сессии, MFA, IP (фасет B/E)

- **MFA контрактно обязательна с 1 февраля 2022**; авто-включение для прямых логинов шло
  волнами Spring '23 → Spring '24; орг-и, созданные до 8 апреля, получили MFA 8 апреля 2024;
  с Summer '24 «enforcement» заменён на in-app-уведомления о несоответствии `[official release
  notes + secondary]`.
- **API-only интеграционные пользователи MFA не затрагивает.**
- **Phishing-resistant MFA** (official KB 005321563):
  - sandbox — **с 10 июля 2026**, production — **с 20 июля 2026**, раскатка волнами до
    **3 сентября 2026**.
  - Затрагивает: профиль System Administrator; пользователей с `Modify All Data`, `View All Data`,
    `Customize Application`, `Author Apex`; внутренних пользователей на Experience Cloud.
  - Принимается: **WebAuthn security keys, built-in authenticators (Touch ID, Windows Hello),
    cloud-synced passkeys, certificate-based authentication (x.509), админские временные коды**.
  - **Запрещается** для этих ролей: Salesforce Authenticator, TOTP-приложения, SMS, e-mail.
  - Исключения: внешние Experience Cloud пользователи, Chatter External/Free, DE/trial/scratch.
- Session Settings: session timeout **15 минут – 12 часов** `[secondary; в официальной странице
  диапазон подтвердить не удалось]`, `Force logout on session timeout`,
  **`Lock sessions to the IP address from which they originated`**,
  **`Enforce login IP ranges on every request`** (иначе проверка обходится существующей сессией),
  требование **High Assurance** сессии для чувствительных операций.
- **Login IP Ranges (профиль) ≠ Trusted IP Ranges (орг-а)**: первые блокируют вход, вторые лишь
  снимают identity verification.
- **Срок жизни access-токена = таймаут сессии**: настройка connected app → профиль → org session
  settings; дефолт — **2 часа бездействия** (official Pub/Sub docs).

### 2.5. AI-агенты: Agentforce (фасет F)

- **Agent API** (headless): требуется **External Client App** с **client credentials flow**,
  scopes `api`, `refresh_token`/`offline_access`, `chatbot_api`, `sfap_api`; обязателен
  **Run As user** — коннектор «имперсонирует» этого пользователя `[official Agentforce dev
  guide + secondary]`.
- **Agent User** — отдельная identity для Agentforce Service Agent; **не может логиниться в
  орг-у**. Создаётся автоматически при создании сервис-агента, получает permission set group
  `AgentforceServiceAgentUserPsg` (вложены `Agentforce Service Agent User`, `Data Cloud User`,
  `Prompt Template User`) `[secondary: Salesforce Ben, но названия permission sets официальные]`.
- Два рабочих паттерна (важно для нас):
  1. **on-behalf-of**: агент помогает залогиненному сотруднику, **каждый tool call уважает права
     этого человека**;
  2. **agent user**: нет пользовательского логина (публичный сайт) → узкая, долгоживущая
     сервисная identity.
- Guardrails по документации: каталог разрешённых действий, policy-check до и после вызова
  инструмента, **deny by default**.

### 2.6. Pub/Sub API, Platform Events, IoT (фасет E)

- Pub/Sub API — **gRPC поверх HTTP/2**, endpoint `api.pubsub.salesforce.com:7443`.
- Аутентификация — **метадата-заголовки gRPC**: `accesstoken`, `instanceurl`, `tenantid`.
  **Имена регистрозависимы** — `AccessToken` приведёт к невнятной ошибке аутентификации.
- Подходит **любой** OAuth flow Salesforce.
- Срок жизни токена = таймаут сессии connected app / профиля / org (дефолт 2 ч бездействия).
- Устройства/IoT — Asset Token flow (см. выше) + Device flow для «регистрации на устройстве
  без клавиатуры».

### 2.7. Исходящие webhooks (фасет C) — слабое место Salesforce

- **Outbound Messages не подписываются HMAC.** `[secondary: Hookdeck; в официальной доке
  механизма подписи нет — отсутствие подтверждается косвенно]`
- Получатель аутентифицирует сообщение, сверяя **18-символьный `OrganizationId`** в теле SOAP,
  ограничивая источник по IP-диапазонам Salesforce и (опционально) требуя **mutual TLS**:
  Setup → API → **Generate Client Certificate**, сертификат импортируется на сервер получателя
  и сверяется в TLS-handshake `[official help `wf_outbound_messages_client_cert`]`.
- Контракт доставки: получатель обязан вернуть SOAP `<Ack>true</Ack>` и HTTP 200, иначе
  **ретраи до 24 часов** `[secondary]`.

### 2.8. AppExchange / маркетплейс приложений (фасет D)

- Security Review обязателен для **любого** managed-пакета перед листингом (платного и
  бесплатного); бесплатные освобождены только от сбора **$999** `[secondary]`.
- Инструменты: **Source Code Scanner (Checkmarx)** обязателен для пакетов с Apex/Visualforce/
  Lightning, **3 бесплатных скана на ревью** через Partner Security Portal `[official ISVforce
  guide]`; плюс Salesforce Code Analyzer и DAST (OWASP ZAP / Burp / Qualys после вывода Chimera
  в июне 2025) `[secondary]`.
- Требуется архитектурный документ, чистая dev-орг-а с установленным решением и учётными
  данными для ревьюера.
- **Периодические ре-ревью** (official `security_review_periodic_reviews`): такие же по объёму,
  автоматические + ручные; могут запрашиваться добровольно или назначаться Salesforce.
  Периодичность **от 6 месяцев до 2 лет**, зависит от риск-факторов и объёма изменений
  `[secondary]`.

### 2.9. Админ-UX и аудит (фасет B/D — что копировать целиком)

**Страница `Connected Apps OAuth Usage`** (Setup → Quick Find → «OAuth»), official:
- Список **всех** OAuth-приложений — и установленных, и неустановленных.
- Колонка **User Count** — кликабельна, ведёт к детализации по пользователям.
- Для каждого пользователя: *«when they first used the app, most recent time they used the app,
  total number of times they used the app»*.
- Для неустановленных приложений показываются **отказы попыток использования**.
- Действия: **Revoke** (по пользователю) / **Revoke All** / **Block** (делает приложение
  недоступным и **обрывает все текущие сессии**) / **Unblock** / **Install** / **Uninstall** /
  **Manage App Policies**.

**Личный кабинет пользователя** (official KB 000205444):
- Личные настройки → Advanced User Details → секция **«OAuth Connected Apps»**.
- Показывается: имя приложения, история одобрений, **сколько раз** и **когда последний раз**
  приложение обращалось к данным.
- Кнопка **Revoke**: *«After you revoke the app, it can no longer access your Salesforce data.»*
- Одно приложение может фигурировать несколько раз (разные одобрения/скоупы) — надо отзывать все.

**Программный аудит** `[secondary: Salesforce Ben; поля объекта — official object reference]`:
```sql
SELECT Id, AppName, UserId, CreatedDate, LastUsedDate, UseCount, AppMenuItemId
FROM OAuthToken
```
- **Наличие `AppMenuItemId` = приложение установлено; отсутствие = неустановленное, но
  авторизованное** — то есть именно тот класс, который Salesforce и зарезал в сентябре 2025.
- `LastUsedDate` + `UseCount` — основа для «найди спящие интеграции и заблокируй».
- **Пробел их инструментария**: логины по username-password **не попадают** в OAuth usage —
  их приходится вылавливать экспортом Login History.

**Event Monitoring / Transaction Security**:
- `EventLogFile`, 50+ типов событий; доступен **через 24 часа** обычным клиентам и **ежечасно**
  клиентам Event Monitoring.
- Real-time events, релевантные ключам и API: `LoginEvent`, `ApiEvent`/`ApiEventStream`,
  `ApiAnomalyEvent`, `CredentialStuffingEvent`, `SessionHijackingEvent`, `ReportAnomalyEvent`,
  `PermissionSetEvent`, `UniqueQuery` (логирует выполненные SOQL).
- Transaction Security Policy actions: **Block / End Session / Require MFA / Notify**.
  MFA применима только к событиям с UI-контекстом входа; API-события поддерживают block и
  уведомления.
- `SessionHijackingEvent` при срабатывании **сам обрывает сессию и требует MFA**.

---

## 3. Инциденты и уязвимости + уроки

### 3.1. UNC6395 / Salesloft Drift — кража OAuth-токенов интегратора (август 2025)

**Первоисточник:** Google Cloud Threat Intelligence (GTIG/Mandiant) —
`cloud.google.com/blog/topics/threat-intelligence/data-theft-salesforce-instances-via-salesloft-drift`;
официальное объявление Salesforce — `status.salesforce.com/generalmessages/20000217`.

**Хронология (official):**
- **8–18 августа 2025** — активная эксплуатация.
- **9 августа 2025** — злоумышленник получил доступ и к OAuth-токенам «Drift Email».
- **20 августа 2025** — Salesloft совместно с Salesforce **отозвали все активные access и refresh
  токены** приложения Drift; Drift удалён с AppExchange.
- **26 августа 2025** — Mandiant привлечён к расследованию; расследование завершено **30 сентября
  2025**.
- **28 августа 2025** — объявлено расширение периметра: *«the scope of this compromise is not
  exclusive to the Salesforce integration… treat any and all authentication tokens stored in or
  connected to the Drift platform as potentially compromised»*; Google отозвал токены Drift Email
  и отключил интеграцию Workspace↔Drift.

**Механика:**
- Как именно были украдены токены, **GTIG не раскрывает** — сказано лишь «compromised OAuth
  tokens associated with the Salesloft Drift third-party application».
- Разведка простыми SOQL: `SELECT COUNT() FROM Account/Opportunity/User/Case`.
- Массовая выгрузка `User` (username, email, phone, LastLoginDate…) и `Case` (`LIMIT 10000`).
- **Цель — учётные данные внутри данных**: `AKIA` (AWS access keys), `Snowflake` /
  `snowflakecomputing.com`, `password`, `secret`, `key`, org-специфичные login URL.
  GTIG: *«the primary intent of the threat actor is to harvest credentials»*.
- User-Agent: `Salesforce-Multi-Org-Fetcher/1.0`, `Salesforce-CLI/1.0`, `python-requests/2.32.4`,
  `Python/3.11 aiohttp/3.12.15`.
- Инфраструктура: `208.68.36.90` (DigitalOcean), `44.215.108.109` (AWS) + около двух десятков
  Tor exit nodes (`185.220.101.*` и др.).
- **Анти-форензика**: *«UNC6395 demonstrated operational security awareness by deleting query
  jobs, however logs were not impacted»* — то есть чистили артефакты работы, но не журналы.

**Масштаб:** по оценкам — **более 700 организаций** `[secondary]`.

**Официальная позиция Salesforce:** проблема не в платформе, а в компрометации подключения
стороннего приложения.

**Рекомендации GTIG (official, релевантные нам):**
- Пересмотреть **scopes** connected apps, не давать `full`.
- Выставить IP Relaxation в **`Enforce IP restrictions`**.
- Задать **Login IP Ranges**.
- Снять `API Enabled` со всех, выдавать permission set-ом.
- Настроить **session timeout**.
- Искать секреты внутри бизнес-данных (`AKIA`, `password`, TruffleHog).
- Ротировать **все** креды всех интеграций с скомпрометированной платформой.

**Уроки для SuperApp6:**
1. **Долгоживущий refresh token третьей стороны = мастер-ключ ко всей организации.** Наш
   `app_installation` обязан иметь *обязательный* срок жизни refresh-токена (жёсткий максимум
   на уровне платформы, не на выбор арендатора) + rotation с reuse-detection.
2. **Скоуп `full` не должен существовать.** Максимум — `read:<service>` / `write:<service>`,
   проецируемые на наш `core/access`.
3. **Секреты живут в данных.** У нас есть чат, кейсы, документы, заметки. Нужен скан на
   паттерны секретов (наши собственные префиксы + AWS/GitHub/Slack) при индексации в
   `core/search` и при выдаче через API-ключ.
4. **Журналы должны быть неудаляемыми со стороны субъекта.** У нас `core/chatter` пишет в той же
   транзакции — но «удаление задания» (аналог query job) не должно удалять сам факт запроса.
   Отдельный immutable `api_access_log`.
5. **Массовая выгрузка через API-ключ — это аномалия, а не фича.** Нужен лимит на объём
   выгружаемых строк в единицу времени per-credential + событие аномалии.
6. **IP allow-list на уровне ключа обязателен** — и он не должен «расслабляться для refresh
   token», как у Salesforce.

### 3.2. UNC6040 — вишинг и подменённый Data Loader (первая половина 2025)

**Первоисточник:** GTIG —
`cloud.google.com/blog/topics/threat-intelligence/unc6040-proactive-hardening-recommendations`.

**Механика:**
- Звонок «из IT-поддержки» → жертву ведут на страницу подключения (**device flow**,
  `/setup/connect`) → просят ввести **8-значный код** → тем самым авторизуется перекрашенная
  копия Salesforce Data Loader (встречалось имя «My Ticket Portal»).
- Итог: **постоянный привилегированный доступ без MFA** (токен уже доверенный).
- ~20 организаций на первом этапе; далее эволюция — от Data Loader к собственным Python-скриптам,
  от trial-орг-ов к скомпрометированным аккаунтам `[secondary: The Hacker News, CyberScoop]`.

**Ответ Salesforce (официальный KB 005132365, объявлено 18.08.2025, действует с начала сентября
2025):**
- **Блокируется использование неустановленных (uninstalled) connected apps обычными
  пользователями.** Ранее авторизовавшие приложение пользователи сохраняют доступ; новые — нет.
- **Приложения, использующие OAuth 2.0 device flow и не установленные в орг-е, блокируются
  полностью — даже для тех, кто уже авторизовал.**
- Новое permission **`Approve Uninstalled Connected Apps`**, автоматически выдано профилю
  System Administrator.
- Существующее permission **`Use Any API Client`** — «ядерная» опция: позволяет использовать
  любые, в том числе заблокированные, приложения. При включённом API Access Control **только оно**
  даёт доступ к неустановленным приложениям.

**Уроки для SuperApp6:**
1. **Device flow — вектор социальной инженерии, а не просто «UX для телевизоров».** Если мы его
   делаем для POS-терминалов и IoT — он должен работать **только для приложений, заранее
   установленных организацией**, и только для устройств из инвентаря (`modules/objects` →
   `Asset`). Код подтверждения должен показывать **что именно** и **какой организации** даётся
   доступ, крупно и на языке зрителя.
2. **Экран согласия должен быть враждебен к «мне продиктовали код по телефону»**: явное
   предупреждение, задержка, обязательный step-up, и **журнал «кто авторизовал устройство»**
   с уведомлением администратора организации (`core/notifications`).
3. **Дефолт «любой пользователь может само-авторизовать приложение» — дыра.** У нас дефолт должен
   быть обратный: приложение в организацию ставит только `admin`/`owner`, пользователь может лишь
   дать согласие внутри уже установленного приложения.

### 3.3. Experience Cloud / Communities — guest user misconfiguration (2023)

- Не уязвимость платформы, а **ошибка конфигурации прав**: гостевому (неаутентифицированному)
  профилю выдавались права чтения объектов; данные вычитывались через **Aura-эндпоинт** без
  логина. Утекали SSN, банковские реквизиты, федеральные ID `[secondary: Varonis,
  KrebsOnSecurity, Coalition]`.
- Salesforce ответил отдельным официальным материалом «Protecting Your Data: Essential Actions to
  Secure Experience Cloud Guest User Access» `[official blog]`.
- Позднее злоумышленники стали **массово сканировать** публичные Experience Cloud сайты в поисках
  таких настроек `[secondary: Valence]`.

**Урок для SuperApp6:** наш `core/share-links` (гостевые страницы `/s/`) и любые публичные
витрины — это ровно тот же класс риска. Правило: **гость не получает проекцию прав, он получает
явный, узкий, подписанный контракт на конкретный объект**. Никаких «профилей гостя» с правами
на тип сущности.

### 3.4. Что ещё стоит знать про «утечку ключей наружу»

- GitHub secret scanning: в марте 2026 добавлен детектор
  **`salesforce_marketing_cloud_api_oauth2_token`** (partner program, user alerts, push protection
  по умолчанию) `[official GitHub changelog]`.
- **Детектора для основного Salesforce consumer key/secret в этом наборе нет.** Утверждение о
  префиксе `3MVG9` у consumer key встречается в сообществе, но **первоисточником не подтверждено**
  — `[не проверено]`.
- Внутренний инструмент Salesforce `salesforce/lobster-pot` — сканирует каждый git push в их
  GitHub-организациях на секреты `[official repo]`.

**Урок:** если у нас будут org API keys, мы **обязаны** (а) сделать распознаваемый префикс,
(б) подать заявку в GitHub Secret Scanning Partner Program и реализовать endpoint отзыва,
(в) сканировать собственные репозитории. Salesforce это для core-платформы так и не сделал.

---

## 4. Что SuperApp6 должен скопировать

### 4.1. Модель сущностей (прямая калька ECA)

| Наша сущность | Аналог Salesforce | Почему |
|---|---|---|
| `app_definition` (издатель) | `ExtlClntAppOauthSettings` (packageable) | redirect URIs, grant types, требование PKCE, заявленные scopes — принадлежат разработчику |
| `app_installation` (арендатор) | `ExtlClntAppOauthConfigurablePolicies` | кому разрешено, IP allow-list, TTL refresh, требование step-up — принадлежат организации |
| `app_credential` | consumer key/secret + staged | **много** одновременных секретов с `kid` и `expires_at` |
| `grant` / `authorization` | OAuthToken | `first_used_at`, `last_used_at`, `use_count`, scopes-снимок |

**Разделение «настройки разработчика» vs «политики арендатора» — главное, что надо унести.**
Salesforce переписывает 12-летнюю подсистему именно из-за того, что этого раскола не сделал.

### 4.2. Секреты и ротация

1. **Staged → Apply** как модель ротации, но **без «10 минут хаоса»**: держим одновременно
   `current` и `previous` секрет с явными сроками, `previous` истекает по таймеру (например
   7 суток) или досрочно по кнопке «Revoke old now».
2. **Отдельное право на ротацию** — аналог `Allow consumer key and secret rotation`, не
   сливающееся с «администратор организации».
3. **Step-up перед показом/генерацией секрета** и **окно валидности подтверждения** (у них 5
   минут). Наш `core/verify` это умеет, но SMS-OTP для этого — слабо (см. §5).
4. **Show-once**: секрет хранится только как хэш (Argon2id/scrypt для org-ключей), показывается
   один раз. Salesforce, в отличие от нас, secret **показывает повторно** — это их слабость,
   компенсируемая step-up. Нам лучше show-once + возможность ротации.
5. **Префикс для secret scanning**: `sa6_org_`, `sa6_pat_`, `sa6_bot_`, `sa6_whk_` + контрольная
   сумма в хвосте. Плюс публичный revocation endpoint для партнёрских программ сканирования.

### 4.3. Токены

1. **Refresh Token Rotation с reuse-detection — по умолчанию и без возможности выключить.**
   Формулировка Salesforce фактически описывает RFC 6819: использование «прокрученного» токена
   убивает всю цепочку.
2. **Жёсткий потолок жизни refresh-токена на уровне платформы.** У Salesforce дефолт
   `Valid until revoked` — и это ровно то, что сделало Drift-инцидент возможным. У нас дефолт:
   `expire if not used for 30 days` + абсолютный максимум (например 180 дней), после которого
   требуется повторное согласие.
3. **Access token = короткий** (у них привязан к таймауту сессии, дефолт 2 ч — это много для
   B2B API). Наш ориентир: 10–15 минут для API-ключей организации, 60 минут для интерактивных.
4. **Scopes хранятся вместе с refresh-токеном** (снимок на момент согласия) — как у Salesforce.
   Расширение прав = новое согласие.
5. **Introspection + revocation эндпоинты** (`/oauth/introspect`, `/oauth/revoke`) — RFC 7662 /
   RFC 7009, как у них.
6. **Лимит одобрений на пользователя на приложение** (у них 5, старейшее вытесняется) — хорошая
   защита от накопления «мусорных» долгоживущих грантов.

### 4.4. Flows

- **Authorization Code + PKCE обязателен**, отдельный флаг «требовать PKCE» на уровне
  `app_definition` — как у них.
- **Client Credentials только с явным «Run As» субъектом** и с **принудительным вырезанием**
  опасных scopes (аналог их вырезания `full`/`web`/`refresh_token`).
- **JWT Bearer** для машин: `iss`/`aud`/`sub`/`exp`, узкое окно рассинхрона часов (у них 3 мин),
  **никогда не выдавать refresh token**, требовать предварительной авторизации субъекта.
- **Implicit / user-agent flow не реализовывать вовсе** — Salesforce сам называет его
  «considered insecure».
- **Username-password flow не реализовывать никогда.**
- **Device flow** — только для установленных организацией приложений и инвентаризованных
  устройств (см. §3.2).
- **Token Exchange (RFC 8693)** — для AI-агентов (фасет F): агент приходит с токеном субъекта и
  получает **узкий, короткоживущий, делегированный** токен. Salesforce делает это через Apex-
  handler; у нас — через способность в `core/access`, решающую «какой набор capability получает
  агент от имени этого человека».
- **Asset Token flow** — отличная идея для POS/IoT: «регистрация устройства» и «выдача токена»
  — одна операция, устройство сразу привязано к объекту (`modules/objects` → `Asset`).

### 4.5. Ключевая иерархия (фасет A)

Копируем структуру Shield один в один, упрощая реализацию:

```
KEK (master) в KMS/HSM (или в env для dev) — версионируется
        │
        ├─ per-workspace secret (ротируемый, статус ACTIVE/ARCHIVED/DESTROYED)
        │       │  HKDF-SHA256 (вместо PBKDF2 — быстрее и уместнее для не-паролей)
        │       ▼
        │   DEK (не персистится, живёт в кэше с TTL)
        │
        └─ signing keys (JWT/webhook) — отдельное дерево, свои kid и срок
```

Правила, взятые у них дословно:
- **DEK никогда не хранится**; только кэш с TTL и пересоздание.
- **Статусы ключа**, а не «номер версии»: ACTIVE / ARCHIVED / DESTROYED.
- **Ротация ≠ перешифрование**: отдельный фоновой джоб «синхронизация шифрования»
  (`core/jobs`, идемпотентный, с прогрессом).
- **Уничтожение ключа возможно только после синхронизации данных.**
- **Отдельное право `manage_encryption_keys`**, не сливающееся с `admin`/`owner`.
- **Лимит на число живых версий ключа** (у них 50) — чтобы дерево не разрасталось.
- Идентификация ключа при расшифровке — по `kid`, записанному рядом с шифротекстом
  (у них — по дате создания tenant secret; `kid` явно лучше).
- Каждое действие с ключом — событие в Setup-Audit-аналоге (`core/chatter` + отдельный
  key-audit-журнал) и уведомление кастодианам.

### 4.6. Админ-UX (копировать почти целиком)

Страница «Интеграции и ключи» организации:
- Таблица: приложение/ключ · сколько пользователей · **когда впервые** · **когда последний раз** ·
  сколько раз · scopes · IP allow-list · статус.
- Действия: **Отозвать у пользователя** · **Отозвать всё** · **Заблокировать** (обрывает текущие
  сессии) · **Разблокировать** · **Удалить**.
- **Отдельно — отказанные попытки** неустановленных приложений (у Salesforce это есть и это
  спасает: видно попытку атаки).
- Личный кабинет человека: свой список подключённых приложений с датой последнего обращения и
  кнопкой «Отозвать» — как их «OAuth Connected Apps».
- **Deny-by-default режим** (аналог API Access Control) — но у нас он должен быть **дефолтом**,
  а не опцией по заявке в поддержку.

### 4.7. Мониторинг и реакция

- События: `api_key.used`, `api_key.denied`, `oauth.consent_granted`, `oauth.token_rotated`,
  `oauth.reuse_detected`, `key.rotated`, `key.destroyed`, `secret.viewed`.
- Аномалии: всплеск объёма выгрузки, новый IP/ASN, новый user-agent, обращение в нерабочие часы.
- Политики реакции — как их Transaction Security: **Block / End Session / Require step-up /
  Notify**. Для API-кредов доступны только Block и Notify (MFA бессмысленна) — ровно как у них.

---

## 5. Что копировать НЕЛЬЗЯ (ловушки)

1. **Дефолт «All users may self-authorize».** Стоил Salesforce кампании UNC6040. Наш дефолт —
   только администратор организации ставит приложение.
2. **Дефолт `Refresh token is valid until revoked`.** Стоил кампании UNC6395. Бессрочный
   refresh-токен — это пароль без срока и без владельца.
3. **Скоуп `full`.** Само его существование обесценивает всю систему scopes. Не заводить.
4. **Security token (пароль №2 по e-mail).** Наследие 2000-х: секрет высылается по почте,
   приписывается к паролю, живёт вечно. Абсолютный анти-паттерн.
5. **Username-password flow «для совместимости».** Salesforce тратит 4 года (2023→2027) на то,
   чтобы его убрать. Не заводить вообще.
6. **Ротация секрета, отзывающая все токены, с 10-минутным окном неопределённости.** У нас
   должно быть N валидных секретов с `kid` и детерминированным переходом.
7. **«Deny-by-default только по заявке в поддержку» (их API Access Control).** Безопасный режим
   не должен быть привилегией — он должен быть дефолтом.
8. **`Relax IP restrictions for refresh tokens`.** Настройка, которая отменяет IP-контроль ровно
   в том месте, где он важнее всего. Не делать.
9. **Webhook без подписи (их Outbound Messages).** Проверка `OrganizationId` в теле — это не
   аутентификация, это «пароль в открытом виде». Нам нужны: HMAC-SHA256 по сырому телу,
   заголовок с `timestamp` + `kid` + защита от replay, ротация webhook-секрета с перекрытием
   (два активных секрета), и опционально mTLS.
10. **Смешивание «паспорта разработчика» и «политики арендатора» в одной записи.** Это и есть
    причина, по которой Salesforce переписывает Connected Apps.
11. **Разрешение вроде `Use Any API Client` («обойти всё»).** Если такое право существует, оно
    рано или поздно окажется в профиле, раздаваемом по умолчанию. Если аварийный обход нужен —
    он должен быть временным, с явным сроком, «четырьмя глазами» и записью в журнал (у нас
    `core/platform` это уже умеет).
12. **SMS-OTP как step-up для операций с ключами.** Salesforce с июля 2026 прямо запрещает SMS
    и TOTP для привилегированных ролей. Наш `core/verify` (SMS-OTP) для просмотра/ротации
    ключей недостаточен — нужен WebAuthn/passkey или ЭЦП (`core/sign`).
13. **Доверие «установленному» приложению навсегда.** У Salesforce «установлено» = доверено.
    Нужен периодический пересмотр: отчёт «интеграции, не использовавшиеся 90 дней» и
    автоматическое замораживание.
14. **Кэш ключей на 72 часа (их EKM).** При отзыве ключа клиентом данные остаются
    расшифровываемыми до трёх суток. Если мы делаем аналог — TTL кэша минуты, а не часы, плюс
    принудительный сброс кэша при отзыве.
15. **`interaction_api`-подобные «зарезервированные на будущее» scopes** в публичном каталоге.
    Мусор в контракте, который клиенты начинают запрашивать «на всякий случай».

---

## 6. Открытые вопросы (не удалось подтвердить первоисточником)

1. **Точная длина/формат consumer key и consumer secret** Salesforce и наличие префикса `3MVG9`.
   В официальной документации формат не описан. `[не проверено]`
2. **Grace period при refresh token rotation** — есть ли окно, в котором старый токен ещё
   принимается (для гонок параллельных запросов). Документация упоминает только ошибку
   «Token request is already being processed». `[не проверено]`
3. **Точная дата принудительного отключения username-password flow (20 февраля 2027)** —
   встречается в secondary-источниках; официальная страница release note
   `rn_security_unpw_flow_retirement` не отдалась при загрузке. `[secondary]`
4. **Точный диапазон значений session timeout** (15 минут – 12 часов vs 24 часа) —
   secondary-источники расходятся. `[не проверено]`
5. **Срок хранения Setup Audit Trail** (обычно называют 6 месяцев в UI и 180 дней/5 лет при
   выгрузке) — подтвердить не удалось, страница не отдалась. `[не проверено]`
6. **Точные режимы шифрования Shield** (AES-256-CBC + PKCS#5 + random IV) взяты из патентов
   Salesforce, а не из help-документации; в help заявлена только «256-bit encryption strength».
   `[official-adjacent]`
7. **Как именно были украдены OAuth-токены Drift** — GTIG явно отказался раскрывать.
   `[не раскрыто первоисточником]`
8. **Точный TTL кэша cache-only key** — для EKM в доке указано «~72 часа», для cache-only key
   отдельное значение подтвердить не удалось. `[частично проверено]`
9. **Наличие HMAC-подписи у Outbound Messages** — отсутствие подтверждается только косвенно
   (в официальной доке описаны лишь OrganizationId и клиентский сертификат). `[inference]`
10. **Полный список типов Transaction Security Policy с матрицей доступных действий** — страница
    не отдалась целиком. `[частично проверено]`
11. **Как Agentforce технически ограничивает агента при работе «от имени пользователя»**
    (проверка прав на каждом tool call) — описано в secondary-источниках, официальную
    формулировку найти не удалось. `[secondary]`
12. **Число Salesforce-паттернов в GitHub Secret Scanning на сегодня** — полная таблица
    docs.github.com не отдалась (404/редирект). Подтверждён только
    `salesforce_marketing_cloud_api_oauth2_token`. `[частично проверено]`

> Отдельное предупреждение: в выдаче встретился материал (`rescana.com`), датирующий
> инцидент Salesloft Drift **июнем 2026** и называющий его «Icarus». Это противоречит
> первоисточникам (GTIG, Salesloft Trust Center, status.salesforce.com), которые единогласно
> указывают **август 2025**. Материал считаю недостоверным и в отчёте не использую.

---

## 7. Источники

### Официальные (Salesforce)

1. [official] External Client Apps and Connected Apps — https://help.salesforce.com/s/articleView?id=xcloud.external_integrations.htm&language=en_US&type=5
2. [official] Comparison of Connected Apps and External Client Apps Features — https://help.salesforce.com/s/articleView?id=xcloud.connected_apps_and_external_client_apps_features.htm&language=en_US&type=5
3. [official] OAuth Authorization Flows — https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_flows.htm&language=en_US&type=5
4. [official] Manage OAuth Access Policies for a Connected App — https://help.salesforce.com/s/articleView?id=sf.connected_app_manage_oauth.htm&language=en_US&type=5
5. [official] View and Rotate the Consumer Key and Consumer Secret — https://help.salesforce.com/s/articleView?id=xcloud.connected_app_rotate_consumer_details.htm&language=en_US&type=5
6. [official] OAuth Tokens and Scopes — https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_oauth_tokens_scopes.htm&language=en_US&type=5
7. [official] Enable OAuth Settings for API Integration — https://help.salesforce.com/s/articleView?id=sf.connected_app_create_api_integration.htm&language=en_US
8. [official] OAuth 2.0 Refresh Token Flow (+ Refresh Token Rotation) — https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_oauth_refresh_token_flow.htm&language=en_US&type=5
9. [official] OAuth 2.0 JWT Bearer Flow — https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_oauth_jwt_flow.htm&language=en_US&type=5
10. [official] OAuth 2.0 Client Credentials Flow — https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_oauth_client_credentials_flow.htm&language=en_US&type=5
11. [official] OAuth 2.0 Device Flow — https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_oauth_device_flow.htm&language=en_US&type=5
12. [official] OAuth 2.0 Asset Token Flow for Securing Connected Devices — https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_asset_token_flow.htm&language=en_US&type=5
13. [official] OAuth 2.0 Token Exchange Flow — https://help.salesforce.com/s/articleView?id=sf.remoteaccess_token_exchange_overview.htm&language=en_US&type=5
14. [official] OpenID Connect Token Introspection — https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_oidc_token_introspection_endpoint.htm&language=en_US&type=5
15. [official] OIDC Dynamic Client Registration for External API Gateways — https://help.salesforce.com/s/articleView?id=remoteaccess_oidc_dynamic_client_reg_flow.htm&language=en_US&type=5
16. [official] Manage API Access (API Access Control) — https://help.salesforce.com/s/articleView?id=xcloud.security_api_access_control_about.htm&language=en_US&type=5
17. [official] Manage Current OAuth Connected App Sessions / Connected Apps OAuth Usage — https://help.salesforce.com/s/articleView?id=sf.connected_app_manage_current_sessions.htm&language=en_US&type=5
18. [official] Manage OAuth-Enabled Connected Apps Access to Your Data (KB 000205444) — https://help.salesforce.com/s/articleView?id=000205444&language=en_US&type=1
19. [official] Prepare for Connected App Usage Restrictions Change (KB 005132365) — https://help.salesforce.com/s/articleView?id=005132365&language=en_US&type=1
20. [official] Security Updates to the "Use Any API Client" Permission (KB 005228838) — https://help.salesforce.com/s/articleView?id=005228838&language=en_US&type=1
21. [official] Prepare for Phishing-Resistant MFA Enforcement (KB 005321563) — https://help.salesforce.com/s/articleView?id=005321563&language=en_US&type=1
22. [official] OAuth 2.0 Username-Password Flow Blocked by Default (release note, 244) — https://help.salesforce.com/s/articleView?id=release-notes.rn_security_username-password_flow_blocked_by_default.htm&language=en_US&release=244&type=5
23. [official] Retirement of OAuth 2.0 Username-Password Flow (release note, 262) — https://help.salesforce.com/s/articleView?id=release-notes.rn_security_unpw_flow_retirement.htm&language=en_US&release=262&type=5
24. [official] Prepare for Connected App Usage Restriction (release note, 256) — https://help.salesforce.com/s/articleView?id=release-notes.rn_security_connected_app_restrictions.htm&language=en_US&release=256&type=5
25. [official] Control Connected App Creation on New Orgs (release note, 256) — https://help.salesforce.com/s/articleView?id=release-notes.rn_security_connected_app_ui_change.htm&language=en_US&release=256&type=5
26. [official] Migrate to a Local External Client App (release note, 252) — https://help.salesforce.com/s/articleView?id=release-notes.rn_security_id_eca_migration.htm&language=en_US&release=252&type=5
27. [official] Reset Your Security Token — https://help.salesforce.com/s/articleView?id=xcloud.user_security_token.htm&language=en_US&type=5
28. [official] Authentication Protocols for Named Credentials — https://help.salesforce.com/s/articleView?id=xcloud.nc_auth_protocols.htm&language=en_US&type=5
29. [official] Named Credentials — Get Started — https://developer.salesforce.com/docs/platform/named-credentials/guide/get-started.html
30. [official] How Shield Platform Encryption Works — https://help.salesforce.com/s/articleView?id=xcloud.security_pe_concepts.htm&language=en_US&type=5
31. [official] Rotate Your Encryption Key Material — https://developer.salesforce.com/docs/atlas.en-us.securityImplGuide.meta/securityImplGuide/security_pe_rotate_keys.htm
32. [official] Cache-Only Key Service — https://help.salesforce.com/s/articleView?id=sf.security_pe_byok_cache.htm&language=en_US&type=5
33. [official] Configure Your Cache-Only Key Callout Connection — https://developer.salesforce.com/docs/atlas.en-us.securityImplGuide.meta/securityImplGuide/security_pe_byok_cache_callout.htm
34. [official] External Key Management Flow — https://help.salesforce.com/s/articleView?id=xcloud.security_shield_pe_ekm_flow.htm&language=en_US&type=5
35. [official] External Key Management (EKM) Option — https://help.salesforce.com/s/articleView?id=xcloud.security_shield_pe_external_key_management_ekm.htm&language=en_US&type=5
36. [official] Filter Encrypted Data with Deterministic Encryption — https://developer.salesforce.com/docs/atlas.en-us.securityImplGuide.meta/securityImplGuide/security_pe_deterministic.htm
37. [official] Shield Platform Encryption Architecture White Paper (PDF) — https://www.salesforce.com/en-us/wp-content/uploads/sites/4/documents/ocms/assets/pdf/misc/platform-encryption-architecture-white-paper.pdf
38. [official] Trailhead — Explore Encryption Techniques with Shield Platform Encryption — https://trailhead.salesforce.com/content/learn/modules/spe_admins/spe_admins_get_started
39. [official] Modify Session Security Settings — https://help.salesforce.com/s/articleView?id=xcloud.admin_sessions.htm&language=en_US&type=5
40. [official] MFA Auto-Enablement Continues and MFA Enforcement Begins with Summer '24 — https://help.salesforce.com/s/articleView?id=release-notes.rn_general_mfa_requirement.htm&language=en_US&release=246&type=5
41. [official] Types of Transaction Security Policies — https://help.salesforce.com/s/articleView?id=xcloud.enhanced_transaction_security_policy_list.htm&language=en_US&type=5
42. [official] EventLogFile Supported Event Types — https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_eventlogfile_supportedeventtypes.htm
43. [official] Pub/Sub API — Authentication — https://developer.salesforce.com/docs/platform/pub-sub-api/guide/supported-auth.html
44. [official] Pub/Sub API — Include Authorization Headers in RPC Method Calls — https://developer.salesforce.com/docs/platform/pub-sub-api/guide/rpc-method-headers.html
45. [official] Agentforce APIs and SDKs — Get Started (Agent API) — https://developer.salesforce.com/docs/einstein/genai/guide/agent-api-get-started.html
46. [official] Give Users Access to Agentforce (Default) — https://help.salesforce.com/s/articleView?id=ai.copilot_setup_user_access.htm&language=en_US&type=5
47. [official] Import a Client Certificate for Your Endpoint URL (Outbound Messages) — https://help.salesforce.com/s/articleView?id=wf_outbound_messages_client_cert.htm&language=en_US&type=5
48. [official] ExternalClientApplication (Metadata API) — https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_externalclientapplication.htm
49. [official] ExternalClientAppSettings (Metadata API) — https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_externalclientappsettings.htm
50. [official] External Client Apps Creation with Metadata API — https://help.salesforce.com/s/articleView?id=xcloud.meta_external_client_apps_creation.htm&language=en_US&type=5
51. [official] Create an External Client App (Hosted MCP Servers) — https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/create-external-client-app.html
52. [official] Source Code Scanner on the Partner Security Portal — https://developer.salesforce.com/docs/platform/isvforce/guide/security-review-partner-security-portal-scanners.html
53. [official] Periodic Security Re-Reviews on AppExchange — https://developer.salesforce.com/docs/atlas.en-us.packagingGuide.meta/packagingGuide/security_review_periodic_reviews.htm
54. [official] Salesforce Security Advisory (Drift) — https://status.salesforce.com/generalmessages/20000217
55. [official] Protecting Your Data: Essential Actions to Secure Experience Cloud Guest User Access — https://www.salesforce.com/blog/protecting-your-data-essential-actions-to-secure-experience-cloud-guest-user-access/
56. [official] Get Ready: Changes to Connected App Usage Restrictions Coming This September — https://admin.salesforce.com/blog/2025/get-ready-for-changes-to-connected-app-usage-restrictions
57. [official] Best Practices for Configuring Your Integration User — https://admin.salesforce.com/blog/2023/best-practices-for-configuring-your-integration-user
58. [official] Using the Client Credentials Flow for Easier API Authentication — https://developer.salesforce.com/blogs/2023/03/using-the-client-credentials-flow-for-easier-api-authentication
59. [official] forcedotcom/CacheOnlyKeyWrapper — https://github.com/forcedotcom/CacheOnlyKeyWrapper
60. [official] salesforce/lobster-pot — https://github.com/salesforce/lobster-pot
61. [official] Salesforce on Alibaba Cloud: Changes and Preparations for Connected App Creation — https://help.aliyun.com/en/sfoa/product-overview/prepare-for-restricting-connected-app-creation-on-salesforce-on-alibaba-cloud
62. [official] MuleSoft — Obtaining the Client Credentials of a Registered Client Application — https://docs.mulesoft.com/api-manager/latest/access-client-app-id-task

### Официальные (не Salesforce)

63. [official] Google Cloud / GTIG — Widespread Data Theft Targets Salesforce Instances via Salesloft Drift — https://cloud.google.com/blog/topics/threat-intelligence/data-theft-salesforce-instances-via-salesloft-drift
64. [official] Google Cloud / GTIG — UNC6040 Proactive Hardening Recommendations — https://cloud.google.com/blog/topics/threat-intelligence/unc6040-proactive-hardening-recommendations
65. [official] Salesloft/Clari Trust Center — Drift/Salesforce Security Update — https://trust.salesloft.com/?uid=Drift%2FSalesforce+Security+Notification
66. [official] GitHub Changelog — secret scanning coverage update (март 2026) — https://github.blog/changelog/2026-03-31-github-secret-scanning-nine-new-types-and-more/
67. [official] GitHub Docs — Supported secret scanning patterns — https://docs.github.com/en/enterprise-cloud@latest/code-security/reference/secret-security/supported-secret-scanning-patterns
68. [official-adjacent] Патент Salesforce US 9087212 «Methods and apparatus for securing a database» — https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/9087212
69. [official-adjacent] Патент Salesforce US 10594490 «Filtering encrypted data using indexes» — https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10594490

### Вторичные

70. [secondary] Salesforce Ben — External Client vs. Connected Apps — https://www.salesforceben.com/external-client-vs-connected-apps-comparing-salesforces-next-gen-integration/
71. [secondary] Salesforce Ben — Salesforce Hardens Connected Apps Security Amid Social Engineering Attacks — https://www.salesforceben.com/salesforce-hardens-connected-apps-security-amid-social-engineering-attacks/
72. [secondary] Salesforce Ben — A Salesforce Admin's Guide to Auditing Connected Apps — https://www.salesforceben.com/a-salesforce-admins-guide-to-auditing-connected-apps/
73. [secondary] Salesforce Ben — Agentforce Permissions Explained: Agent Users, Access, and Security — https://www.salesforceben.com/agentforce-permissions-explained-agent-users-access-and-security/
74. [secondary] Salesforce Ben — How to Set Up Free API Only Integration Users — https://www.salesforceben.com/how-to-set-up-free-api-only-integration-users/
75. [secondary] Justus van den Berg — Rethinking Salesforce Integration Architecture: The Leap to External Client Apps — https://medium.com/@justusvandenberg/rethinking-salesforce-integration-architecture-the-leap-to-external-client-apps-b9a0489c8773
76. [secondary] Metazoa — ExtlClntAppOauthConfigurablePolicies — https://support.metazoa.com/hc/en-us/articles/35530862862221-ExtlClntAppOauthConfigurablePolicies
77. [secondary] Hookdeck — Guide to Salesforce Webhooks: Features and Best Practices — https://hookdeck.com/webhooks/platforms/guide-to-salesforce-webhooks-features-and-best-practices
78. [secondary] Varonis — Salesforce Misconfiguration Causes Sensitive Data Leaks — https://www.varonis.com/blog/salesforce-misconfiguration-causes-sensitive-data-leaks
79. [secondary] Varonis — Abusing Misconfigured Salesforce Experiences for Recon and Data Theft — https://www.varonis.com/blog/misconfigured-salesforce-experiences
80. [secondary] Coalition Security Labs — Critical Data Exposure in Salesforce Experience Cloud — https://www.coalitioninc.com/blog/security-labs/security-alert-salesforce-experience-cloud
81. [secondary] Unit 42 — Threat Brief: Salesloft Drift Integration Used To Compromise Salesforce Instances — https://unit42.paloaltonetworks.com/threat-brief-compromised-salesforce-instances/
82. [secondary] Arctic Wolf — Widespread Salesforce Data Theft via Compromised Salesloft Drift OAuth Tokens — https://arcticwolf.com/resources/blog/widespread-salesforce-data-theft-via-compromised-salesloft-drift-oauth-tokens/
83. [secondary] AppOmni — Drift Breach (UNC6395): Why Salesforce OAuth Integrations are a Growing Risk — https://appomni.com/blog/drift-breach-salesforce-unc6395-saas-prevention/
84. [secondary] AppOmni — How Salesforce API Access Control Stops Rogue Apps Like UNC6040's Data Loader Attack — https://appomni.com/blog/block-rogue-salesforce-apps-unc6040-dataloader-attack/
85. [secondary] The Hacker News — Google Exposes Vishing Group UNC6040 Targeting Salesforce — https://thehackernews.com/2025/06/google-exposes-vishing-group-unc6040.html
86. [secondary] The Hacker News — Salesloft Takes Drift Offline After OAuth Token Theft — https://thehackernews.com/2025/09/salesloft-takes-drift-offline-after.html
87. [secondary] CyberScoop — Salesforce customers duped by series of social-engineering attacks — https://cyberscoop.com/google-unc6040-salesforce-attacks/
88. [secondary] Mitiga — Salesforce Data Loader Exfiltration Attack Explained — https://www.mitiga.io/blog/how-threat-actors-used-salesforce-data-loader-for-covert-api-exfiltration
89. [secondary] Jitendra Zaa — Salesforce Shield Platform Encryption: Complete Guide — https://www.jitendrazaa.com/blog/salesforce/salesforce-shield-platform-encryption-complete-guide-setup/
90. [secondary] Nebula Consulting — Understanding External Credentials in Salesforce — https://nebulaconsulting.co.uk/insights/learn-what-external-credentials-mean-for-you-and-your-salesforce-org/
91. [secondary] Concret.io — Salesforce Connected App vs External Client App (ECA) Guide — https://www.concret.io/blog/salesforce-connected-app-vs-external-client-app
92. [secondary] Arkus — Salesforce Connected App Security Changes: What Actually Happened — https://www.arkusinc.com/archive/2026/salesforce-connected-app-security-changes-what-actually-happened-and-what-you-need-to-do
93. [ненадёжный, НЕ использован] Rescana — датирует инцидент Drift июнем 2026, противоречит первоисточникам — https://www.rescana.com/post/salesloft-drift-oauth-token-breach-enables-salesforce-data-theft-in-unc6395-icarus-attack-campaign-august-2026

---

## Приложение: чек-лист «взять в дизайн `core/keys`»

- [ ] Раскол `app_definition` (издатель) / `app_installation` (арендатор) — как ECA.
- [ ] Множественные одновременные секреты с `kid` + `expires_at`, staged→apply без окна хаоса.
- [ ] Отдельное право на ротацию + step-up (WebAuthn/ЭЦП, НЕ SMS) + окно валидности подтверждения.
- [ ] Show-once, хранение только хэша, префиксы `sa6_*` + заявка в GitHub Secret Scanning.
- [ ] Refresh token rotation + reuse detection — принудительно.
- [ ] Жёсткий платформенный потолок жизни refresh-токена; нет режима «until revoked».
- [ ] Снимок scopes на момент согласия; расширение = новое согласие.
- [ ] Нет `full`; нет implicit; нет username-password; device flow — только для установленных
      приложений и инвентаризованных устройств.
- [ ] Client-credentials только с явным субъектом (`run_as`) и урезанием опасных scopes.
- [ ] Token Exchange (RFC 8693) как механизм делегирования для AI-агентов.
- [ ] Asset-token-подобная атомарная «регистрация устройства + выдача токена» для POS/IoT.
- [ ] Иерархия KEK → per-workspace secret → DEK (не персистится, кэш с коротким TTL).
- [ ] Статусы ключа ACTIVE/ARCHIVED/DESTROYED, лимит версий, отдельный джоб ре-энкрипта,
      уничтожение только после синхронизации.
- [ ] Отдельное право `manage_encryption_keys`, кастодианы, неудаляемый key-audit.
- [ ] Webhook: HMAC-SHA256 по сырому телу + timestamp + `kid` + два активных секрета + mTLS опц.
- [ ] Deny-by-default для API (аналог API Access Control) — дефолт, а не опция.
- [ ] Экран «Интеграции и ключи»: first_used/last_used/use_count/scopes/IP, Revoke/Revoke All/
      Block, отдельно — отказанные попытки.
- [ ] Личный кабинет: свои подключённые приложения + кнопка «Отозвать».
- [ ] События и политики реакции (Block / End Session / Require step-up / Notify).
- [ ] Скан секретов внутри пользовательских данных (чат, кейсы, заметки) и лимит объёма выгрузки
      на кредо.
