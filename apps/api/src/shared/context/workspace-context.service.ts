import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface WorkspaceContext {
  userId?: string;
  /** Active workspace for this request (from X-Workspace-Id), set ONLY after a membership check. */
  activeWorkspaceId?: string;
  /** The user's effective role in the active workspace. */
  role?: string;
}

/**
 * Request-scoped "active workspace" context, backed by AsyncLocalStorage (no extra deps).
 *
 * Populated by WorkspaceContextInterceptor from the `X-Workspace-Id` header AFTER verifying
 * membership. Read by the DatabaseService `$use` middleware to auto-scope workspace-owned
 * models to the active workspace — the "chokepoint" turnstile.
 *
 * When no active workspace is set (personal mode), the middleware is a strict no-op, so
 * personal/social flows are completely unaffected.
 */
@Injectable()
export class WorkspaceContextService {
  private readonly als = new AsyncLocalStorage<WorkspaceContext>();

  run<T>(context: WorkspaceContext, fn: () => T): T {
    return this.als.run(context, fn);
  }

  get(): WorkspaceContext | undefined {
    return this.als.getStore();
  }

  get activeWorkspaceId(): string | undefined {
    return this.als.getStore()?.activeWorkspaceId;
  }
}
