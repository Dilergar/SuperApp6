import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import {
  WorkspaceContextService,
  type AnalyticsClientContext,
  type WorkspaceContext,
} from '../context/workspace-context.service';
import { RolesService } from '../../core/roles/roles.service';
import { forbidden } from '../errors/api-error';
import type { JwtPayload } from '../decorators/current-user.decorator';
import { DEFER_WORKSPACE_CHECK_KEY } from '../decorators/defer-workspace-check.decorator';
import { ANALYTICS_HEADERS, KEYS_ERROR_CODES, LOCALE_HEADER, WORKSPACE_ROLE_RANK } from '@superapp/shared';
import { countryFromHeaders, negotiateLocale } from '@superapp/i18n';

const ROLE_RANK: Record<string, number> = WORKSPACE_ROLE_RANK;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    private readonly reflector: Reflector,
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
    let headerWs = this.readHeader(req?.headers);
    // Запрос ПО КЛЮЧУ API (core/keys): организация задана самим ключом. Ключ бота и
    // личный ключ данных организации работают только в ней (заголовок обязан совпасть
    // или отсутствовать); личный ключ собственных данных с организацией не работает вовсе.
    // Членство и роль дальше проверяются как у живой сессии: у бота роли лежат в
    // user_roles его теневого пользователя, у человека — его собственные.
    if (req?.user?.keyId) {
      const keyWs = req.user.keyWorkspaceId ?? null;
      if (keyWs) {
        if (headerWs && headerWs !== keyWs) {
          throw forbidden('keys.workspace_mismatch', undefined, { code: KEYS_ERROR_CODES.workspaceMismatch });
        }
        headerWs = keyWs;
      } else if (headerWs) {
        throw forbidden('keys.personal_needs_workspace', undefined, { code: KEYS_ERROR_CODES.personalKeyNeedsWorkspace });
      }
    }
    // Язык запроса — из `Accept-Language`, БЕЗ обращения к БД: клиент шлёт свой
    // текущий язык сам (веб — из cookie/профиля, mobile — из настроек, гость —
    // из браузера). Поход в `users` ради одного поля на КАЖДЫЙ запрос стоил бы
    // дороже, чем весь перевод.
    //
    // Страна — из гео-заголовка CDN, если он есть (в dev его нет). Она нужна
    // ровно для одного случая: человек В РОССИИ, просящий русский, получает
    // русский, а не государственный язык рынка (см. negotiateLocale).
    const locale = negotiateLocale(
      this.readFirst(req?.headers, 'accept-language'),
      // Явный выбор человека (веб и mobile шлют его `X-Locale`) сильнее любых
      // догадок: маршрут рынка применяется только к подсказке браузера.
      this.readFirst(req?.headers, LOCALE_HEADER.toLowerCase()),
      { country: countryFromHeaders((name) => this.readFirst(req?.headers, name)) },
    );
    const context: WorkspaceContext = { userId, locale, client: this.analyticsClient(req?.headers, req?.user?.sid) };
    const deferCheck = this.reflector.getAllAndOverride<boolean>(DEFER_WORKSPACE_CHECK_KEY, [
      execContext.getHandler(),
      execContext.getClass(),
    ]);

    if (headerWs && deferCheck) {
      // Маршрут без БД на пути запроса (приём аналитики): членство проверит консьюмер.
      // activeWorkspaceId НЕ ставится — chokepoint выключен, данных организации тут не читают.
      context.claimedWorkspaceId = headerWs;
    } else if (userId && headerWs) {
      const roles = await this.roles.getRolesInContext(
        userId,
        'workspace',
        headerWs,
      );
      if (roles.length === 0) {
        throw forbidden('workspace.noAccess');
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

  /**
   * Клиентский контекст серверных событий аналитики: сессия/устройство из заголовков
   * (только uuid — прочее молча игнорируется), `sid` токена, UA, `Sec-GPC`. Без БД.
   */
  private analyticsClient(headers: Record<string, unknown> | undefined, sid: string | undefined): AnalyticsClientContext {
    const uuid = (v: string | undefined) => (v && UUID_RE.test(v.trim()) ? v.trim().toLowerCase() : undefined);
    return {
      sessionId: uuid(this.readFirst(headers, ANALYTICS_HEADERS.session.toLowerCase())),
      deviceId: uuid(this.readFirst(headers, ANALYTICS_HEADERS.device.toLowerCase())),
      loginSid: uuid(sid),
      userAgent: this.readFirst(headers, 'user-agent')?.slice(0, 512),
      gpc: this.readFirst(headers, 'sec-gpc')?.trim() === '1',
    };
  }

  /** Заголовок первой строкой (Express кладёт массив при повторе). */
  private readFirst(headers: Record<string, unknown> | undefined, name: string): string | undefined {
    const raw = headers?.[name];
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
    return undefined;
  }

  private readHeader(headers?: Record<string, unknown>): string | undefined {
    const raw = headers?.['x-workspace-id'];
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
    if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0].trim();
    return undefined;
  }
}
