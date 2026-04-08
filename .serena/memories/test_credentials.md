# Test Accounts (dev only)

Три тестовых аккаунта для dev-окружения. Имена обновлены 2026-04-07 (кириллица была garbled из-за encoding).

## User 1 — tester1
- **Phone:** `+77001234567`
- **Password:** `Test1234!`
- **Name:** tester1
- **User ID:** `36d348dd-769e-4777-8260-7234f3d5b10e`
- **Role:** `user` в `system`

## User 2 — tester2
- **Phone:** `+77012345678`
- **Password:** `Test1234!`
- **Name:** tester2
- **User ID:** `4c48c3db-ccf7-40aa-b361-1e5ba3097ae0`
- **Role:** `user` в `system`

## User 3 — tester3
- **Phone:** `+77023456789`
- **Password:** `Test1234!`
- **Name:** tester3
- **User ID:** `9cc1d3d7-b307-42ce-ac3e-183179d21813`
- **Role:** `user` в `system`

## Использование
- Web: http://localhost:3000/login
- Swagger: http://localhost:3001/api/docs
- Логин: `POST /api/auth/login` → `{ phone, password }` → получить `accessToken`
- Для тестов окружения: отправить invite от tester1 к tester2 (`toPhone: +77012345678`), принять от tester2

**НЕ использовать в проде.** Только dev.
