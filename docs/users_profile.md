# Профиль и аккаунт человека (core/users + auth)

> Анкета, реквизиты человека, видимость, сессии и жизненный цикл аккаунта. Механика аутентификации (JWT/tokenEpoch/refresh) — [security.md](security.md); SMS-подтверждения — [verify_engine.md](verify_engine.md); видимость карточки по Группам — [contacts_circles.md](contacts_circles.md).

## Анкета (`GET/PATCH /users/me`)

- Поля: firstName / lastName / **middleName** (отчество — для договоров и трудоустройства, в карточках НЕ показывается) / dateOfBirth / bio / city / email / maritalStatus / socialLinks (`.strict()`) / onlineStatusMode / avatar (publicUrl движка файлов; веб — `AvatarUploadBlock`).
- **Дата рождения в анкете — ТРИ поля** (день / месяц НАЗВАНИЕМ `MONTH_NAMES_RU` / год).
- `cardVisibility` — одиночная карта «видимость по умолчанию» (для зрителей вне Групп); PATCH **мержит** карту, не заменяет. `companyCardVisibility` — отдельный набор «Видимость в Компаниях» (что видят коллеги в ростере; реквизитные поля — в `extras`, по умолчанию выключены; manager+ видит нередактируемый комплект всегда — [workspaces.md](workspaces.md)).
- `GET /users/me` отдаёт также roles, counts (contactsCount/circlesCount/workspacesCount — workspacesCount кэшируется 5 мин и сбрасывается при archive/restore), isVerified (computed из `phoneVerifiedAt`).

## Реквизиты человека (блок «Для договоров и трудоустройства»)

`users.iin` (контрольная сумма — два прохода весов mod 11, `packages/shared/src/utils/requisites.ts`) / `residentialAddress` / `idDocNumber` / `idDocIssuedBy` / `idDocIssuedAt`. Потребители: core/templates (группа «Сотрудник»), КЭДО, core/sign (сверка ИИН сертификата). В личном Окружении реквизиты не показываются вовсе — это данные рабочего контекста; коллегам — только по тумблерам `companyCardVisibility.extras`.

## Сессии и устройства

- `GET /users/me/sessions` → `SessionInfo[]` (`{id, deviceInfo, lastActive, createdAt, isCurrent}`): `isCurrent` считает СЕРВЕР по `sid` из payload access-токена; `deviceInfo` (User-Agent) пишется при входе и наследуется через ротацию (старые сессии без него → «Неизвестное устройство»).
- `DELETE /users/me/sessions/:id` — завершить сессию; завершение СВОЕЙ — с подтверждением в вебе.
- `POST /auth/logout-all` — отзыв всех сессий + бамп tokenEpoch (гасит и access-токены, и живые сокеты).

## Смена пароля / номера (step-up через core/verify)

- `POST /users/me/change-password` `{currentPassword, newPassword, verifyToken, currentRefreshToken?}` — пароль + SMS; другие сессии гаснут, текущая живёт.
- `POST /users/me/change-phone` — СТРОГО оба кода (старый + новый номер) + пароль, всё гасится одной транзакцией; активация pending-приглашений нового номера — джобом `users.phone.invitations` в той же tx. «Старый номер утерян» — не поддержано осознанно (v2: задержка 48ч).
- `POST /auth/password-reset` `{verifyToken, newPassword}` — сброс: смена + отзыв ВСЕХ сессий + уведомление + автовход; аккаунт в грейс-периоде восстанавливается.

## Жизненный цикл аккаунта

- `DELETE /users/me` (требует пароль) — мягкое удаление с **грейс-периодом 30 дней**: вход блокируется, но логин в течение грейса = авто-восстановление; по истечении `AccountCron` анонимизирует (PII стёрт, номер освобождён, `deletedAt` терминально). Общие данные (задачи/воркспейсы) сохраняются. Регистрация на номер в грейсе → 409 с подсказкой «войдите, чтобы восстановить».
- Регистрация: verify-first (в production `verifyToken` обязателен), активирует pending-приглашения контактов и организаций.

## Поиск по номеру

`GET /users/lookup?phone=` (форма приглашения): фамилия — **инициалом** («Санжар Н.», `maskLastName`), отдельный лимит 30/час против перебора номеров.

## Веб (`/profile`)

Вложенные роуты `/profile/<секция>` (URL переживает F5, работает «Назад»): Моя карточка (read-only PersonCard + селектор «как видит Группа X») · Моя Анкета (данные + реквизиты + тумблеры видимости по умолчанию и «в Компаниях») · Статистика · Мои роли · Скины карточки · Кошелёк · Ссылки наружу · Подписка · Настройки · Безопасность (сессии, смена пароля/номера через модалки, «Опасная зона»).

## Проверка

`verify-otp.cjs` (регистрация/сбросы/смены), `verify-requisites.cjs`, `verify-logout-socket.cjs`, `verify-security-fixes.cjs`.
