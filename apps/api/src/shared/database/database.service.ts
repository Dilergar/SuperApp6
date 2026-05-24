import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { WorkspaceContextService } from '../context/workspace-context.service';

// Models owned by a workspace (B2B tenant). Auto-scoped by the chokepoint when an
// active workspace is set. Task carries a nullable workspaceId (null = personal).
const WORKSPACE_SCOPED_MODELS = new Set<string>(['Task']);

// Read/aggregate/bulk-write operations whose `where` we constrain to the active workspace.
const SCOPED_FILTER_OPS = new Set<string>([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
]);

/**
 * Builds the Prisma client extended with the workspace "chokepoint": when a request has
 * an active workspace (set by WorkspaceContextInterceptor after a membership check), queries
 * on workspace-owned models are auto-scoped to that workspace, so callers can't forget the
 * filter. Strict no-op when there is no active workspace → personal/social flows untouched.
 *
 * Single-record ops by unique id (findUnique/update/delete) are left to the owning service;
 * the bulk read/write operations above are the leak vector.
 */
export function buildScopedPrismaClient(wsContext: WorkspaceContextService) {
  const client = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

  return client.$extends({
    name: 'workspaceScope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const workspaceId = wsContext.activeWorkspaceId;
          if (workspaceId && WORKSPACE_SCOPED_MODELS.has(model)) {
            const a = (args ?? {}) as Record<string, unknown>;

            if (SCOPED_FILTER_OPS.has(operation)) {
              a.where = a.where
                ? { AND: [a.where, { workspaceId }] }
                : { workspaceId };
              return query(a);
            }

            if (operation === 'create') {
              const data = (a.data ?? {}) as Record<string, unknown>;
              if (data.workspaceId == null) data.workspaceId = workspaceId;
              a.data = data;
              return query(a);
            }

            if (operation === 'createMany') {
              const data = a.data;
              if (Array.isArray(data)) {
                for (const row of data as Array<Record<string, unknown>>) {
                  if (row && row.workspaceId == null) row.workspaceId = workspaceId;
                }
              } else if (data && (data as Record<string, unknown>).workspaceId == null) {
                (data as Record<string, unknown>).workspaceId = workspaceId;
              }
              return query(a);
            }
          }
          return query(args);
        },
      },
    },
  });
}

export type ScopedPrismaClient = ReturnType<typeof buildScopedPrismaClient>;

/**
 * Injection token + type for the database client. Declared `extends PrismaClient` so
 * consumers get full delegate typing (`this.db.task`, `this.db.workspace`, …). The actual
 * VALUE is provided by a factory in DatabaseModule (the extended client above) — this class
 * is never directly instantiated.
 */
@Injectable()
export class DatabaseService extends PrismaClient {}
