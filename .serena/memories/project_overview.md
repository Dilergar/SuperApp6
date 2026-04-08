# SuperApp6 — Project Overview

SuperApp6 — WeChat-like super-app for Kazakhstan. Монорепо pnpm + Turborepo.

## Архитектура: модульный монолит
- NestJS API (`apps/api`) — модули общаются через EventBus (RxJS), не через прямой импорт
- `core/` = auth, users, roles (всегда загружены)
- `modules/` = notifications, contacts, circles, tasks, calendar
- `shared/` = database, redis, events, guards, decorators
- Каждый модуль можно вытащить в микросервис без переписывания

## Окружение (Social Graph)
> **"Контакты" НЕ СУЩЕСТВУЕТ как отдельная сущность.** Для пользователя всё — "Окружение".

- **Окружение** = одно на пользователя. Плоский список людей с подтверждённой двусторонней связью.
- **Папки** = опциональная группировка (Семья, Друзья, Коллеги). Шаблоны + своё название.
- **Flow:** Номер → роли (13 пресетов + свой) → приглашение → принятие → карточки у обоих → каждый раскладывает по папкам.
- Приглашения живут 24 часа. Cron (`ContactsCron`) каждый час удаляет обработанные из БД.
- Бэкенд: `contacts/` (связи, приглашения, блоки) + `circles/` (папки). Фронт: `/circles` = "Моё окружение".

## Web UI
- `/circles` — окружение: PersonCard grid, панель приглашений, папки-чипы, форма добавления с phone lookup
- `/profile` — профиль с сайдбаром: Моя карточка (PersonCard full + тогглы видимости), Статистика, Роли, Подписка, Настройки, Безопасность
- `PersonCard.tsx` — два режима: compact (grid) / full (профиль с тогглами). Стиль скетча: текстурная бумага, двойная рамка, мазки карандашами, уникальный наклон.
- `InvitationCard` — единый компонент для входящих/исходящих

## User модель
Поля: phone, firstName, lastName, dateOfBirth, avatar, bio, city, email, maritalStatus, socialLinks (JSON), onlineStatusMode, cardVisibility (JSONB), locale, timezone.
CardVisibility: каждое поле независимо (dateOfBirth, age, onlineStatus, maritalStatus, city, bio, email, socialLinks). age вычисляется на бэке. onlineStatus → зелёная точка-каракуля на аватаре.

## Безопасность
- JWT_SECRET обязателен (без фоллбэка). Bcrypt cost 10. @Throttle на auth (5/15мин), invitations (10/мин).
- XSS: Zod refine запрещает `<>`. Пароль: uppercase + lowercase + digit + special.
- Strict Zod на JSON полях. Error Boundary на фронте. Типы из @superapp/shared.

## Инфраструктура
- API: localhost:3001, Web: localhost:3000
- GitHub: https://github.com/Dilergar/SuperApp6
- Docker Hub: Dilergar
- 3 тестовых аккаунта: tester1/2/3, пароль Test1234!
- Mobile (Expo) не запускался
