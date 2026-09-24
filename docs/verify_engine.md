# core/verify — движок подтверждений (SMS-OTP)

> «Владеешь ли ты номером»: регистрация, сбросы, step-up критичных действий. Одноразовый `verifyToken`, который потребитель гасит В СВОЕЙ транзакции. Плюс `SmsOutboundService` — служебные исходящие SMS (зародыш канального движка).

## Модель

`VerifyChallenge` — одна АКТИВНАЯ цепочка на (phone, purpose); код 6 цифр ТОЛЬКО HMAC-хэшем (контекст phone+purpose); TTL 10 мин; **5 попыток на цепочку — ресенд НЕ сбрасывает**; ресенд = НОВЫЙ код в ту же цепочку; кулдаун 60→120с (сервер отдаёт `resendInSec` + `Retry-After`). Успешный check → **verifyToken** (64 hex, TTL 15 мин, в БД хэш).

Цели журнала безопасности — `account_freeze` (экстренная заморозка без входа: код на номер аккаунта; старт только `/auth/freeze/start`), `account_unfreeze` (пароль проверяется на старте, код — вторым фактором; сброс пароля заморозку не снимает) и `security_confirm` (подтверждение НОВОЙ сессии раньше срока cooling: пароль + код на свой номер; старт — `/verify/step-up`, гашение — `POST /users/me/sessions/confirm`) — [audit_engine.md](audit_engine.md).

Цели кабинета платформы — `platform_login` (второй фактор входа после пароля) и `platform_step_up` (sudo на 15 минут; `consume` с `expectedUserId` актора) — [platform_console.md](platform_console.md).

## Контракт потребителя

```ts
// новая цель = ключ в VERIFY_PURPOSES (shared) + запуск startPublic/startStepUp
VerifyService.consume(tx, { verifyToken, purpose, expectedPhone?, expectedUserId? })
// → { phone, userId } — В ТРАНЗАКЦИИ целевого действия (откат = пропуск не потрачен)
```

Цели v1: `register` (verify-first; занятый номер → честный 409) · `password_reset` (цепочка привязана к АККАУНТУ; несуществующий номер → настоящая цепочка с недостижимым кодом — ответы/тайминг неотличимы, SMS не тратится; complete = смена + отзыв всех сессий и access-токенов + автовход) · `password_change` (пароль ДО отправки кода) · `phone_change_old`+`phone_change_new` (оба кода + пароль, обе гасятся одной tx) · `share_link_guest` (личность гостя; старт ТОЛЬКО через гостевой контроллер share-links — публичный /verify/start цель отвергает) · `sign_pep` (подпись ПЭП под документ) · `account_delete` (удаление аккаунта = отзыв согласия на ПДн; step-up, гасится в транзакции удаления).

**Согласия регистрации** ([consents_engine.md](consents_engine.md)): `POST /verify/start` цели `register` обязан нести `consents` (id версий пакета `registration`, язык, канал) — без них `400 consents.required`, и проверка стоит ПЕРВОЙ: SMS не уходит, цепочка не заводится. Принятое ложится в `VerifyChallenge.context` (ресенд с новым выбором перезаписывает), а `consume` отдаёт его вместе с `challengeId`, `startedAt` и `smsSent` — записи приёмки строятся из контекста цепочки, а не из тела шага 3.

## Несущие правила

- **Step-up требует пароль ДО отправки SMS** (неверный пароль не сжигает код; угнанный access-токен — не кнопка SMS-спама).
- **challengeId НЕ отдаётся на 429** (иначе посторонний сжигает чужую цепочку пятью неверными вводами); resume после F5 — из sessionStorage клиента.
- Пропуск сброса привязан к аккаунту (`consume` возвращает userId, сверяется текущий номер) — токен на освобождённый номер не сбросит пароль новому владельцу.
- Гео-щит: только казахстанские МОБИЛЬНЫЕ `+77[04567]…` — там, где номер выбирает клиент (register/reset/новый номер); на step-up по СОБСТВЕННОМУ номеру щита нет.
- Redis-лок `verify:start:<phone>:<purpose>` от двойного старта (замок берётся отдельно от отправки).
- Secure-by-default: `required` = production (`VERIFY_REQUIRED` перекрывает; false в prod → warn); в dev/test verifyToken опционален (seed и сьюты живут без правок).

## Окна «сильного подтверждения» (`StepUpService`)

Одна служба окна на платформу (`core/verify/step-up.service.ts`): пароль + код на свой номер открывают окно N минут, в течение которого действие не требует нового SMS. Цели с окном — `STEP_UP_WINDOW_PURPOSES`: `keys_manage` (ключи и боты — [keys_api_access.md](keys_api_access.md)), `visibility_reveal` (раскрытие строгих полей одной записи), `visibility_manage` (публикация, ослабляющая строгие поля, и делегирование раскрытия — [visibility_engine.md](visibility_engine.md)). Окно одной цели не открывает другую: ключ Redis `verify:stepup:<цель>:<userId>`. Поток клиента: `POST /verify/step-up {purpose, password}` → `POST /verify/check` → `POST /verify/step-up/confirm {purpose, verifyToken}` → `{until}`; досрочно — `POST /verify/step-up/end`. Потребитель зовёт только `stepUp.assert(userId, purpose)` → `403` с кодом цели из `STEP_UP_REQUIRED_CODES` (клиент ведёт в шаг «пароль → код»). Все окна человека закрываются вместе с сессиями: «выйти везде», смена пароля, «Это не я» (`afterAccessRevoked`). Сюда же встанут passkeys и ЭЦП-вход.

## Анти-абьюз

Потолки на номер В БД (5/час, 10/день — переживают рестарт; окно от ПОСЛЕДНЕЙ отправки) + per-IP и глобальный часовой SMS-бюджет в Redis скользящим окном (best-effort: упал → warn, БД-лимиты держат; бюджет тратится по факту отправки; IP-эшелон выключен в dev/test) + CAPTCHA-слот (captchaToken в схеме, включение позже). IP — только `req.ip` (TRUST_PROXY).

## SMS-слой

Драйверы `kazinfoteh` (все операторы КЗ; креды телом POST) | `mock` (код в лог только в dev, маскированный номер). Отправка СИНХРОННО в запросе (НЕ core/jobs: юзер ждёт SMS; протухший код ретраить бессмысленно); упал провайдер → честный 503, цепочка НЕ создаётся (кулдаун не сжигается). Текст без слов: «SuperApp6: 123456» (мультиязычно, 1 сегмент) + env-слот origin-bound строки.

**`SmsOutboundService`** — служебные SMS потребителям (ссылка на подпись контрагенту): гео-щит, кулдаун 60с, суточный потолок организации; `sendAccountAlert` — тревожная SMS владельцу аккаунта на его собственный номер (запрошено удаление): без opt-in, не чаще одной в час, best-effort. Каждая фактическая отправка SMS человеку с аккаунтом пишется в учёт действий с ПДн (получатель `kazinfoteh`). Канал `sms` движка уведомлений ([notifications_engine.md](notifications_engine.md)) берёт тот же драйвер `VerifySmsService` напрямую (critical + opt-in человека, свои суточные потолки в Redis по этому образцу).

## Dev/CI

Тест-карта `VERIFY_TEST_PHONES` (фикс-код, SMS не шлётся, лимиты скипаются; **в production игнорируется** без `VERIFY_TEST_PHONES_ALLOW_PROD`) · dev-ручка `GET /verify/dev/last-code` (только dev/test) · веб показывает «[dev] код: N».

## API

`GET /verify/status` · `POST /verify/start` (@Public) · `POST /verify/step-up` (авторизованный, пароль обязателен) · `POST /verify/check` (@Public) → `{verifyToken}` | 400 + `details.{attemptsLeft, code}`. Клиент ветвится по `details.code` (`VERIFY_ERROR_CODES`), не по тексту.

Веб-кит `components/verify/`: `CodeInput` (один скрытый input, `autocomplete="one-time-code"`, автосабмит) + `useOtpFlow` (state-машина; тикающий серверный таймер; 429-resume) + `OtpStep`. Экраны на ките: `/register` — 3 шага (номер → код → профиль; занятый номер → кнопки «Войти»/«Забыли пароль») · `/reset-password` (номер → код → новый пароль → автовход) · «Забыли пароль?» на `/login` · `/profile/security` — модалки «Изменить пароль»/«Сменить номер» (`security-dialogs.tsx`).

Поле верификации на пользователе — `users.phoneVerifiedAt DateTime?` (булевого `isVerified` в БД нет; DTO отдаёт `isVerified` computed).

## Проверка

`verify-otp.cjs` (идемпотентен к повторному прогону).
