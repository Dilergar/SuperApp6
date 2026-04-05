# Windows Build Gotchas

Проект разрабатывается на Windows 11. Несколько реальных подводных камней:

## 1. tsc не работает из Git Bash
`npx tsc` / `tsc --noEmit` падает из Git Bash. Нужно запускать через PowerShell:
```bash
powershell -Command "cd apps/web; npx tsc --noEmit"
powershell -Command "cd packages/shared; npx tsc"
```
PowerShell ExecutionPolicy уже настроен: `RemoteSigned`.

## 2. tsconfig.tsbuildinfo кеш
`*.tsbuildinfo` может кешировать устаревший incremental state. Если `tsc` не производит dist-файлов или даёт странные ошибки — удалить `.tsbuildinfo` и пересобрать. Добавлено в `.gitignore`.

## 3. Prisma AI protection
`pnpm db:push --force-reset` блокируется без env var:
```bash
PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=true pnpm db:push --force-reset
```
Обычный `db:push` без force-reset проходит нормально.

## 4. CRLF предупреждения git
Git на Windows ругается `warning: LF will be replaced by CRLF`. Это ОК — git autocrlf работает штатно. Игнорировать.

## 5. Redis lazyConnect
В `apps/api/src/shared/redis/redis.service.ts` был флаг `lazyConnect: true` — он блокировал подключение. Убран. Если появится снова — удалить.
