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
- Web: `app/dashboard/WorkspacesPanel.tsx` (org cards + incoming invites accept/reject + create) and `app/workspaces/[id]/page.tsx` (members, invite-by-phone, cancel, fire, leave). Switch into a workspace = open its page (entry point = dashboard org card).

## Events
WorkspacesService emits `workspace.invitation.sent/accepted/rejected`, `workspace.member.removed`, `workspace.role.changed` → `NotificationsEventsListener` (subscribes `workspace.*`) creates notifications. Registry entries + `NotificationType` union updated in `@superapp/shared`.

Design rationale & locked decisions: see auto-memory `project-workspaces-chokepoint-design`. Benchmarks: `mem:` ERP review (Salesforce/Odoo/Party pattern).
