# core/verify — движок подтверждений (11-й платформенный, SMS-OTP). ПОСТРОЕН 2026-07-24, РЕВЬЮ 2026-07-25

Дизайн (грилл + 4 ресёрч-агента) и стройка — одна сессия. **ПОЛНОЕ РЕВЬЮ 2026-07-25: 26 находок, ВСЕ починены той же сессией** (раздел «Ревью» внизу — читать его ПЕРВЫМ, он перекрывает часть описания ниже). После ревью: **verify-otp.cjs 63/0 дважды подряд** (скрипт идемпотентен к повторному прогону) + ВЕСЬ сьют 50 скриптов зелёный по exit-code + браузер (регистрация 3 шага, resume после F5 из sessionStorage, отказ step-up на неверном пароле без SMS, сброс; 0 ошибок консоли). nest build + web tsc чистые. НЕ закоммичено на момент записи.

## Что закрывает
Дыра «занял чужой номер → получил его external-приглашения» (register активировал приглашения без проверки владения); отсутствие восстановления пароля, смены пароля и смены номера.

## Архитектура (как построено)
`apps/api/src/core/verify/`: `verify.module.ts` (@Global) · `verify.service.ts` (ядро) · `verify.sms.ts` (драйверы) · `verify.controller.ts` (REST) · `verify.cron.ts` (ретеншн 7д, батчами, Redis-лок, раз в 6ч).

**Модель `VerifyChallenge`** (`verify_challenges`, миграция `20260724060000_verify_engine`): phone, purpose, codeHash, attempts, sendCount, lastSentAt, expiresAt, verifiedAt, consumedAt, verifyTokenHash @unique, requestIp, userId, createdAt; индексы (phone,purpose,createdAt) + (createdAt). FK на users НЕТ. `User.isVerified` ЗАМЕНЁН на `phoneVerifiedAt DateTime?` (grandfather = createdAt в миграции руками: add → UPDATE → drop; DTO отдаёт isVerified computed — веб/мобайл не тронуты).

**Механика**: одна АКТИВНАЯ цепочка на (phone,purpose) — findFirst живой (expires>now, attempts<5, не verified/consumed); повторный start = ресенд НОВОГО кода в ту же цепочку (Supabase-модель; «тот же код» невозможен — храним только HMAC-SHA256(phone|purpose|code, `verify:`+JWT_SECRET)); attempts НЕ сбрасываются ресендом (SuperTokens); кулдаун 60с → 120с (sendCount>=2), потолок 5 отправок на цепочку; 429 несёт `details.{resendInSec, challengeId}` — веб делает RESUME цепочки после F5/двойного клика. `check`: timingSafeEqual, промах = атомарный attempts++ (гвард lt max) + `details.attemptsLeft`; успех = updateMany-гонка (verifiedAt null) → verifyToken (32 байта hex, в БД SHA-256). `consume(tx, {verifyToken, purpose, expectedPhone?, expectedUserId?})` — findUnique по хэшу + проверки (verified, не consumed, TTL 15 мин, purpose/phone/userId match) + updateMany-гвард consumedAt null; В ТРАНЗАКЦИИ потребителя. Возвращает {phone}.

**Лимиты**: номерные В БД (SUM(sendCount) окном createdAt: 5/час, 10/день — переживают рестарт); per-IP (10 start/час, 30 check/5мин) и глобальный бюджет (env VERIFY_SMS_HOURLY_BUDGET, дефолт 200) — Redis INCR+EXPIRE, best-effort (Redis упал → warn+пропуск, БД держит). Гео-щит `isKzMobilePhone` (+77\d{9}) — только на verify-путях, общая phoneSchema не тронута. SMS ДО insert цепочки (упал провайдер → 503, кулдаун не сожжён).

**SMS-драйверы** (`verify.sms.ts`): `kazinfoteh` — POST `https://kazinfoteh.org:9507/api?action=sendmessage&username&password&recipient(без +)&messagetype=SMS:TEXT&originator&messagedata`, ответ XML statuscode 0 = ок (толерантный парс — СВЕРИТЬ при живом аккаунте); `mock` — код в лог. production+mock → warn при старте. Отправка СИНХРОННАЯ (НЕ core/jobs — юзер ждёт, ретрай протухшего кода бессмыслен). Текст: `buildOtpSmsText(code, originDomain?)` = «SuperApp6: 123456» (+ опц. «@domain #code»).

**Secure-by-default**: `VerifyService.required` = VERIFY_REQUIRED ?? (NODE_ENV==='production'); register без токена при required → 400. В dev seed + все verify-скрипты живут. production VERIFY_REQUIRED=false → громкий warn (env.validation).

**Dev/CI**: тест-карта VERIFY_TEST_PHONES (фикс-код, SMS и ЛИМИТЫ скипаются); dev-код цепочки кладётся в Redis `verify:devcode:<id>` ТОЛЬКО в development/test → `GET /verify/dev/last-code?challengeId=` (иначе 404); веб показывает «[dev] код: N».

## Потребители
- **AuthService**: register принимает verifyToken? → consume(tx, register, expectedPhone) в транзакции создания + phoneVerifiedAt; `resetPassword(verifyToken, newPassword)` — consume(tx, password_reset) → user по phone из ЦЕПОЧКИ (не из body!) → bcrypt до tx → смена + deletionScheduledAt=null (грейс-восстановление) + deleteMany сессий → delPattern кэша + `auth.sessions.revoked` (сокеты) + notify `auth.password.changed` + АВТОВХОД (generateTokens). Контроллер: POST /auth/password-reset @Public 5/15мин.
- **UsersService**: `changePassword` (bcrypt compare текущего → consume(tx, password_change, expectedUserId) + update + deleteMany сессий КРОМЕ currentRefreshToken-хэша) и `changePhone` (пароль + consume old (expectedPhone=текущий) + consume new (expectedPhone=newPhone) в ОДНОЙ tx + update phone/phoneVerifiedAt + отзыв других сессий + активация pending-приглашений НОВОГО номера через ContactsService/WorkspacesService — механика регистрации 1:1 + notify auth.phone.changed c newPhoneMasked). Гонка занятости номера — @unique(phone) P2002 → 409 фильтром. anonymizeAccount чистит phoneVerifiedAt.
- **Новые DI-рёбра** (карта CLAUDE.md обновлена): AuthService → VerifyService + NotificationsService; UsersService → VerifyService + Contacts + Workspaces + Notifications (циклов нет — все @Global).

**AllExceptionsFilter** расширен: HttpException body `{message, details}` → details уходит в конверт (первый потребитель — resendInSec/attemptsLeft; generic для всех).

**NOTIFICATION_REGISTRY**: + `auth.password.changed`, `auth.phone.changed` (category system, push true). Прямой notify (не emitEvent-джоб).

## Веб (`components/verify/` — переиспользуемый кит)
- `CodeInput.tsx`: 6 бумажных ячеек (стили `.otp-cell*`/`.otp-shake` в globals.css; лёгкие повороты, ghost-border), ОДИН скрытый input поверх (opacity 0) — autocomplete="one-time-code"/inputMode=numeric работают нативно, paste целиком, автосабмит onComplete (один раз на значение), shake на ошибке.
- `otp-flow.ts` (`useOtpFlow`): startPublic/startStepUp/resend/check/reset; тикающий resendLeft с СЕРВЕРНЫХ секунд; 429-RESUME (details.challengeId → продолжаем цепочку); dev-код fetch best-effort.
- `OtpStep.tsx`: маска номера, CodeInput, ресенд-кнопка с таймером «(0:59)», «← изменить номер», [dev]-подсказка.
- Страницы: `/register` — 3 шага (номер → код → профиль; прогресс-«чернильные точки»; 409 → кнопки Войти/Забыли пароль; verifyToken протух (>15 мин на шаге 3) → кнопка «Получить новый код» по regex /подтвержден/i на message) · `/reset-password` (номер → код → пароль → applySession-автовход → /dashboard) · `/login` + ссылка «Забыли пароль?» · `/profile/security` — `security-dialogs.tsx`: ChangePasswordDialog (форма → код → done; неверный текущий пароль → назад к форме) и ChangePhoneDialog (форма(пароль+новый номер) → код на СТАРЫЙ → код на НОВЫЙ → done; честный текст «нет доступа к старому — смена пока невозможна», БЕЗ мёртвых кнопок). Плейсхолдер «Изменить пароль (скоро)» ЗАМЕНЁН настоящей функцией.
- `auth store`: register принимает verifyToken; новый `applySession(tokens)` для автовхода reset.

## Решения продукта (грилл 2026-07-24, не менять без пользователя)
- Скоуп v1: регистрация + сброс + смена пароля + смена номера. Организация БЕЗ SMS. Вход с нового устройства = v2.
- Только +7 7xx. Регистрация — честно «занят», сброс — нейтрально.
- SMS-текст без слов «SuperApp6: 123456».
- Смена номера СТРОГО оба кода; «старый утерян» → v2 (48ч задержка + отмена из ленты).
- Автовход после сброса (Kaspi), НЕ OWASP-редирект на логин.
- Провайдер ТОЛЬКО Kazinfoteh (+mock). Mobizon/SMSC НЕ писать (реестр позволит добавить).

## Бизнес-шаги пользователя (не код)
1. Договор Kazinfoteh (kazinfoteh.kz, отдел продаж) → KIT_USERNAME/PASSWORD/ORIGINATOR + SMS_DRIVER=kazinfoteh; сверить XML-ответ драйвера на живом аккаунте.
2. По росту: альфа-имя «SuperApp6» у операторов (2–4 нед, ~14–45 тыс ₸/мес) — SMS от бренда.

## Отложено (v2+)
Вход по SMS (passwordless), device-tracking + SMS на новое устройство, смена номера без старого (48ч+отмена), CAPTCHA (Turnstile; слот captchaToken уже в схеме), origin-bound строка (нужен домен — env-слот готов), Telegram Gateway (~5 ₸, checkSendAbility) и WhatsApp auth (~4 ₸, BSP Kazinfoteh) как дешёвые каналы, SMS-приглашения незарегистрированным, согласие с офертой (нет юр-текстов), Android SMS Retriever hash (mobile-этап).

## РЕВЬЮ 2026-07-25 — 26 находок, все закрыты (миграция `20260725060000_verify_review_fixes`)

Читать раньше остального: часть механики выше ЗАМЕНЕНА.

**P0 — безопасность**
1. **`users.tokenEpoch`** (новая колонка, default 0). `JwtPayload.epoch` (опционально — старые токены = 0, раскатка никого не разлогинивает); `JwtStrategy` держит в Redis-кэше `auth:alive:<id>` ПОКОЛЕНИЕ, а не флаг `'1'`, и отвергает отставший токен. Бампают: `AuthService.resetPassword`, `logoutAll`, `UsersService.changePassword`, `changePhone` (все — В ТРАНЗАКЦИИ, `bumpTokenEpochTx`), после коммита чистят ключ. **Зачем:** «отозвали все сессии» удаляло только строки `session`, а украденный ACCESS-токен работал ещё до 15 минут. Текущая вкладка переживает бамп прозрачно (её refresh цел → single-flight refresh выдаёт новое поколение) — проверено в браузере: 401 → /auth/refresh → все запросы 200.
2. **IP только из `req.ip`** (`clientIp` больше НЕ читает XFF руками) + `app.set('trust proxy', TRUST_PROXY)` в main.ts + env `TRUST_PROXY` + warn в production, если не задан. **Зачем:** XFF пишет кто угодно → счётчики `verify:ip:*` и троттлер обнулялись строкой в запросе.
3. **challengeId НЕ уходит в 429.** Resume после F5 — из `sessionStorage` (`sa6_otp:<purpose>:<phone|self>`, TTL 10 мин = TTL цепочки). **Зачем:** знающий чужой номер получал id живой цепочки и сжигал её 5 неверными вводами.
4. **Пропуск сброса привязан к аккаунту:** `startPublic(password_reset)` кладёт найденный `userId` в цепочку, `consume` возвращает `{phone, userId}`, `resetPassword` ищет юзера по id (фолбэк по phone для доджобовых цепочек) и сверяет, что его номер не изменился. **Зачем:** токен на освобождённый номер сбросил бы пароль НОВОМУ владельцу номера.
5. **Уведомления после коммита — `.catch(log)`** (reset/changePassword/changePhone). **Зачем:** упавшая лента отдавала 500 после уже совершённой смены, а в ответе сброса едут токены автовхода.
6. **Активация приглашений при смене номера → джоб core/jobs `users.phone.invitations`** (`USER_PHONE_INVITATIONS_JOB`, `UsersService implements OnModuleInit`, enqueue в ТОЙ ЖЕ транзакции, uniqueKey `phone-inv:<user>:<phone>`, `JobDiscardError` если аккаунта нет / номер уже другой). **Зачем:** два голых await'а после коммита — упал первый, второй не выполнился, номер уже сменён, приглашения организаций потеряны.

**Энумерация**
7. Нейтральный сброс = **НАСТОЯЩАЯ цепочка** (`delivery='simulated'`, случайный недостижимый код, SMS не шлём) + имитация задержки шлюза (`simulatedSendDelayMinMs..MaxMs` 180–520 мс). Раньше пустышка отвечала мгновенно и никогда не упиралась в кулдаун/потолки, а `check` по фейковому id не отдавал `attemptsLeft` — два оракула «есть ли такой аккаунт». Теперь всё совпадает; dev-код у имитации НЕ пишется (verify это проверяет).

**Деньги / гонки**
8. **Redis-лок `verify:start:<phone>:<purpose>`** (15с) — двойной клик больше не даёт две SMS. ВАЖНО: замок берётся `acquireLock` ОТДЕЛЬНО от вызова (не `withLock`) — иначе ошибка самой отправки попадала бы в catch «Redis недоступен» и приводила ко ВТОРОМУ заходу, т.е. второй SMS.
9. **Потолки на номер — окном по `lastSentAt` OR `createdAt`** (+индекс `(phone,last_sent_at)`): ресенды долгоживущей цепочки выпадали из часового окна. Перебор в сторону строгости — для анти-абьюза правильно.
10. **Скользящее окно на двух корзинах** (`slidingCount`, модель Cloudflare) вместо INCR+EXPIRE: на границе часа лимит удваивался. Глобальный бюджет тратится **по факту отправки** (`bumpGlobalBudget` после успешного send), проверяется без инкремента.
11. **IP-эшелоны выключены в dev/test** (как троттлер платформы) — иначе повторный локальный прогон verify-otp упирался в 10 стартов/час.

**Step-up**
12. **`verifyStepUpSchema.password` обязателен**, `startStepUp(userId, purpose, password, newPhone?, ip?)` проверяет bcrypt ДО отправки. Закрывает и «неверный пароль после сожжённой SMS», и «угнанный access-токен = кнопка SMS-спама». `changePassword` проверяет пароль повторно (мог смениться между шагами).
13. Гео-щит применяется только к целям, где номер выбирает клиент (`CLIENT_CHOSEN_PURPOSES` = register/password_reset/phone_change_new); на step-up по СОБСТВЕННОМУ номеру щита нет — иначе легаси-аккаунт с не-казахстанским номером навсегда без смены пароля.

**Номера**
14. `isKzMobilePhone` = `/^\+77[04567]\d{8}$/` — городские 71x/72x отсечены (SMS на них провайдер отобьёт). Новая **`kzMobilePhoneSchema`** (в `validation/auth.ts`, рядом с широкой `phoneSchema`) применена к `registerSchema.phone`, `verifyStartSchema.phone`, `newPhone`. Широкая `phoneSchema` осталась у login/lookup/приглашений — легаси-аккаунты обязаны логиниться. Побочно: `verify-access-projection.cjs` переведён с +7999 на +7706.

**Kazinfoteh**
15. Креды **телом POST** (form-urlencoded), не в query string (логи прокси/провайдера/APM). 16. `KIT_URL` в env. 17. `KIT_ORIGINATOR` обязателен в env-валидации, дефолт `'INFO_KAZ'` убран. 18. Первый ответ шлюза логируется целиком (`formatLogged`) — разбор XML сверяется на живом аккаунте по логу, а не гаданием.

**Контракт ошибок**
19. **`VERIFY_ERROR_CODES`** (shared) → `details.code`: `verify_token_stale | verify_code_wrong | verify_chain_dead | verify_cooldown`. Веб ветвится по коду (`isTokenStale(err)`), regex `/подтвержден/i` убран из двух страниц. 20. `AllExceptionsFilter` ставит **`Retry-After`** на 429 при наличии `details.resendInSec`.

**Прочее**
21. `VERIFY_TEST_PHONES` в production **игнорируется** (error-лог) без `VERIFY_TEST_PHONES_ALLOW_PROD=true`. 22. `providerMessageId` + `delivery` (`sms|simulated|test_map`) в БД — доказательство отправки для поддержки. 23. Таймер ресенда «2:00» вместо «0:120» (`formatCountdown`). 24. 429-resume показывает МАСКУ номера (был сырой номер / пустая строка на step-up). 25. `GET /verify/status` реально используется — хук `use-verify-status.ts`, `OtpStep` пишет «Отправка SMS не настроена» при `smsEnabled=false` (раньше ручка была мёртвой). 26. Комментарии в schema.prisma и `constants/verify.ts` врали про «ресенд шлёт ТОТ ЖЕ код» — приведены к коду (новый код в ту же цепочку).

**Тесты/CI**: verify-otp расширен до 63 чеков (эпоха токенов, неотличимость нейтрального сброса, отсутствие challengeId в 429, Retry-After, step-up без/с неверным паролем, swap пропусков old/new, ресенд не сбрасывает attempts, тест-карта). Скрипт **идемпотентен** (тест-карта гасит хвост прошлого прогона верным кодом; счётчик попыток проверяется относительно). CI-.env получил `VERIFY_TEST_PHONES=+77099999999:424242`.

**НЕ сделано осознанно**: mobile шлёт register без verifyToken → в production 400. Приложение не компилируется и переписывается на этапе 2 — OTP-экран в нём был бы выброшенным кодом. Зафиксировано жёстким блокером в CLAUDE.md (блок 8 «Известные риски»).

**Признано НЕ дефектом при проверке**: «контакты видят старый номер 5 минут после смены» — кэш `user:<id>:profile` только для своего `/users/me` и инвалидируется; списки окружения читают БД живьём.

## Ресёрч-факты (не переискивать)
Прямые операторы ДОРОЖЕ агрегаторов для OTP: Kcell BulkSMS 15.54 ₸ единый + 14.5К/мес имя + 5К/мес транзит + окна подключения 1/15 числа + штраф 1 млн ₸; полное покрытие КЗ напрямую = ~50-55К ₸/мес фикс. Агрегаторы: Kazinfoteh OTP 8.1–10.4 ₸ (дешевле всех, Meta Tech Provider), Mobizon 10.4 ₸ но общая подпись НЕ покрывает Beeline, SMSC.kz ~20 ₸ покрывает всех. Кириллица 70 симв = 1 сегмент. Консенсус OSS: 6 цифр/10-15 мин/5 попыток на цепочку/60с кулдаун/глобальный бюджет/test-номера/хэш кода/CAPTCHA-гейт (Firebase всегда).
