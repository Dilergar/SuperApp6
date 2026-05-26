# Workspaces (B2B) + Chokepoint

Built 2026-05-24. B2B foundation per the ERP architecture review. See `mem:social_graph_architecture` for the parallel B2C model.

## Model
- A **Workspace** is always a business/org (B2B tenant). Personal life = social graph (`Task.workspaceId = null`), NOT a workspace. No `type` field.
- **Role = single source of truth in `UserRole`** (`context="workspace"`, `tenantId=workspaceId`). `WorkspaceMember` holds ONLY HR metadata (department, position, joinedAt) — its `role` column was dropped. Member list = join WorkspaceMember + UserRole. Exactly one workspace role per user per workspace (`setSoleWorkspaceRole`).
- One **owner** (`Workspace.ownerId`); ownership changes only via transfer. Roles: owner/admin/manager/staff/guest. Service-layer gates: `assertMember` / `assertCanManage` (owner|admin) / `assertOwner` — same pattern as circles/contacts (no `@Roles` guard usage).
- **WorkspaceInvitation**: hire by phone (separate from ContactInvitation). `toUserId` null for unregistered phone → activated in `AuthService.register` via `activatePendingWorkspaceInvitationsForNewUser`. Invitation → accept/reject. TTL 30d (`WORKSPACE_LIMITS`).
- One person can own many orgs AND be employed in many (Universal Identity). Hiring is independent of personal Окружение.
- Reserved system role `mystery_shopper` (constant only) for future Jobs Marketplace.

## Chokepoint (tenant isolation, app-layer — no RLS, like Salesforce)
- `WorkspaceContextService` = native `AsyncLocalStorage` (NOT nestjs-cls). Holds `{ userId, activeWorkspaceId, role }`.
- `WorkspaceContextInterceptor` (APP_INTERCEPTOR): reads `X-Workspace-Id` header → verifies membership via `RolesService.getRolesInContext` (fail-closed 403) → runs handler inside ALS scope.
- `DatabaseService` = Prisma client extended via **`$extends`** (NOTE: `$use` middleware was removed in Prisma 6.19). Provided by a `useFactory` in `DatabaseModule` (`buildScopedPrismaClient`, connects on startup). The class `DatabaseService extends PrismaClient` is kept only as DI token + type → zero consumer changes.
- Auto-scope injects `workspaceId` filter on B2B models (`WORKSPACE_SCOPED_MODELS = {Task}`) for findMany/findFirst/count/aggregate/groupBy/updateMany/deleteMany + sets it on create/createMany. **DORMANT** when no active workspace (personal flows untouched). Currently no client sends the header / no workspace-task flow → effectively dormant until cross-cutting workspace features are built.

## API `/api/workspaces` & Web
- 16 endpoints (CRUD, transfer, leave, members, invitations). Incoming-invitation routes declared before `:id` to avoid capture.
- Web org area mirrors personal b2c (`/dashboard`↔`/profile`): `app/workspaces/[id]/page.tsx` = **Главная организации** (header + services grid Сотрудники/Задачи/Календарь + stats; «Профиль» is a nav-bar tab in `[id]/layout.tsx`, NOT a service tile), `app/workspaces/[id]/profile/[section]/page.tsx` = **org profile** (6 sections card/anketa/stats/subscription/settings/security, role-gated sidebar in `profile/layout.tsx`), `app/workspaces/[id]/members/page.tsx` = members mgmt (invite-by-phone, cancel, fire, leave — separate from profile, like Окружение is separate from /profile). `app/workspaces/[id]/CompanyCard.tsx` (compact/full) = company card, shown to employees in «Организации» via `app/dashboard/WorkspacesPanel.tsx`. Entry point = dashboard org card → Главная организации.

## Org profile (Party pattern — org = entity with card + anketa, mirrors personal /profile)
- `Workspace` profile fields (migration `20260524191741_workspace_profile_fields`): `description, industry, city, website, contactEmail, contactPhone` + `cardVisibility` (Json). No new subscription model — Подписка section is a placeholder ("Бесплатный план").
- `WorkspaceCardVisibility` (shared) — per-field flags; `DEFAULT_WORKSPACE_CARD_VISIBILITY` (contactPhone/membersCount off by default) + `resolveWorkspaceCardVisibility`. Zod `updateWorkspaceProfileSchema` (noHtml refine).
- `serializeWorkspace` is **role-aware**: owner/admin (`canSeeAll`) get every field + `cardVisibility`; members get only fields enabled in visibility (others → null) and NOT `cardVisibility`. `tasksCount` via `_count`. `GET /:id` + `GET /` both apply it. `PATCH /:id` (manage) accepts the profile fields + `cardVisibility` (full resolved map stored).
- **Atomicity (B1-B3):** `transferOwnership` / `acceptInvitation` (race-safe) / `createWorkspace` run the sole-workspace-role write in a transaction via `setSoleWorkspaceRoleTx`; `RolesService.invalidateUserCache` is public for cache busting.

## Events
WorkspacesService emits `workspace.invitation.sent/accepted/rejected`, `workspace.member.removed`, `workspace.role.changed` → `NotificationsEventsListener` (subscribes `workspace.*`) creates notifications. Registry entries + `NotificationType` union updated in `@superapp/shared`.

Design rationale & locked decisions: see auto-memory `project-workspaces-chokepoint-design`. Benchmarks: `mem:` ERP review (Salesforce/Odoo/Party pattern).
