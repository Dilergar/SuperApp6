# Синхронные рёбра модулей (генерируется)

> СГЕНЕРИРОВАНО скриптом `scripts/check-docs.cjs --write` из импортов и DI-токенов `apps/api/src`; руками не править. Смысл рёбер и правила — [module_graph.md](module_graph.md) и [module_graph_documents.md](module_graph_documents.md). Ребро = модуль-потребитель импортирует что-либо из каталога другого модуля (кроме `import type`) или зовёт его ленивым `DI_TOKENS` (помечено «токен»).

| Потребитель | Зависит от |
|---|---|
| `core/analytics` | `core/entitlements`, `core/jobs`, `core/platform`, `core/roles` |
| `core/approvals` | `core/access`, `core/audiences`, `core/jobs`, `core/notifications`, `core/rich-cards` |
| `core/audiences` | `core/access` |
| `core/auth` | `core/analytics`, `core/consents`, `core/entitlements`, `core/jobs`, `core/keys`, `core/notifications`, `core/users`, `core/verify` |
| `core/calls` | `core/files`, `core/idempotency`, `core/jobs`, `core/notifications` |
| `core/chatter` | `core/jobs` |
| `core/consents` | `core/analytics`, `core/files`, `core/jobs`, `core/keys`, `core/notifications`, `core/platform`, `core/sign`, `core/templates` |
| `core/docs` | `core/access`, `core/chatter`, `core/files`, `core/jobs`, `core/keys`, `core/share-links` |
| `core/entitlements` | `core/analytics`, `core/audiences`, `core/jobs`, `core/notifications`, `core/platform`, `core/realtime` |
| `core/files` | `core/entitlements`, `core/jobs`, `core/keys`, `core/notifications` |
| `core/idempotency` | `core/keys`, `core/platform` |
| `core/keys` | `core/analytics`, `core/audiences`, `core/entitlements`, `core/jobs`, `core/notifications`, `core/platform`, `core/realtime`, `core/roles`, `core/verify` |
| `core/notifications` | `core/analytics`, `core/audiences`, `core/consents`, `core/entitlements`, `core/jobs`, `core/realtime`, `core/roles`, `core/verify` |
| `core/platform` | `core/approvals`, `core/audiences`, `core/keys`, `core/notifications`, `core/verify` |
| `core/quick-actions` | `core/access` |
| `core/rich-cards` | `core/access`, `core/notifications` |
| `core/roles` | `core/access` |
| `core/share-links` | `core/analytics`, `core/chatter`, `core/consents`, `core/keys`, `core/notifications`, `core/verify` |
| `core/sign` | `core/approvals`, `core/files`, `core/jobs`, `core/notifications`, `core/roles`, `core/share-links`, `core/templates`, `core/verify` |
| `core/templates` | `core/files` |
| `core/users` | `core/access`, `core/analytics`, `core/consents`, `core/entitlements`, `core/files`, `core/jobs`, `core/keys`, `core/notifications`, `core/platform`, `core/verify`, `modules/contacts`, `modules/workspaces` |
| `core/verify` | `core/consents`, `core/keys` |
| `core/voice` | `core/files`, `core/jobs` |
| `core/webhooks` | `core/analytics`, `core/consents`, `core/entitlements`, `core/jobs`, `core/keys`, `core/notifications`, `core/platform` |
| `modules/calendar` | `core/access`, `core/analytics`, `core/jobs`, `core/notifications`, `core/quick-actions`, `core/rich-cards`, `modules/contacts` |
| `modules/card-skins` | `core/entitlements`, `modules/wallet` |
| `modules/circles` | `core/access`, `core/entitlements`, `modules/contacts` |
| `modules/contacts` | `core/access`, `core/audiences`, `core/notifications` |
| `modules/counterparties` | `core/chatter`, `core/rich-cards`, `core/roles`, `core/search`, `core/templates`, `modules/notes` |
| `modules/documents` | `core/access`, `core/approvals`, `core/audiences`, `core/chatter`, `core/docs`, `core/files`, `core/jobs`, `core/notifications`, `core/rich-cards`, `core/roles`, `core/search`, `core/share-links`, `core/sign`, `core/templates`, `core/verify`, `core/webhooks`, `modules/counterparties`, `modules/drive`, `modules/hr (токен)`, `modules/notes`, `modules/processes (токен)`, `modules/staff` |
| `modules/drive` | `core/access`, `core/audiences`, `core/chatter`, `core/files`, `core/jobs`, `core/notifications`, `core/quick-actions`, `core/rich-cards`, `core/roles`, `core/search`, `core/share-links`, `modules/contacts` |
| `modules/finances` | `core/access`, `core/notifications`, `core/quick-actions`, `core/rich-cards`, `modules/calendar`, `modules/contacts` |
| `modules/google-calendar` | `core/consents`, `core/keys` |
| `modules/hr` | `core/audiences`, `core/chatter`, `core/files`, `core/jobs`, `core/keys`, `core/notifications`, `core/roles`, `core/sign`, `core/templates`, `modules/documents`, `modules/processes`, `modules/staff`, `modules/tasks`, `modules/workspaces` |
| `modules/messenger` | `core/access`, `core/analytics`, `core/calls`, `core/chatter`, `core/files`, `core/jobs`, `core/notifications`, `core/quick-actions`, `core/realtime`, `core/rich-cards`, `core/search`, `modules/calendar (токен)`, `modules/contacts`, `modules/drive` |
| `modules/notes` | `core/access`, `core/audiences`, `core/chatter`, `core/files`, `core/jobs`, `core/notifications`, `core/quick-actions`, `core/rich-cards`, `core/roles`, `core/search`, `modules/contacts`, `modules/drive`, `modules/messenger` |
| `modules/objects` | `core/access`, `core/chatter`, `core/entitlements`, `core/files`, `core/jobs`, `core/notifications`, `core/rich-cards`, `core/roles`, `core/search`, `modules/calendar`, `modules/drive`, `modules/hr`, `modules/notes`, `modules/staff`, `modules/workspaces` |
| `modules/office` | `core/access`, `core/calls`, `core/notifications`, `core/rich-cards`, `core/roles`, `modules/messenger` |
| `modules/processes` | `core/approvals`, `core/audiences`, `core/chatter`, `core/idempotency`, `core/jobs`, `core/keys`, `core/notifications`, `core/rich-cards (токен)`, `core/roles`, `modules/documents (токен)`, `modules/finances (токен)`, `modules/hr (токен)`, `modules/messenger (токен)`, `modules/staff (токен)`, `modules/tasks`, `modules/workspaces (токен)` |
| `modules/recorder` | `core/calls`, `core/files`, `core/notifications`, `core/voice` |
| `modules/shop` | `core/access`, `core/entitlements`, `core/files`, `core/notifications`, `core/rich-cards`, `modules/calendar`, `modules/contacts`, `modules/messenger`, `modules/tasks`, `modules/wallet` |
| `modules/staff` | `core/access`, `core/audiences`, `core/chatter`, `core/notifications`, `core/roles`, `core/search`, `core/templates` |
| `modules/tasks` | `core/access`, `core/analytics`, `core/chatter`, `core/files`, `core/notifications`, `core/quick-actions`, `core/rich-cards`, `core/webhooks`, `modules/calendar`, `modules/contacts`, `modules/drive`, `modules/messenger`, `modules/notes`, `modules/processes (токен)`, `modules/shop (токен)`, `modules/wallet` |
| `modules/wallet` | `core/idempotency`, `core/keys` |
| `modules/workspaces` | `core/analytics`, `core/approvals`, `core/chatter`, `core/consents`, `core/entitlements`, `core/files`, `core/keys`, `core/notifications`, `core/platform`, `core/realtime`, `core/roles`, `core/share-links`, `core/templates`, `core/webhooks`, `modules/hr (токен)`, `modules/office (токен)`, `modules/staff`, `modules/wallet` |
