import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  WorkspaceContextService,
  type WorkspaceContext,
} from '../context/workspace-context.service';
import { RolesService } from '../../core/roles/roles.service';
import type { JwtPayload } from '../decorators/current-user.decorator';

const ROLE_RANK: Record<string, number> = {
  owner: 5,
  admin: 4,
  manager: 3,
  staff: 2,
  guest: 1,
};

/**
 * Establishes the request-scoped WorkspaceContext (chokepoint gate).
 *
 * If the request carries an `X-Workspace-Id` header, the caller's membership is verified
 * (fail-closed: 403 if they have no role in that workspace) and the active workspace + role
 * are stored in AsyncLocalStorage for the duration of the request. The DatabaseService
 * middleware then auto-scopes workspace-owned models to it.
 *
 * No header → personal context (no active workspace) → DB middleware is a no-op.
 */
@Injectable()
export class WorkspaceContextInterceptor implements NestInterceptor {
  constructor(
    private readonly wsContext: WorkspaceContextService,
    private readonly roles: RolesService,
  ) {}

  async intercept(
    execContext: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = execContext.switchToHttp().getRequest<{
      user?: JwtPayload;
      headers?: Record<string, unknown>;
    }>();

    const userId = req?.user?.sub;
    const headerWs = this.readHeader(req?.headers);
    const context: WorkspaceContext = { userId };

    if (userId && headerWs) {
      const roles = await this.roles.getRolesInContext(
        userId,
        'workspace',
        headerWs,
      );
      if (roles.length === 0) {
        throw new ForbiddenException('Нет доступа к этой организации');
      }
      context.activeWorkspaceId = headerWs;
      context.role = roles
        .map((r) => r.role)
        .sort((a, b) => (ROLE_RANK[b] ?? 0) - (ROLE_RANK[a] ?? 0))[0];
    }

    // Wrap the handler's execution in the ALS scope so downstream DB queries
    // (run on subscription) observe the context.
    return new Observable((subscriber) => {
      this.wsContext.run(context, () => {
        next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });
      });
    });
  }

  private readHeader(headers?: Record<string, unknown>): string | undefined {
    const raw = headers?.['x-workspace-id'];
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
    if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0].trim();
    return undefined;
  }
}
