# Синхронные рёбра модулей (генерируется)

> СГЕНЕРИРОВАНО скриптом `scripts/check-docs.cjs --write` из импортов и DI-токенов `apps/api/src`; руками не править. Смысл рёбер и правила — [module_graph.md](module_graph.md) и [module_graph_documents.md](module_graph_documents.md). Ребро = модуль-потребитель импортирует что-либо из каталога другого модуля (кроме `import type`) или зовёт его ленивым `DI_TOKENS` (помечено «токен»).

| Потребитель | Зависит от |
|---|---|
| `core/approvals` | `core/access`, `core/audiences`, `core/jobs`, `core/rich-cards`, `modules/notifications` |
| `core/audiences` | `core/access` |
| `core/auth` | `core/jobs`, `core/users`, `core/verify`, `modules/notifications` |
| `core/calls` | `core/files`, `core/jobs`, `modules/notifications` |
| `core/chatter` | `core/jobs` |
| `core/docs` | `core/access`, `core/chatter`, `core/files`, `core/jobs`, `core/share-links` |
| `core/files` | `core/jobs`, `modules/notifications` |
| `core/quick-actions` | `core/access` |
| `core/rich-cards` | `core/access`, `modules/messenger (токен)` |
| `core/roles` | `core/access` |
| `core/share-links` | `core/chatter`, `core/verify`, `modules/notifications` |
| `core/sign` | `core/approvals`, `core/files`, `core/jobs`, `core/roles`, `core/share-links`, `core/templates`, `core/verify`, `modules/notifications` |
| `core/templates` | `core/files` |
| `core/users` | `core/access`, `core/files`, `core/jobs`, `core/verify`, `modules/contacts`, `modules/notifications`, `modules/workspaces` |
| `core/voice` | `core/files`, `core/jobs` |
| `modules/calendar` | `core/access`, `core/jobs`, `core/quick-actions`, `core/rich-cards`, `modules/contacts`, `modules/notifications` |
| `modules/card-skins` | `modules/wallet` |
| `modules/circles` | `core/access`, `modules/contacts` |
| `modules/contacts` | `core/access`, `core/audiences`, `modules/notifications` |
| `modules/counterparties` | `core/chatter`, `core/rich-cards`, `core/roles`, `core/search`, `core/templates` |
| `modules/documents` | `core/access`, `core/approvals`, `core/audiences`, `core/chatter`, `core/docs`, `core/files`, `core/jobs`, `core/rich-cards`, `core/roles`, `core/search`, `core/share-links`, `core/sign`, `core/templates`, `core/verify`, `modules/counterparties`, `modules/drive`, `modules/hr (токен)`, `modules/notifications`, `modules/processes (токен)`, `modules/staff` |
| `modules/drive` | `core/access`, `core/audiences`, `core/chatter`, `core/files`, `core/jobs`, `core/quick-actions`, `core/rich-cards`, `core/roles`, `core/search`, `core/share-links`, `modules/contacts`, `modules/notifications` |
| `modules/finances` | `core/access`, `core/quick-actions`, `core/rich-cards`, `modules/calendar`, `modules/contacts`, `modules/notifications` |
| `modules/hr` | `core/audiences`, `core/chatter`, `core/files`, `core/jobs`, `core/roles`, `core/sign`, `core/templates`, `modules/documents`, `modules/notifications`, `modules/processes`, `modules/staff`, `modules/tasks`, `modules/workspaces` |
| `modules/messenger` | `core/access`, `core/calls`, `core/chatter`, `core/files`, `core/jobs`, `core/quick-actions`, `core/search`, `modules/calendar (токен)`, `modules/contacts`, `modules/drive`, `modules/notifications` |
| `modules/notifications` | `core/jobs` |
| `modules/office` | `core/access`, `core/calls`, `core/rich-cards`, `core/roles`, `modules/messenger`, `modules/notifications` |
| `modules/processes` | `core/approvals`, `core/audiences`, `core/chatter`, `core/rich-cards (токен)`, `core/roles`, `modules/documents (токен)`, `modules/finances (токен)`, `modules/hr (токен)`, `modules/messenger (токен)`, `modules/notifications`, `modules/staff (токен)`, `modules/tasks`, `modules/workspaces (токен)` |
| `modules/recorder` | `core/calls`, `core/files`, `core/voice`, `modules/notifications` |
| `modules/shop` | `core/access`, `core/files`, `core/rich-cards`, `modules/calendar`, `modules/contacts`, `modules/messenger`, `modules/notifications`, `modules/tasks`, `modules/wallet` |
| `modules/staff` | `core/access`, `core/audiences`, `core/chatter`, `core/roles`, `core/search`, `core/templates`, `modules/notifications` |
| `modules/tasks` | `core/access`, `core/chatter`, `core/files`, `core/quick-actions`, `core/rich-cards`, `modules/calendar`, `modules/contacts`, `modules/drive`, `modules/messenger`, `modules/notifications`, `modules/processes (токен)`, `modules/shop (токен)`, `modules/wallet` |
| `modules/workspaces` | `core/approvals`, `core/chatter`, `core/files`, `core/roles`, `core/share-links`, `core/templates`, `modules/hr (токен)`, `modules/notifications`, `modules/office (токен)`, `modules/staff`, `modules/wallet` |
