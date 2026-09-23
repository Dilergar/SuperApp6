import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'crypto';
import type { Request } from 'express';
import type { RequestWithContext } from '../../shared/context/request-context';
import { PLATFORM_ERROR_CODES, PLATFORM_LIMITS } from '@superapp/shared';
import { badRequest, forbidden, unauthorized } from '../../shared/errors/api-error';
import {
  IS_PLATFORM_ROUTE_KEY,
  PLATFORM_ACCESS_KEY,
  type PlatformAccessMeta,
  type PlatformActor,
} from '../../shared/decorators/platform.decorator';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformNotifier } from './platform.notifications';
import { PLATFORM_AUDIT_KEYS } from './platform.constants';

type PlatformRequest = Request & { platformActor?: PlatformActor };

/**
 * Единственный гард /platform/* (APP_GUARD после продуктового JwtAuthGuard, который
 * такие маршруты пропускает). Deny by default: маршрут без объявленного доступа
 * отвергается (а на бутстрапе — роняет старт, см. PlatformModule).
 *
 * Порядок: стоп-кран → отказ заголовку организации (S16) → доступ по декларации:
 * public (только вход) · session (токен кабинета) · capability (токен + право).
 */
@Injectable()
export class PlatformAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: PlatformAuthService,
    private readonly audit: PlatformAuditService,
    private readonly notifier: PlatformNotifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPlatform = this.reflector.getAllAndOverride<boolean>(IS_PLATFORM_ROUTE_KEY, [context.getHandler(), context.getClass()]);
    if (!isPlatform) return true;

    if (!this.auth.consoleEnabled()) throw new NotFoundException();

    const req = context.switchToHttp().getRequest<PlatformRequest>();
    if (req.headers['x-workspace-id']) {
      throw badRequest('platform.workspace_header_rejected', undefined, { code: PLATFORM_ERROR_CODES.workspaceHeaderRejected });
    }

    const access = this.reflector.getAllAndOverride<PlatformAccessMeta | undefined>(PLATFORM_ACCESS_KEY, [context.getHandler(), context.getClass()]);
    if (!access) throw forbidden('platform.capability_denied', { capability: '?' }, { code: PLATFORM_ERROR_CODES.capabilityDenied });
    if (access.kind === 'public') return true;

    const header = req.headers.authorization;
    const raw = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!raw) throw unauthorized('auth.unauthorized');

    // id запроса — ОДИН на платформу (core/audit): его ставит middleware контекста запроса,
    // эхом уходит в ответ и в `details.requestId` отказа; журнал Кабинета пишет тот же
    const requestId = (req as RequestWithContext).ctx?.requestId ?? randomUUID();
    const actor = await this.auth.authenticate(raw, {
      ip: req.ip ?? null,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 300) : null,
      requestId,
    });
    req.platformActor = actor;

    if (access.kind === 'capability' && !actor.capabilities.includes(access.capability)) {
      await this.audit.writeDenied({
        actorId: actor.userId,
        actorRolesSnapshot: actor.roles,
        sessionId: actor.sessionId,
        requestId,
        commandKey: PLATFORM_AUDIT_KEYS.httpDenied,
        input: { method: req.method, path: req.path },
        errorCode: PLATFORM_ERROR_CODES.capabilityDenied,
        readOnly: true,
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      void this.deniedBurst(actor.userId);
      throw forbidden('platform.capability_denied', { capability: access.capability }, { code: PLATFORM_ERROR_CODES.capabilityDenied });
    }
    return true;
  }

  /** Серия отказов за час ровно на пороге → security-alert владельцам (один раз на порог). */
  private async deniedBurst(actorId: string): Promise<void> {
    try {
      const n = await this.audit.deniedInLastHour(actorId);
      if (n === PLATFORM_LIMITS.deniedAlertThreshold) await this.notifier.securityAlert(null, actorId, 'deniedBurst', `${n}/h`);
    } catch {
      /* best-effort */
    }
  }
}
