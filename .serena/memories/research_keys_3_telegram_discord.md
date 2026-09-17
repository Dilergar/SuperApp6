# B2C-бенчмарк для `core/keys`: Telegram, Discord (+ Apple/Google)

> **Примечание о размещении файла.** Задание требовало записать отчёт в
> `…/scratchpad/research/04-b2c-telegram-discord.md`. На момент записи сессия находится
> в plan mode, где единственный разрешённый к записи файл — этот план. Содержимое ниже —
> полный отчёт; его достаточно скопировать по нужному пути.
>
> Дата исследования: 13 сентября 2026. Все факты помечены: **[official]** — проверено на
> первоисточнике; **[secondary]** — вторичный источник; **[inference]** — мой вывод;
> **[не подтверждено]** — не удалось проверить у первоисточника.

---

## 1. Executive summary (15 пунктов)

1. **Telegram и Discord решают одну задачу принципиально по-разному на вебхуках.** Telegram даёт
   лишь «общий секрет в заголовке» (`X-Telegram-Bot-Api-Secret-Token`) плюс список исходящих
   подсетей; Discord подписывает каждый запрос **Ed25519** над `timestamp + raw body`
   (`X-Signature-Ed25519` / `X-Signature-Timestamp`). Модель Discord строго сильнее: секрет не
   передаётся, есть привязка ко времени, есть защита от повтора. **Копировать Discord.**
2. **Discord активно ПРОВЕРЯЕТ, что интегратор проверяет подпись:** периодически шлёт заведомо
   невалидные подписи и, если endpoint отвечает 2xx, **удаляет interactions URL и уведомляет
   владельца письмом и системным DM**. Это редчайший пример «платформа тестирует клиента».
3. **Telegram сам ушёл от самодельного HMAC к стандартному OIDC.** Login Widget сегодня —
   полноценный OpenID Connect (`https://oauth.telegram.org/…`, PKCE S256, JWKS, ID token,
   RS256/ES256/EdDSA/ES256K), а старая схема «data-check-string + HMAC-SHA256(SHA256(bot_token))»
   переведена в архив `/widgets/login-legacy`. Вывод для нас: «Вход через SuperApp6» сразу делать
   на OIDC, а не изобретать подпись.
4. **Два похожих механизма Telegram используют РАЗНЫЙ вывод ключа** — Login Widget:
   `key = SHA256(bot_token)`; Mini Apps: `key = HMAC_SHA256(bot_token, "WebAppData")` (сообщение и
   ключ переставлены). Это исторический источник ошибок интеграторов. Одна схема на всю платформу.
5. **Mini Apps получили Ed25519-подпись для третьих сторон** (поле `signature`, публичные ключи
   опубликованы в доке): теперь проверить `initData` можно **без знания токена бота**. Это ровно тот
   паттерн, который нужен нам для «мини-приложений партнёров внутри SuperApp6».
6. **Bot-токен Telegram — антипример дизайна:** передаётся **в URL**
   (`api.telegram.org/bot<token>/method`), один-единственный активный, без скоупов, без срока
   действия, без ротации с перекрытием. Регенерация (`/token` у BotFather) = гарантированный
   даунтайм.
7. **Discord-токен — образец «публичный id + секрет»:** первая из трёх точечно-разделённых частей —
   base64 от snowflake-id приложения, то есть владельца можно определить, не имея валидного
   секрета. Нам нужен такой же `key_id` внутри строки ключа.
8. **Утечки: Discord — партнёр GitHub secret scanning, Telegram — нет.** В официальной таблице
   GitHub для `discord_bot_token` включены *partner alerts* + *push protection* + *validity checks*,
   а для `telegram_bot_token` — только *user alerts* + *validity checks*. Практический результат:
   слитый в публичный репозиторий Discord-токен сбрасывается автоматически, Telegram-токен —
   остаётся живым (в дикой природе находят тысячи рабочих).
9. **Отзыв у Discord — на уровне АВТОРИЗАЦИИ, а не токена:** `POST /oauth2/token/revoke` убивает
   «any active access or refresh tokens associated with that authorization». Это правильная
   ментальная модель для кнопки «Отозвать доступ» в B2C.
10. **Экран сессий Telegram — лучший потребительский эталон**: модель устройства, платформа, версия
    ОС и приложения, IP, страна/регион, дата создания и дата последней активности, пометка текущей
    сессии, авто-терминация по неактивности (выбор 1 неделя / 3 / 6 месяцев / 1 год; сервер в любом
    случае убивает всё, что неактивно **>180 дней**).
11. **Telegram придумал «неподтверждённую сессию»**: при новом входе остальным сессиям приходит
    `updateNewAuthorization` с флагом `unconfirmed`, владелец видит плашку и может нажать «Это не я»
    → мгновенный `account.resetAuthorization`. Плюс **окно неприкосновенности 24 часа**
    (`FRESH_RESET_AUTHORISATION_FORBIDDEN`): свежевошедший не может сразу выкинуть настоящего
    владельца. Обе идеи — прямо в наш `core/keys`.
12. **Telegram уже поддерживает passkeys** (`account.registerPasskey`, `auth.finishPasskeyLogin`,
    RP ID жёстко `telegram.org`), а 2FA-пароль построен на **SRP 6a + PBKDF2-HMAC-SHA512,
    100 000 итераций** — сервер пароля не видит вовсе. Для phone-first продукта в KZ это прямой
    ориентир: SMS — не единственный фактор.
13. **Telegram Gateway API — готовый дешёвый канал верификации номера: $0.01 за код, «до 50× дешевле
    SMS», авто-рефанд при недоставке.** Для казахстанского phone-first продукта это реальная
    экономия; delivery-report подписан (`X-Request-Timestamp` + `X-Request-Signature`,
    HMAC-SHA-256 с `SHA256(API token)` в качестве ключа).
14. **Apple и Google одинаково трактуют «пароль приложения»**: требуется 2FA, показывается один раз,
    отзывается поштучно, и **смена основного пароля аккаунта автоматически отзывает все**. Google
    при этом системно сворачивает саму концепцию (Less Secure Apps выключены; финальное отключение —
    2025). Вывод: не заводить «пароль приложения», сразу делать scoped PAT.
15. **Оба крупных инцидента Discord — через стороннего вендора поддержки (5CA):** утекли email, IP,
    последние 4 цифры карт, переписка с поддержкой и **~70 000 фото документов**. Пароли и
    аутентификационные данные не пострадали. Урок для нас: ключи и ПДн не должны доходить до
    подрядчиков поддержки; документы для верификации — в отдельном хранилище с коротким TTL.

---

## 2. Платформы: конкретные факты

### 2.1 TELEGRAM

#### 2.1.1 Bot API токен

| Факт | Значение | Статус |
|---|---|---|
| Формат (примеры из доки) | `110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`, `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11` | [official] |
| Структура | `<bot_id>:<secret>`, где `bot_id` — числовой Telegram user id бота (публичная часть) | [inference из примеров + getMe] |
| Длина секрета | 35 символов из `[A-Za-z0-9_-]` (типовые детекторы: `\d{9,10}:[A-Za-z0-9_-]{35}`, встречаются варианты с префиксом `A`/`AA`) | [secondary] — официально не документировано |
| Передача | `https://api.telegram.org/bot<token>/METHOD` — **токен в пути URL** | [official] |
| Предупреждение | «Keep your token secure and store it safely, it can be used by anyone to control your bot» | [official] |
| Регенерация | BotFather `/token` («generates a new authentication token»); в `/mybots` → API Token → Revoke current token | [official] |
| Несколько активных токенов | НЕТ — один активный на бота, ротации с перекрытием нет | [inference] |
| Срок действия | нет | [inference: в доке отсутствует] |
| Скоупы | нет — токен даёт полный доступ ко всем методам бота | [inference] |
| Передача владения | `/mybots` → Transfer Ownership; только тем, кто хоть раз взаимодействовал с ботом; **необратимо** | [official] |
| Удаление | `/deletebot` — освобождает username | [official] |

**`logOut`** — «log out from the cloud Bot API server before launching the bot locally»; после успешного
вызова вернуться в облако нельзя **10 минут**. **`close`** — корректно закрыть инстанс бота перед
переносом между локальными серверами; в первые **10 минут** после запуска бота вернёт **429**.
Перед `close` нужно снять вебхук. [official — Bot API; уточнения подтверждены поиском, страница целиком
не отдалась WebFetch]

**Локальный Bot API server** (`tdlib/telegram-bot-api`) снимает лимиты: скачивание без ограничения
размера, загрузка до 2 ГБ, локальные пути к файлам, **HTTP-вебхуки**, локальные IP, любой порт.
[official]

#### 2.1.2 Вебхуки Bot API

- `setWebhook` параметры [official]:
  - `url` — обязателен, только **HTTPS**; пустая строка снимает вебхук;
  - `certificate` — можно загрузить публичный ключ **самоподписанного** сертификата;
  - `ip_address` — фиксированный IP вместо DNS-резолва;
  - `max_connections` — **1…100, по умолчанию 40**;
  - `allowed_updates` — белый список типов апдейтов;
  - `drop_pending_updates`;
  - `secret_token` — **1…256 символов, только `A-Z a-z 0-9 _ -`**; приходит в заголовке
    **`X-Telegram-Bot-Api-Secret-Token`**.
- Порты: **только 443, 80, 88, 8443**. «Other ports are not supported and will not work.» [official]
- TLS: **только TLS 1.2 и выше**; «SSLV2/3/TLS1.0/TLS1.1 are NOT supported». [official]
- Исходящие подсети Telegram: **`149.154.160.0/20` и `91.108.4.0/22`**. [official]
- CN/SAN сертификата должен совпадать с URL вебхука; нужно отдавать всю цепочку промежуточных
  сертификатов. [official]
- **Чего НЕТ:** подписи тела запроса, метки времени, идентификатора доставки, документированной
  политики ретраев/таймаутов. [official — по отсутствию в доке]

#### 2.1.3 Login Widget — СЕЙЧАС это OIDC

Актуальная дока `core.telegram.org/widgets/login` описывает **OpenID Connect** [official]:

| Элемент | Значение |
|---|---|
| Authorization endpoint | `https://oauth.telegram.org/auth` |
| Token endpoint | `https://oauth.telegram.org/token` |
| JWKS | `https://oauth.telegram.org/.well-known/jwks.json` |
| Discovery | `https://oauth.telegram.org/.well-known/openid-configuration` |
| UserInfo | **отсутствует** («Telegram does not currently provide a separate UserInfo endpoint») |
| Flow | Authorization Code + **PKCE (S256 рекомендуется)** |
| Scopes | `openid` (обязателен → `sub`, `iss`, `iat`, `exp`), `profile`, `phone`, `telegram:bot_access` |
| ID token claims | `iss`, `aud`, `sub`, `iat`, `exp`, `id`, `name`, `given_name`, `family_name`, `preferred_username`, `picture`, `phone_number`, `phone_number_verified` |
| Алгоритмы подписи | `RS256` (по умолчанию), `ES256`, `EdDSA` и `ES256K` (последние два — **только со scope `openid`**); выбирается в BotFather → Login Widget → Advanced |
| Аутентификация клиента | HTTP Basic: `base64(client_id:client_secret)`; креды выдаёт BotFather |
| Nonce | опционален, «to prevent replay attacks» |
| Регистрация редиректов | BotFather → **Allowed URLs** (origin сайта + redirect URI) |

**Legacy-схема** (архив `/widgets/login-legacy`) [official]:
- Поля: `id`, `first_name`, `last_name`, `username`, `photo_url`, `auth_date`, `hash`.
- `data_check_string` = все полученные поля **кроме `hash`**, отсортированные по алфавиту, в формате
  `key=<value>`, разделитель — перевод строки `\n` (0x0A).
  Пример: `auth_date=<auth_date>\nfirst_name=<first_name>\nid=<id>\nusername=<username>`.
- `secret_key = SHA256(<bot_token>)`; проверка:
  `hex(HMAC_SHA256(data_check_string, secret_key)) == hash`.
- `auth_date` — Unix timestamp, «можно дополнительно проверить»; **официального порога свежести
  Telegram не называет** (на практике интеграторы ставят 5 минут — [secondary]).
- Домен привязывается командой `/setdomain`; данные приходят либо редиректом на `data-auth-url`,
  либо колбэком `data-onauth`.
- Ловушка: **каждое поле payload контролируется атакующим** (включая `id` и `auth_date`); доказывает
  подлинность только подпись. Сравнение хэшей — обязательно timing-safe. [secondary]

#### 2.1.4 Mini Apps `initData`

[official]
- Со стороны бота: `secret_key = HMAC_SHA256(<bot_token>, "WebAppData")`, затем
  `hash = hex(HMAC_SHA256(data_check_string, secret_key))`. `data_check_string` строится так же:
  поля по алфавиту, `key=<value>`, разделитель `\n`.
- Со стороны **третьей стороны без токена бота** — поле `signature`: **base64url Ed25519-подпись**.
  `data_check_string` для неё начинается с `<bot_id>:WebAppData\n`, дальше отсортированные поля,
  **исключая `hash` и `signature`**.
  Пример: `12345678:WebAppData\nauth_date=<auth_date>\nquery_id=<query_id>\nuser=<user>`.
- Публичные ключи Ed25519 (hex):
  - production `e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d`
  - test `40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec`
- `auth_date` — проверять свежесть и отвергать устаревшие данные; конкретный TTL Telegram не задаёт.

#### 2.1.5 MTProto / пользовательский API

- `api_id` / `api_hash` выдаются на `my.telegram.org`. «For the moment each number can only have
  **one api_id** connected to it». Сэмпловый api_id из открытого кода «is limited on the server side
  and is not suitable for apps released to end-users». [official]
- «All accounts that log in using unofficial Telegram API clients are automatically put **under
  observation**»; за флуд/спам — «you **will be banned forever**». [official]
- **2FA cloud password:** SRP **6a**, KDF — **PBKDF2-HMAC-SHA512, 100 000 итераций**, две соли,
  схема `H(salt | data | salt)`; сервер хранит только `v = g^x mod p` и пароля никогда не видит.
  Методы `account.getPassword`, `auth.checkPassword`; при включённом 2FA вход отдаёт
  `400 SESSION_PASSWORD_NEEDED`. Сброс пароля из залогиненной сессии — **7 дней ожидания**.
  Есть recovery email с обязательным подтверждением. [official]
- **Passkeys (новое):** `account.initPasskeyRegistration` / `account.registerPasskey` /
  `auth.initPasskeyLogin` / `auth.finishPasskeyLogin` / `account.getPasskeys` /
  `account.deletePasskey`. Приватный ключ — в TEE устройства. **RP ID жёстко `telegram.org`**, поэтому
  неофициальные клиенты passkeys использовать не могут. При включённом 2FA пароль всё равно
  спрашивается. [official]
- **Доставка кода входа** (`auth.SentCodeType`): `App` (сервисное сообщение во все остальные
  активные сессии — **не SMS**), `Sms`, `SmsWord`, `SmsPhrase`, `Call`, `FlashCall` (код = сам номер),
  `MissedCall` (последние цифры звонящего номера), `EmailCode`, `SetUpEmailRequired`, `FragmentSms`,
  `FirebaseSms` (**только официальные мобильные приложения**). Ответ `auth.sentCode` содержит `type`,
  `phone_code_hash`, `length`, `timeout`. Плюс вход по QR-коду. [official]

#### 2.1.6 Активные сессии (эталон consumer-UX)

[official]
- `account.getAuthorizations` → `account.authorizations{ authorization_ttl_days, authorizations[] }`.
- Поля `authorization`: `hash`, `device_model`, `platform`, `system_version`, `api_id`, `app_name`,
  `app_version`, `date_created`, `date_active`, `ip`, `country`, `region`, `current`, `official_app`,
  `password_pending`, `encrypted_requests_disabled`, `call_requests_disabled`, `unconfirmed`.
- `account.setAuthorizationTTL(authorization_ttl_days)` — автотерминация неактивных сессий; при
  некорректном значении `TTL_DAYS_INVALID` (допустимый диапазон официально не документирован).
  В UI: 1 неделя / 3 месяца / 6 месяцев / 1 год [secondary].
- Официальный ответ Telegram: «The server **automatically terminates** sessions that are inactive for
  more than **180 days**». [official — bugs.telegram.org]
- **`FRESH_RESET_AUTHORISATION_FORBIDDEN`**: нельзя завершать чужие сессии в течение **24 часов**
  после входа текущей сессии.
- **Неподтверждённые сессии:** новый вход рассылает `updateNewAuthorization` с флагом `unconfirmed`;
  владелец подтверждает через `account.changeAuthorizationSettings(confirmed)` или сбрасывает через
  `account.resetAuthorization`; иначе автоподтверждение через `authorization_autoconfirm_period`.
- Прочее: `account.resetAuthorizations` (всё, кроме текущей), `account.resetWebAuthorizations`
  (внешние сайты через Login Widget) — отдельный список.

#### 2.1.7 Telegram Gateway API (верификация номера как сервис)

[official]
- Назначение: «automated messages, such as verification codes, to users who registered their phone
  number on Telegram»; «a cost-effective and privacy-focused solution for user authentication».
- Цена: **$0.01 за код**, «up to **50x cheaper than SMS**», автоматический рефанд при недоставке в
  пределах `ttl`; отправка на собственный номер — **бесплатно**.
- Auth: `Authorization: Bearer <token>` **или** параметр `access_token`.
- Методы: `sendVerificationMessage`, `checkSendAbility`, `checkVerificationStatus`,
  `revokeVerificationMessage`.
- Параметры: `phone_number` (E.164), `code` (4–8 цифр, можно доверить генерацию Telegram),
  `code_length` (4–8), `ttl` **30…3600 сек**, `callback_url` (HTTPS, 0–256 байт),
  `payload` (0–128 байт), `sender_username` (верифицированный канал как отправитель).
- **Delivery report:** POST на `callback_url` с объектом `RequestStatus`; заголовки
  **`X-Request-Timestamp`** и **`X-Request-Signature`**; подпись — HMAC-SHA-256 от data-check-string,
  ключ = **SHA256(API token)** (тот же паттерн, что в legacy Login Widget). Нужен HTTP 200, иначе до
  **10 ретраев**.
- Маркетинговые цифры Telegram про SMS: доставка «several minutes», отказы «as high as 5%».

#### 2.1.8 Платежи

[official]
- `provider_token` — **отдельный от bot token**, привязан к платёжному провайдеру, выдаётся BotFather
  (`/mybots` → Bot Settings → Payments). У одного бота может быть **несколько** токенов провайдеров
  (для разных товаров/пользователей). Боевой Stripe-токен содержит подстроку **`:LIVE:`**.
- «Telegram does **not** process payments from users»; ни Telegram, ни разработчик бота не имеют
  доступа к карточным данным — их держит провайдер.
- Поток: `sendInvoice` → `pre_checkout_query` (ответить `answerPreCheckoutQuery` **за 10 секунд**) →
  `successful_payment`.
- **Stars:** валюта **`XTR`**; для цифровых товаров `provider_token` **оставляется пустым**; возврат —
  `refundStarPayment`; обязательно хранить `telegram_payment_charge_id`.
  (21-дневный холд на вывод — **[не подтверждено]**.)

#### 2.1.9 Telegram Passport

[official]
- Единый способ передать сервису верифицированные документы. Данные шифруются **на клиенте**
  публичным ключом сервиса; Telegram содержимое не видит.
- Регистрация: BotFather `/setpublickey`, `/setprivacypolicy`. Запрос обязан нести
  криптостойкий **`nonce`** — «a unique identifier of the request».
- Криптография: **RSA-OAEP** для секрета credentials, **AES-256-CBC** для credentials и полей,
  **SHA-512/SHA-256** для ключей и контроля целостности. «Keep your private key SECRET!»
- **Механизм отзыва доступа пользователем в документации не описан — [не подтверждено].**

#### 2.1.10 Telegram Business bots (паттерн делегирования B2C)

- Объект `BusinessConnection`: `id` (это и есть `business_connection_id`), `user`, `user_chat_id`,
  `is_enabled`. Идентификатор передаётся в `business_connection_id` у методов отправки/редактирования,
  и бот действует **от имени бизнес-аккаунта человека**.
- `can_reply` (true, если бот может отвечать в чатах, активных за последние 24 часа)
  **устарел с Bot API 9.0** → вместо него гранулярный объект **`rights` (`BusinessBotRights`)`**.
  [secondary — aiogram / python-telegram-bot / GramIO; официальная страница `/bots/business` отдала 404]
- Урок: делегирование «бот от имени человека» оформлено **отдельной сущностью связи** с
  выключателем (`is_enabled`) и набором прав, а не выдачей боту пользовательского токена.

---

### 2.2 DISCORD

#### 2.2.1 Bot token

| Факт | Значение | Статус |
|---|---|---|
| Заголовок | `Authorization: Bot <token>` (OAuth: `Authorization: Bearer <token>`) | [official] |
| Пример из доки | `<base64 user_id>.<base64 ts>.<hmac>` (сам пример из документации Discord здесь не приводится: GitHub push protection считает его боевым токеном) | [official] |
| Структура | три части через точку: `base64(user_id snowflake)` . `base64(timestamp создания)` . `HMAC-дайджест` | [secondary] |
| Показ | «You won't be able to view your token again unless you regenerate it, so make sure to keep it somewhere safe (like in a password manager)» | [official] |
| Сброс | Developer Portal → Bot → **Reset Token** | [official] |
| Предупреждение | токены «are *highly* sensitive», не шарить и не коммитить | [official] |
| База API | `https://discord.com/api/v{n}`, актуальные v10/v9 (без версии — v6) | [official] |
| User-Agent | обязателен: `DiscordBot ($url, $versionNumber)`, иначе возможна блокировка Cloudflare | [official] |

Публичная первая часть токена = id приложения → **можно атрибутировать утёкший токен без его
валидации**. Это ровно то, что нам нужно от `key_id`. [inference]

#### 2.2.2 OAuth2

[official]
- Authorize: `https://discord.com/oauth2/authorize`; token: `https://discord.com/api/oauth2/token`;
  **revoke: `https://discord.com/api/oauth2/token/revoke`**. Content-Type только
  `application/x-www-form-urlencoded` (JSON не принимается).
- Параметры авторизации: `response_type` (`code`/`token`), `client_id`, `scope` (через пробел),
  `redirect_uri`, `state`, `prompt` (`consent`/`none`), `integration_type` (0 = guild, 1 = user).
- Ответ токена: `access_token`, `token_type: Bearer`, `expires_in`, `refresh_token`, `scope`.
  На практике `expires_in` **всегда 604800 (7 суток)** — [secondary, issue discord-api-docs #4755];
  официально фиксированное значение не задокументировано.
- **Отзыв — на уровне авторизации:** «When you revoke a token, any active access or refresh tokens
  associated with that authorization will be revoked.»
- `client_credentials` — для владельца приложения, **без refresh token**; для team-приложений
  ограничен `identify` и `applications.commands.update`.
- `bot` scope + **`permissions` (битовая маска целым числом)**; можно передать `guild_id` и
  `disable_guild_select=true`.
- Implicit grant: токен во **фрагменте** URI, refresh-токена нет; в доке прямо назван менее
  безопасным.
- `webhook.incoming`: в ответе объект вебхука с собственными `id`, `token`, `url`, `channel_id`,
  `guild_id` — то есть «вебхук как самостоятельный отзываемый креденшл».
- Скоупов 30+; большая часть RPC/activity-скоупов доступна только одобренным партнёрам.

**Linked Roles / Application Role Connection Metadata** [official]:
поля `type`, `key` (1–50 символов, `[a-z0-9_]`), `name` (1–100), `description` (1–200) + локализации;
8 типов сравнения (integer ≤ / ≥ / = / ≠, datetime ≤ / ≥ в днях от текущей даты, boolean = / ≠);
**максимум 5 metadata-записей на приложение**; требуется scope `role_connections.write`;
пользователь подключается через `role_connections_verification_url` приложения.

#### 2.2.3 Interactions endpoint — эталон верификации вебхука

[official]
- Заголовки **`X-Signature-Ed25519`** и **`X-Signature-Timestamp`**; проверяется Ed25519-подпись над
  конкатенацией `timestamp` и **сырого тела**; ключ — Application Public Key из Developer Portal.
- «You **must validate the request each time you receive an interaction**.»
- Неверная подпись → приложение обязано отвечать **401**.
- **PING-челлендж:** при сохранении Interactions Endpoint URL Discord шлёт POST с `type: 1`;
  endpoint обязан ответить 200 и телом с `type: 1`.
- **Автоматический аудит интегратора:** Discord периодически шлёт заведомо невалидные подписи; при
  провале «we will remove your interactions URL and alert you via email and System DM».
- Бюджет времени: **3 секунды** на первичный ответ, иначе токен взаимодействия инвалидируется;
  общий срок жизни interaction token — **15 минут** (deferred-ответы type 5/6 + follow-up).

#### 2.2.4 Gateway intents и верификация

[official]
- Привилегированные интенты: **`GUILD_PRESENCES`**, **`GUILD_MEMBERS`**, **`MESSAGE_CONTENT`**.
- **С 10 июня 2026 порог — 10 000 уникальных пользователей** (а не 100 серверов): до порога интенты
  включаются тумблером в Developer Portal; после — заявка на ревью, **90 дней** на подачу, приложение
  продолжает работать во время рассмотрения, доступ **переподтверждается ежегодно**.
- В заявке требуют: конкретный use case (общие формулировки отклоняют), доказательство
  необходимости, политику хранения и защиты данных (или подтверждение обработки только в памяти),
  точность сведений. Отказ — если задачу можно решить интеракциями/иными средствами.
- Подключение с невключённым привилегированным интентом → закрытие соединения с кодом **4014**.
- `session_start_limit.max_concurrency` — число IDENTIFY за 5 секунд; превышение → opcode 9
  (Invalid Session). Для крупных ботов (150 000+ гильдий) лимит стартов растёт как
  `max(2000, (guild_count / 1000) * 5)` в сутки.
- Верификация приложения: подать можно от **75 серверов**, обязательна при **100+** — [secondary],
  официальную страницу `support-dev.discord.com` получить не удалось (403).

#### 2.2.5 Rate limits

[official]
- Заголовки: `X-RateLimit-Limit`, `-Remaining`, `-Reset` (epoch, сек), `-Reset-After` (сек),
  `-Bucket`, `-Global` (только в 429), `-Scope` (`user` | `global` | `shared`, только в 429).
- Тело 429: `retry_after` (секунды), `global` (bool).
- Глобальный лимит: **50 запросов в секунду** на бота, поверх пороутовых.
- **Invalid Request Limit: 10 000 невалидных запросов (401 / 403 / 429) за 10 минут → временный
  бан IP на уровне Cloudflare.** Длительность бана не документирована — [не подтверждено].

#### 2.2.6 User-installable apps (делегирование в B2C)

[official]
- `integration_types`: **GUILD_INSTALL (0)** и **USER_INSTALL (1)**.
- Контексты выполнения: `GUILD`, `BOT_DM`, `PRIVATE_CHANNEL`.
- Приложение, установленное в пользовательский контекст, поддерживает **только scope
  `applications.commands`**.
- `authorizing_integration_owners` различает того, кто установил приложение, и того, кто его вызвал.
- Лимит числа user-installed приложений и формальная процедура удаления в доке не описаны —
  **[не подтверждено]**.

#### 2.2.7 Потребительский UX

[secondary — support.discord.com отдаёт 403 для WebFetch, факты собраны из совпадающих вторичных
описаний]
- **User Settings → Authorized Apps:** список приложений с иконкой и названием, **дата авторизации**,
  список выданных прав, кнопка **Deauthorize** с подтверждением. Важная деталь: деавторизация **не**
  удаляет бота с сервера — это разные сущности, бота нужно кикать отдельно.
  **Даты последнего использования в этом списке нет.**
- **User Settings → Devices:** список активных сессий с временем последней активности; «крестик» для
  одной сессии и **«Log Out All Known Devices»** внизу; операция требует ввода пароля.
- **Self-bots запрещены:** «Automating normal user accounts (generally called "self-bots") outside of
  the OAuth2/bot API is forbidden, and can result in an account termination». Легальный путь —
  отдельный bot-аккаунт с токеном.

---

### 2.3 APPLE / GOOGLE (кратко)

**Apple, app-specific passwords** [official, support.apple.com/en-us/102654]:
- требуется двухфакторная защита Apple Account;
- **до 25 активных одновременно**;
- создаются и помечаются меткой в `account.apple.com` → **Sign-In and Security → App-Specific
  Passwords**; удаляются поштучно (Remove) или целиком (**Revoke All**);
- «Any time you change or reset your primary Apple Account password, **all of your app-specific
  passwords are revoked automatically**»;
- формат «16 символов группами по 4» на этой странице **не указан** — **[не подтверждено]**.

**Google, App Passwords** [official, support.google.com/accounts/answer/185833]:
- «An app password is a **16-digit passcode**»;
- требуется 2-Step Verification; **недоступны при Advanced Protection** и для многих
  организационных аккаунтов;
- показываются **один раз**, восстановить нельзя — только выпустить новый;
- «Once you revoke the App Password, the app can't access your Google Account again»; отзываются
  автоматически при смене пароля аккаунта.

**Google, сворачивание Less Secure Apps** [official, workspaceupdates.googleblog.com]:
- 15 июня 2024 — настройка LSA убрана из Admin console, отключённым пользователям доступ закрыт;
- 30 сентября 2024 — «CalDAV, CardDAV, IMAP, POP and Google Sync will no longer work when signing in
  with just a password»;
- март 2025 / 1 мая 2025 — финальные апдейты поста о полном прекращении LSA;
- App Password остаётся обходным путём только для того, что не умеет OAuth.

**Sign in with Apple, client secret** [secondary — learn.microsoft.com; страницы developer.apple.com
не отдаются WebFetch (SPA)]:
- client_secret — это **JWT, подписанный ES256** приватным ключом из `.p8` (PKCS#8) файла портала;
- header: `alg: ES256`, `kid` (Key ID);
- payload: `sub` = Client ID (Services ID), `iss` = **Team ID**, `aud` = `https://appleid.apple.com`,
  `nbf`/`iat`, `exp`;
- «Apple doesn't accept client secret JWTs with an expiration date **more than six months** after the
  creation, or *nbf*, date. You need to **rotate your client secret, at minimum, every six months**»
  (6 месяцев = **15 777 000 секунд**).

**Apple, Hide My Email** [official, support.apple.com/en-us/105078]:
- генерируются случайные адреса на `@privaterelay.appleid.com` с пересылкой на настоящий ящик;
- «only the app or website you created the account with can use this unique email address»;
- управление: Settings → [имя] → iCloud → Hide My Email (можно менять адрес пересылки).

**Apple, аттестация устройства** [official, Apple Platform Security]:
- ОС запрашивает у Secure Enclave **hardware-bound attested key**; в аттестацию входят идентификаторы
  логической платы, публичный ключ, хэши прошивок (Secure Enclave OS, LLB Image4, OS Image4),
  device-specific значения и **freshness code** (challenge); всё подписывается UIK;
- серверы Apple проверяют подпись UIK, сверяют с производственными записями через Silicon Identity
  Key и выдают сертификат только на подтверждённые свойства;
- «if the Secure Enclave is unable to unwrap the attested key, the Secure Enclave **refuses** to
  generate a hardware attestation».
- App Attest (практика) [secondary]: 1 ключ на пользователя для account-based приложений либо 1 ключ
  на приложение на устройстве; ключи **не синхронизируются между устройствами**; после единоразовой
  аттестации каждое защищённое обращение подписывается **assertion**, а **счётчик (counter)** —
  анти-replay сигнал.

---

## 3. Инциденты и уязвимости + уроки

| # | Событие | Факты | Урок для `core/keys` |
|---|---|---|---|
| 1 | **Discord / 5CA, октябрь 2025** [official — пресс-релиз Discord] | Через стороннего провайдера поддержки 5CA утекли имена, юзернеймы, email и контакты, ограниченная биллинговая информация (тип платежа, последние 4 цифры карты, история покупок), IP-адреса, переписка с поддержкой, корпоративные материалы и **~70 000 фото удостоверений личности** (собирались для апелляций по возрасту). НЕ утекли: полные номера карт и CVV, **пароли и аутентификационные данные**, сообщения в Discord. Действия: немедленный отзыв доступа вендора, форензика, правоохранители, уведомление с `noreply@discord.com`, аудит сторонних систем. | Ключи и секреты не должны существовать в форме, доступной поддержке. Документы верификации — отдельное хранилище, короткий TTL, доступ только по step-up. Вендор — часть периметра. |
| 2 | **Discord, май 2023** [secondary] | Скомпрометирован аккаунт агента стороннего сервиса поддержки; утекла очередь тикетов: email, переписка, вложения (в т.ч. сканы документов). ~180 пострадавших. | То же самое повторилось через 2,5 года — значит организационная мера не сработала. Нужен технический барьер, а не регламент. |
| 3 | **Discord token grabbers / infostealer** [secondary] | Массовая индустрия: малварь читает токены из файлов браузера и десктоп-клиента Discord и отправляет на webhook атакующего. Токен даёт доступ без пароля и (в общем случае) в обход 2FA. | Долгоживущий bearer-токен в локальном хранилище клиента — архитектурный тупик. У нас: refresh в `httpOnly`+`Secure` cookie, привязка сессии к устройству, `tokenEpoch`, step-up на опасные операции. |
| 4 | **Утечки Telegram bot-токенов в публичные репозитории** [secondary] | Исследователи при сканировании GitHub находят **тысячи живых** bot-токенов; по токену без дополнительной информации можно за минуту снять `getMe`, `getUpdates`, историю и получить полный контроль над ботом. | Telegram **не** партнёр GitHub secret scanning → автосброса нет. Нам обязательно: регистрация паттерна ключа у GitHub + автоотзыв по входящему уведомлению. |
| 5 | **Telegram как канал эксфильтрации малвари** [secondary] | Стилеры зашивают bot token и chat_id в payload и используют Telegram как транспорт кражи данных. | Наш «бот-идентити» должен иметь скоупы и лимиты: даже украденный ключ не должен уметь выгрузить всё. |
| 6 | **Login Widget: replay и доверие к payload** [secondary] | Все поля payload контролируются атакующим; при отсутствии проверки `auth_date` украденный payload воспроизводится бесконечно; сравнение хэша не timing-safe — классический баг интеграторов. Telegram официального порога свежести не задаёт. | **Сервер должен задавать TTL сам** и отвергать просроченное; сравнение — только constant-time. Не перекладывать безопасность на интегратора. |
| 7 | **SIM-swap / SS7 против SMS-OTP** [secondary] | Перенос номера, замена SIM/eSIM или эксплуатация SS7/Diameter позволяют перехватить SMS без доступа к телефону; для аккаунта, где SMS — единственный фактор, это полный захват. | Прямая угроза для KZ phone-first. Ответ Telegram: код в **уже активные сессии** вместо SMS, 2FA cloud password, passkeys, «неподтверждённая сессия», 24-часовой запрет на массовый разлогин, 7 дней на сброс пароля. Всё это — обязательные к копированию меры. |
| 8 | **Токен в URL (Telegram)** [inference на базе official] | `api.telegram.org/bot<token>/method` → токен оседает в access-логах, прокси, APM, истории браузера, `Referer`. | Секрет — только в заголовке `Authorization`. Логи маскируют префикс ключа. |
| 9 | **Разные KDF у двух похожих механизмов Telegram** [official] | Login Widget `SHA256(token)` vs Mini Apps `HMAC(token, "WebAppData")` — перепутанные аргументы дают «работающую» проверку на другом наборе данных. | Единый хелпер подписи на платформу, покрытый тестом на «чужую схему». |

---

## 4. Что SuperApp6 стоит скопировать

**Формат и хранение ключа**
1. Строка ключа `sa6_<env>_<key_id>_<secret>`: `key_id` — **публичная** часть (по образцу
   `base64(user_id)` у Discord и `bot_id` у Telegram), по которой ключ ищется и атрибутируется без
   знания секрета. В БД — только хэш секрета (argon2id либо HMAC-SHA256 с server-side pepper).
2. **Показать ровно один раз** + копирование одним тапом + явное «Я сохранил ключ» (формулировка
   Discord: «You won't be able to view your token again unless you regenerate it»).
3. В списке ключ отображается как «Ключ · `…a3f9`» + человеческое имя, которое задаёт пользователь.

**Метаданные (минимальный набор колонок)**
4. `name`, `created_at`, `created_by`, **`last_used_at`**, `last_used_ip` + страна/регион,
   `expires_at`, `scopes`, `ownerType`/`ownerId`, `workspaceId`. Именно `last_used_at` — то, чего
   нет в Discord Authorized Apps и что делает ревизию ключей возможной.
5. Обязательный **срок действия** с дефолтом (предложение: 90 дней) и потолком; напоминание за 14 и
   за 1 день через `core/notifications`.

**Ротация (то, чего нет ни у Telegram, ни у Discord)**
6. **Две одновременно активные версии секрета** на один ключ: `primary` + `secondary` с датой
   планового вывода. У Telegram один токен → регенерация = даунтайм; повторять эту ошибку нельзя.

**Вебхуки — модель Discord, не Telegram**
7. Подпись **Ed25519** (или HMAC-SHA256) над `timestamp || raw_body`; заголовки
   `X-SuperApp-Signature`, `X-SuperApp-Timestamp`, `X-SuperApp-Delivery-Id`; окно свежести ±5 минут;
   идемпотентность по delivery id; ретраи с экспоненциальным backoff.
8. **PING-челлендж при регистрации endpoint** (Discord type 1 → эхо `type: 1`).
9. **Периодический аудит интегратора заведомо невалидной подписью**; при приёме — автоматическое
   отключение endpoint'а + уведомление владельцу в приложении и по email. Это самая недооценённая
   идея Discord, и она прямо ложится на наш `core/jobs`.
10. Ограничить исходящие вебхуки нашей доменной политикой и `safeFetch` (уже есть в `shared/http`).

**Ограничения и злоупотребления**
11. **Invalid Request Limit по образцу Discord:** считать 401/403/429 отдельно от общего трафика и
    банить связку IP+ключ при превышении порога за окно. Это ловит перебор ключей, который обычный
    rate limit не видит.
12. Ответные заголовки лимитов в стиле Discord (`X-RateLimit-*` + `retry_after` в теле 429) —
    предсказуемые для AI-агентов и мобильного клиента.
13. Бюджет времени на интерактивные операции (Discord: 3 с на ack, 15 мин на follow-up) — полезная
    рамка для будущих AI-инструментов.

**Сессии и устройства (эталон Telegram)**
14. Страница «Устройства и сессии»: модель устройства, платформа, версия ОС, название и версия
    приложения, IP, страна/регион, «создана», «активна», пометка текущей; «Завершить все, кроме
    этой».
15. **Автотерминация по неактивности** с выбором срока пользователем (1 неделя / 3 / 6 месяцев /
    1 год, дефолт 6 месяцев) и **жёстким серверным потолком** (Telegram: 180 дней).
16. **Подтверждение нового входа:** пуш «Новый вход: Almaty, Android» с кнопкой **«Это не я»** →
    мгновенный отзыв сессии + step-up. Не уведомление постфактум, а действие.
17. **Окно неприкосновенности 24 часа** после входа с нового устройства: свежая сессия не может
    массово разлогинить остальные (`FRESH_RESET_AUTHORISATION_FORBIDDEN`).
18. **Смена пароля / успешный step-up → отзыв всех PAT, device credentials и OAuth-грантов**
    (модель Apple и Google) поверх существующего `tokenEpoch`.
19. **Отзыв на уровне гранта, а не токена** (Discord revoke): одна кнопка «Отозвать доступ» убивает
    и access, и refresh, и все производные.

**Утечки**
20. Подать паттерн `sa6_…` в **GitHub secret scanning partner program**; принимать входящее
    уведомление отдельным endpoint'ом → автоматический отзыв + уведомление владельцу (in-app + SMS) +
    запись в `core/chatter`. Именно так работает связка GitHub↔Discord, и именно этого не хватает
    Telegram.
21. Валидность-чек: отвечать на проверочные запросы сканеров, не раскрывая владельца.

**Делегирование и IoT**
22. «Бот от имени человека» — отдельная сущность `Connection` с гранулярными `rights` и
    выключателем `is_enabled` (модель Telegram Business), а не выдача боту пользовательского токена.
23. Два контекста установки по образцу Discord: **личный** (`USER_INSTALL`) и **организационный**
    (`GUILD_INSTALL`) — прямо ложится на нашу B2C/B2B-дихотомию и `X-Workspace-Id`.
24. IoT: для устройств с защищённым элементом — attestation + challenge-response с **counter**
    (App Attest); для дешёвых устройств — pre-shared device secret, привязанный к `device_id`, с
    обязательным сроком и ротацией.

**Вход и верификация номера (KZ-специфика)**
25. «Вход через SuperApp6» для внешних сайтов — **сразу OIDC** (discovery + JWKS + PKCE S256 +
    ID token), как это сделал Telegram, а не самодельный HMAC.
26. Для мини-приложений внутри SuperApp6 — два уровня проверки, как у Telegram: HMAC для «своего»
    сервера и **Ed25519-подпись с опубликованным публичным ключом** для третьих сторон.
27. Рассмотреть **Telegram Gateway ($0.01 за код)** как основной канал доставки OTP с SMS-fallback:
    для phone-first Казахстана это прямая экономия на порядок. При приёме delivery-report обязательно
    проверять `X-Request-Timestamp` / `X-Request-Signature`.
28. Код подтверждения отправлять **в уже активные сессии** (Telegram `sentCodeTypeApp`), а SMS
    оставлять только когда активных сессий нет.
29. Passkeys как цель (Telegram уже там): WebAuthn поверх существующего `core/verify`.

---

## 5. Что НЕ копировать / ловушки

1. **Токен в URL.** `api.telegram.org/bot<token>/…` — секрет в access-логах, прокси, `Referer`,
   истории. Только `Authorization`-заголовок.
2. **Единственный активный токен без срока и скоупов.** Telegram-модель делает невозможными и
   ротацию без даунтайма, и least privilege. Наш ключ обязан иметь `scopes` и `expires_at` с первого
   дня.
3. **Секрет вебхука в заголовке вместо подписи тела.** `X-Telegram-Bot-Api-Secret-Token` утекает
   целиком при любом логировании у интегратора, не привязан ко времени и не защищает от replay.
4. **Allow-list IP как основа доверия.** Подсети Telegram — полезный второй слой, но в облаке этот
   контроль ломается и создаёт ложное чувство защищённости. Основа — криптографическая подпись.
5. **Разные схемы вывода ключа для похожих механизмов** (Login Widget vs Mini Apps). Один хелпер,
   один тест «чужая схема не проходит».
6. **Отсутствие серверного TTL для `auth_date`.** «Интегратор может дополнительно проверить» на
   практике означает «никто не проверяет». Задаём жёсткий серверный порог и отвергаем просроченное.
7. **«Пароль приложения» как долгоживущий bearer без скоупов.** Google системно сворачивает саму
   концепцию; Apple ограничивает 25 штуками и привязкой к смене пароля. Мы не заводим app-пароли —
   сразу scoped PAT с TTL. Если совместимость со старым клиентом всё же нужна, это PAT с одним
   скоупом и коротким сроком.
8. **Implicit grant** (токен во фрагменте URL) — не реализовывать.
9. **Хранение долгоживущего токена в localStorage клиента** — источник всей индустрии token
   grabbers. Refresh только в `httpOnly`+`Secure` cookie с привязкой к устройству.
10. **Отзыв только «текущего» токена.** Разделение «деавторизовать приложение» и «кикнуть бота» у
    Discord путает пользователя: он думает, что отключил доступ, а бот продолжает работать. У нас
    отзыв должен убивать ВСЕ пути доступа этой интеграции, а UI — явно перечислять, что именно
    отключается.
11. **Список авторизованных приложений без даты последнего использования** (Discord). Без
    `last_used_at` человек не понимает, что можно безопасно отозвать.
12. **Передача документов третьей стороне «и забыли».** Telegram Passport шифрует данные публичным
    ключом сервиса, но механизм отзыва в доке не описан; оба инцидента Discord — именно про
    документы, осевшие у вендора. Нужны TTL, журнал доступа и принудительное удаление.
13. **Ревью-гейты по числу серверов/пользователей как единственный барьер** (privileged intents).
    Полезно, но не заменяет технические лимиты: до порога всё включается тумблером.
14. **Стороннее «облегчение поддержки» с полным доступом к тикетам и вложениям** — прямой путь к
    инциденту 5CA.
15. **Один кредентиал на все среды.** Telegram спасается строкой `:LIVE:` внутри
    `provider_token` — это костыль. У нас среда кодируется в префиксе ключа (`sa6_live_…` /
    `sa6_test_…`) и проверяется сервером.

---

## 6. Открытые вопросы (не подтверждено первоисточником)

1. Точная длина и алфавит секретной части Telegram bot token (35 символов `[A-Za-z0-9_-]`) —
   только из детекторов секретов, официально не документированы.
2. Автоматический сброс Discord-токенов, найденных GitHub'ом: официальной страницы Discord не
   найдено; косвенно подтверждается таблицей GitHub (partner alerts + push protection для
   `discord_bot_token`) и вторичными источниками.
3. Формат Apple app-specific password (16 символов группами по 4) — на официальной странице
   `102654` не указан.
4. Длительность временного Cloudflare-бана Discord за Invalid Request Limit.
5. Лимит на число user-installed приложений у одного пользователя Discord и формальная процедура
   удаления.
6. Telegram Passport: механизм отзыва пользователем ранее выданного доступа.
7. Допустимый диапазон `authorization_ttl_days` у Telegram (документирована только ошибка
   `TTL_DAYS_INVALID`).
8. Официальный TTL refresh-токена Discord и официальное подтверждение фиксированного
   `expires_in = 604800`.
9. Порог верификации приложения Discord (75 / 100 серверов) — `support-dev.discord.com` отдаёт 403.
10. Telegram Stars: правила вывода средств и 21-дневный холд.
11. Официальные страницы `developer.apple.com/documentation/*` (Sign in with Apple client secret,
    App Attest) не отдаются WebFetch — использованы Apple Platform Security guide и Microsoft Learn.
12. Официальная страница `core.telegram.org/bots/business` отдала 404; факты о `BusinessConnection`
    и `rights` взяты из документации клиентских библиотек, отражающих Bot API 9.0.
13. Политика ретраев и таймаутов вебхуков Telegram (в доке отсутствует).
14. Официальное описание экранов Discord «Authorized Apps» и «Devices» — `support.discord.com`
    отдаёт 403 для автоматической выборки.

---

## 7. Источники

**Telegram (официальные)**
1. https://core.telegram.org/bots/features — [official] BotFather, `/token`, передача владения, privacy mode
2. https://core.telegram.org/bots/api — [official] формат токена, `setWebhook`/`deleteWebhook`, `secret_token`, локальный сервер
3. https://core.telegram.org/bots/webhooks — [official] порты 443/80/88/8443, TLS ≥1.2, подсети `149.154.160.0/20`, `91.108.4.0/22`
4. https://core.telegram.org/widgets/login — [official] OIDC-эндпоинты, scopes, claims, алгоритмы, PKCE
5. https://core.telegram.org/widgets/login-legacy — [official] data-check-string, `SHA256(bot_token)`, `/setdomain`
6. https://core.telegram.org/bots/webapps — [official] `HMAC_SHA256(bot_token,"WebAppData")`, Ed25519 `signature`, публичные ключи
7. https://core.telegram.org/gateway — [official] $0.01 за код, «up to 50x cheaper than SMS»
8. https://core.telegram.org/gateway/api — [official] методы, `ttl` 30–3600, `X-Request-Signature`
9. https://core.telegram.org/api/obtaining_api_id — [official] один `api_id` на номер, наблюдение за неофициальными клиентами
10. https://core.telegram.org/api/srp — [official] SRP 6a, PBKDF2-HMAC-SHA512 100 000 итераций
11. https://core.telegram.org/api/auth — [official] типы доставки кода, unconfirmed sessions, QR-логин
12. https://core.telegram.org/api/passkeys — [official] passkeys, RP ID `telegram.org`
13. https://core.telegram.org/method/account.getAuthorizations — [official] поля сессии, `authorization_ttl_days`
14. https://core.telegram.org/method/account.setAuthorizationTTL — [official] `TTL_DAYS_INVALID`, `FRESH_RESET_AUTHORISATION_FORBIDDEN`
15. https://core.telegram.org/passport — [official] `/setpublickey`, nonce, RSA-OAEP + AES-256-CBC
16. https://core.telegram.org/bots/payments — [official] `provider_token`, `:LIVE:`, 10 секунд на pre-checkout
17. https://core.telegram.org/bots/payments-stars — [official] `XTR`, пустой provider_token, `refundStarPayment`
18. https://bugs.telegram.org/c/288 — [official] «automatically terminates sessions inactive for more than 180 days»

**Discord (официальные)**
19. https://docs.discord.com/developers/reference — [official] `Authorization: Bot`, пример токена, User-Agent, snowflake
20. https://docs.discord.com/developers/topics/oauth2 — [official] эндпоинты, revoke, scopes, implicit, webhook.incoming
21. https://docs.discord.com/developers/interactions/overview — [official] `X-Signature-Ed25519`, PING, 401, снятие URL при провале аудита
22. https://docs.discord.com/developers/interactions/receiving-and-responding — [official] 3 секунды, 15 минут, deferred
23. https://docs.discord.com/developers/events/gateway — [official] привилегированные интенты, close code 4014, `max_concurrency`
24. https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review — [official] порог 10 000 пользователей (с 10.06.2026), 90 дней, ежегодное продление
25. https://docs.discord.com/developers/topics/rate-limits — [official] `X-RateLimit-*`, 50 req/s, Invalid Request Limit 10 000 / 10 мин
26. https://docs.discord.com/developers/resources/application-role-connection-metadata — [official] Linked Roles, максимум 5 записей
27. https://docs.discord.com/developers/tutorials/developing-a-user-installable-app — [official] `integration_types`, контексты, `applications.commands`
28. https://docs.discord.com/developers/activities/overview — [official] Activities в iframe + Embedded App SDK
29. https://docs.discord.com/developers/quick-start/getting-started — [official] «You won't be able to view your token again…», Reset Token
30. https://discord.com/press-releases/update-on-security-incident-involving-third-party-customer-service — [official] инцидент 5CA, ~70 000 фото документов

**GitHub / Apple / Google (официальные)**
31. https://docs.github.com/en/code-security/secret-scanning/introduction/supported-secret-scanning-patterns — [official] `discord_bot_token` (partner alerts + push protection) vs `telegram_bot_token` (только user alerts)
32. https://support.apple.com/en-us/102654 — [official] app-specific passwords: 2FA, до 25, Revoke All, отзыв при смене пароля
33. https://support.apple.com/en-us/105078 — [official] Hide My Email, `@privaterelay.appleid.com`
34. https://support.apple.com/guide/security/ (Attestation process) — [official] Secure Enclave, freshness code, отказ при невозможности unwrap
35. https://support.google.com/accounts/answer/185833 — [official] App Passwords: 16 цифр, показ один раз, отзыв
36. https://workspaceupdates.googleblog.com/2023/09/winding-down-google-sync-and-less-secure-apps-support.html — [official] сроки отключения LSA

**Вторичные**
37. https://github.com/discord/discord-api-docs/issues/4755 — [secondary] `expires_in` всегда 604800
38. https://learn.microsoft.com/en-us/azure/app-service/configure-authentication-provider-apple — [secondary] структура client secret JWT, «no more than six months after nbf»
39. https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots — [secondary, через выдачу поиска] запрет self-bots
40. https://docs.aiogram.dev/en/v3.21.0/api/types/business_connection.html и https://docs.python-telegram-bot.org/en/stable/telegram.businessconnection.html — [secondary] `BusinessConnection`, `can_reply` deprecated в Bot API 9.0, `rights`
41. https://github.com/gitleaks/gitleaks/pull/1404/files, https://github.com/projectdiscovery/nuclei-templates/blob/main/http/exposures/tokens/telegram/telegram-bot-token.yaml — [secondary] регексы формата Telegram bot token
42. https://gist.github.com/darksunlight/8e8db86794a88e0f3f80408970fc94e5 — [secondary] разбор структуры Discord-токена
43. https://www.bleepingcomputer.com/news/security/discord-discloses-data-breach-after-support-agent-got-hacked/ — [secondary] инцидент мая 2023
44. https://cyble.com/blog/hazard-token-grabber/ и https://lunarcyber.com/blog/… — [secondary] индустрия token grabbers
45. https://medium.com/@dzianisskliar29/what-a-leaked-telegram-bot-token-actually-exposes-a764e984e84e — [secondary] тысячи живых Telegram-токенов на GitHub
46. https://dev.to/serhii_a9c08345ac360cf5c8/… (Login Widget / initData validation) — [secondary] окно `auth_date`, timing-safe сравнение
47. https://www.xda-developers.com/discord-log-out-sessions-other-devices/, https://www.digitalcitizen.life/how-to-see-and-deauthorize-apps-connected-to-your-discord-account/ — [secondary] UX «Devices» и «Authorized Apps»
48. https://developer.apple.com/videos/play/wwdc2026/201/ (Secure your apps with App Attest) — [secondary, не удалось извлечь текст] практика App Attest
