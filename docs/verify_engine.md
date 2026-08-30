# core/verify — движок подтверждений (SMS-OTP)

> «Владеешь ли ты номером»: регистрация, сбросы, step-up критичных действий. Одноразовый `verifyToken`, который потребитель гасит В СВОЕЙ транзакции. Плюс `SmsOutboundService` — служебные исходящие SMS (зародыш канального движка).

## Модель

`VerifyChallenge` — одна АКТИВНАЯ цепочка на (phone, purpose); код 6 цифр ТОЛЬКО HMAC-хэшем (контекст phone+purpose); TTL 10 мин; **5 попыток на цепочку — ресенд НЕ сбрасывает**; ресенд = НОВЫЙ код в ту же цепочку; кулдаун 60→120с (сервер отдаёт `resendInSec` + `Retry-After`). Успешный check → **verifyToken** (64 hex, TTL 15 мин, в БД хэш).

## Контракт потребителя

```ts
// новая цель = ключ в VERIFY_PURPOSES (shared) + запуск startPublic/startStepUp
VerifyService.consume(tx, { verifyToken, purpose, expectedPhone?, expectedUserId? })
// → { phone, userId } — В ТРАНЗАКЦИИ целевого действия (откат = пропуск не потрачен)
```

Цели v1: `register` (verify-first; занятый номер → честный 409) · `password_reset` (цепочка привязана к АККАУНТУ; несуществующий номер → настоящая цепочка с недостижимым кодом — ответы/тайминг неотличимы, SMS не тратится; complete = смена + отзыв всех сессий и access-токенов + автовход) · `password_change` (пароль ДО отправки кода) · `phone_change_old`+`phone_change_new` (оба кода + пароль, обе гасятся одной tx) · `share_link_guest` (личность гостя; старт ТОЛЬКО через гостевой контроллер share-links — публичный /verify/start цель отвергает) · `sign_pep` (подпись ПЭП под документ).

## Несущие правила

- **Step-up требует пароль ДО отправки SMS** (неверный пароль не сжигает код; угнанный access-токен — не кнопка SMS-спама).
- **challengeId НЕ отдаётся на 429** (иначе посторонний сжигает чужую цепочку пятью неверными вводами); resume после F5 — из sessionStorage клиента.
- Пропуск сброса привязан к аккаунту (`consume` возвращает userId, сверяется текущий номер) — токен на освобождённый номер не сбросит пароль новому владельцу.
- Гео-щит: только казахстанские МОБИЛЬНЫЕ `+77[04567]…` — там, где номер выбирает клиент (register/reset/новый номер); на step-up по СОБСТВЕННОМУ номеру щита нет.
- Redis-лок `verify:start:<phone>:<purpose>` от двойного старта (замок берётся отдельно от отправки).
- Secure-by-default: `required` = production (`VERIFY_REQUIRED` перекрывает; false в prod → warn); в dev/test verifyToken опционален (seed и сьюты живут без правок).

## Анти-абьюз

Потолки на номер В БД (5/час, 10/день — переживают рестарт; окно от ПОСЛЕДНЕЙ отправки) + per-IP и глобальный часовой SMS-бюджет в Redis скользящим окном (best-effort: упал → warn, БД-лимиты держат; бюджет тратится по факту отправки; IP-эшелон выключен в dev/test) + CAPTCHA-слот (captchaToken в схеме, включение позже). IP — только `req.ip` (TRUST_PROXY).

## SMS-слой

Драйверы `kazinfoteh` (все операторы КЗ; креды телом POST) | `mock` (код в лог только в dev, маскированный номер). Отправка СИНХРОННО в запросе (НЕ core/jobs: юзер ждёт SMS; протухший код ретраить бессмысленно); упал провайдер → честный 503, цепочка НЕ создаётся (кулдаун не сжигается). Текст без слов: «SuperApp6: 123456» (мультиязычно, 1 сегмент) + env-слот origin-bound строки.

**`SmsOutboundService`** — служебные SMS потребителям (ссылка на подпись контрагенту): гео-щит, кулдаун 60с, суточный потолок организации.

## Dev/CI

Тест-карта `VERIFY_TEST_PHONES` (фикс-код, SMS не шлётся, лимиты скипаются; **в production игнорируется** без `VERIFY_TEST_PHONES_ALLOW_PROD`) · dev-ручка `GET /verify/dev/last-code` (только dev/test) · веб показывает «[dev] код: N».

## API

`GET /verify/status` · `POST /verify/start` (@Public) · `POST /verify/step-up` (авторизованный, пароль обязателен) · `POST /verify/check` (@Public) → `{verifyToken}` | 400 + `details.{attemptsLeft, code}`. Клиент ветвится по `details.code` (`VERIFY_ERROR_CODES`), не по тексту.

Веб-кит `components/verify/`: `CodeInput` (один скрытый input, `autocomplete="one-time-code"`, автосабмит) + `useOtpFlow` (state-машина; тикающий серверный таймер; 429-resume) + `OtpStep`. Экраны на ките: `/register` — 3 шага (номер → код → профиль; занятый номер → кнопки «Войти»/«Забыли пароль») · `/reset-password` (номер → код → новый пароль → автовход) · «Забыли пароль?» на `/login` · `/profile/security` — модалки «Изменить пароль»/«Сменить номер» (`security-dialogs.tsx`).

Поле верификации на пользователе — `users.phoneVerifiedAt DateTime?` (булевого `isVerified` в БД нет; DTO отдаёт `isVerified` computed).

## Проверка

`verify-otp.cjs` (идемпотентен к повторному прогону).
