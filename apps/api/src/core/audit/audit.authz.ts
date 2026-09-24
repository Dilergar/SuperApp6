import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Request } from 'express';
import { isAuditAuthzIgnored } from '@superapp/shared';
import type { RequestActor, RequestWithContext } from '../../shared/context/request-context';
import type { JwtPayload } from '../../shared/decorators/current-user.decorator';
import { onAccessDenied, type AccessDeniedSignal } from '../../shared/filters/access-denied.signal';
import { AuditDetections } from './audit.detections';
import { AuditService } from './audit.service';

/** Окно свёртки `authz.denied`: одна строка на (актор, шаблон маршрута) за час — на счётчиках 1, 10, 100… */
const AUTHZ_COLLAPSE_SEC = 60 * 60;
/** Параметр маршрута, похожий на id объекта (uuid или число) — только такие считает детекция перебора */
const OBJECT_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{1,19})$/i;

type DeniedRequest = Request & RequestWithContext & { user?: JwtPayload; platformActor?: { userId: string; sessionId: string; roles: readonly string[] } };

/**
 * Отказы доступа (core/audit): слушатель сигнала глобального фильтра ошибок.
 *
 * - 403 (нет права) — свёртка `authz.denied` на (актор, шаблон маршрута) за час: строки на
 *   счётчиках 1, 10, 100… с полем `attempts`, только платформе (AWS CloudTrail `AccessDenied`).
 * - 403 и 404 на маршруте с id объекта — каждый в счётчик детекции `idor_probing`: 404 у нас —
 *   тоже «чужое» (существование объекта не раскрывается), и перебор чужих id идёт именно им.
 *
 * Не считаются: отказ до входа (нет актора — это вход, у него свой журнал), адрес без маршрута
 * (404 «нет такой ручки»), отказы-состояния `AUDIT_AUTHZ_IGNORED_CODES` (свежая сессия, шлюз
 * согласий, заморозка). Запись — best-effort вне транзакции: факта в БД у отказа нет.
 */
@Injectable()
export class AuditAuthz implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditAuthz.name);
  private off: (() => void) | null = null;

  constructor(
    private readonly audit: AuditService,
    private readonly detections: AuditDetections,
  ) {}

  onModuleInit(): void {
    this.off = onAccessDenied((signal) => {
      void this.denied(signal).catch((err: unknown) => this.logger.debug(`access denial skipped: ${err instanceof Error ? err.message : String(err)}`));
    });
  }

  onModuleDestroy(): void {
    this.off?.();
  }

  async denied({ req, status, code }: AccessDeniedSignal): Promise<void> {
    if (isAuditAuthzIgnored(code)) return;
    const r = req as DeniedRequest;
    const actor = this.actorOf(r);
    if (!actor) return;
    const route = typeof r.route?.path === 'string' ? r.route.path.slice(0, 200) : null;
    if (!route) return;

    const ids = Object.values(r.params ?? {})
      .filter((v): v is string => typeof v === 'string' && OBJECT_ID_RE.test(v))
      .sort();
    if (ids.length) {
      await this.detections.accessDenied(actor.id, `${route}|${ids.join(',')}`, null).catch(() => undefined);
    }
    if (status !== 403) return;

    const reason = code && /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? code : 'forbidden';
    await this.audit.recordCollapsed(`authz:${actor.id}:${route}`, AUTHZ_COLLAPSE_SEC, (attempts) => ({
      key: 'authz.denied',
      actor: { kind: actor.kind, id: actor.id, sessionId: actor.sessionId, familyId: actor.familyId, keyId: actor.keyId, roles: actor.roles ?? null },
      outcome: 'denied',
      reasonCode: reason.slice(0, 64),
      ...(ids[0] ? { target: { type: 'route_object', id: ids[0] } } : {}),
      // Фильтр ошибок работает вне ALS интерцептора — контекст (IP, устройство, маршрут) явно
      ...(r.ctx
        ? { ctx: { requestId: r.ctx.requestId, ip: r.ctx.ip, userAgent: r.ctx.userAgent, uaFamily: r.ctx.uaFamily, deviceId: r.ctx.deviceId, country: r.ctx.country, client: r.ctx.client, route } }
        : {}),
      details: { reason, attempts },
    }));
  }

  /**
   * Актор из аутентификации: интерцептор ставит его после гардов, а отказ гарда случается ДО
   * интерцептора — тогда он выводится тем же правилом из `req.user` / `req.platformActor`.
   */
  private actorOf(r: DeniedRequest): RequestActor | null {
    if (r.ctx?.actor) return r.ctx.actor;
    if (r.platformActor?.userId) {
      return { kind: 'platform_staff', id: r.platformActor.userId, sessionId: r.platformActor.sessionId, familyId: null, keyId: null, roles: r.platformActor.roles };
    }
    const u = r.user;
    if (u?.sub && u.aud !== 'platform') {
      return { kind: u.kind === 'bot' ? 'bot' : 'user', id: u.sub, sessionId: u.sid ?? null, familyId: u.fam ?? null, keyId: u.keyId ?? null };
    }
    return null;
  }
}
