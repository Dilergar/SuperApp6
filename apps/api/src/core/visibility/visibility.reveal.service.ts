import { Injectable, Logger } from '@nestjs/common';
import {
  VISIBILITY_ERROR_CODES,
  VISIBILITY_LIMITS,
  VISIBILITY_REDIS,
  isVisibilityRecordType,
  visibilityFieldEntry,
  type VisibilityRevealInput,
  type VisibilityRevealResultDto,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { ApiError, forbidden, notFound } from '../../shared/errors/api-error';
import { RedisService } from '../../shared/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AudiencesService } from '../audiences/audiences.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StepUpService } from '../verify/step-up.service';
import { VisibilityMetrics } from './visibility.metrics';
import { typeTitleKey } from './visibility.policy.service';
import { VisibilityTypeRegistry } from './visibility.registry';
import { VisibilityService, type VisibilityViewer } from './visibility.service';

/**
 * Раскрытие маскированного значения ОДНОЙ записи (break-glass, решение грилла №3/№7).
 *
 * Правила: только человек своей сессией (боты, ключи API, ИИ — 403 всегда); план зрителя
 * обязан давать `reveal: 'one'` на КАЖДОЕ поле (право на запись проверяет провайдер типа —
 * чужая/невидимая запись = одинаковый 404); строгий класс (`restricted`) — окно SMS-
 * подтверждения 15 минут (`visibility_reveal`); квота `visibility.revealsPerDay` (402);
 * событие `pii.reveal` видит и субъект, и организация; при тумблере политики — уведомление
 * субъекту. Ответ не кэшируется и нигде не хранится (Snowflake: раскрытое не копируется).
 * Детекция: ≥ 30 раскрытий за 10 мин — раскрытия этому человеку стоят, владельцам тревога.
 */
@Injectable()
export class VisibilityRevealService {
  private readonly logger = new Logger(VisibilityRevealService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly visibility: VisibilityService,
    private readonly types: VisibilityTypeRegistry,
    private readonly stepUp: StepUpService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
    private readonly notifications: NotificationsService,
    private readonly audiences: AudiencesService,
    private readonly metrics: VisibilityMetrics,
  ) {}

  async reveal(viewer: VisibilityViewer, input: VisibilityRevealInput): Promise<VisibilityRevealResultDto> {
    const recordType = input.recordType;
    const fields = [...new Set(input.fields)];
    // Бот / ключ / ИИ — никогда (решение грилла №7); гость — тем более
    if (viewer.kind !== 'user' || !viewer.userId || viewer.purpose !== 'api') {
      this.metrics.reveals.inc({ outcome: 'not_human' });
      throw forbidden(VISIBILITY_ERROR_CODES.revealNotAllowed, undefined, { code: VISIBILITY_ERROR_CODES.revealNotAllowed });
    }
    const userId = viewer.userId;
    if (!isVisibilityRecordType(recordType) || fields.some((f) => !visibilityFieldEntry(recordType, f))) {
      throw notFound(VISIBILITY_ERROR_CODES.recordNotFound, undefined, { code: VISIBILITY_ERROR_CODES.recordNotFound });
    }
    const provider = this.types.get(recordType);
    const loaded = provider ? await provider.loadForReveal(userId, viewer.workspaceId, input.recordId, fields) : null;
    if (!loaded) {
      this.metrics.reveals.inc({ outcome: 'not_found' });
      throw notFound(VISIBILITY_ERROR_CODES.recordNotFound, undefined, { code: VISIBILITY_ERROR_CODES.recordNotFound });
    }
    const { ref, values } = loaded;
    const workspaceId = ref.workspaceId;
    const deny = async (reason: string, err: ApiError): Promise<never> => {
      this.metrics.reveals.inc({ outcome: reason });
      await this.audit
        .recordCollapsed(`vis:reveal_denied:${userId}:${recordType}`, 3600, (attempts) => ({
          key: 'pii.reveal_denied',
          outcome: 'denied',
          reasonCode: reason,
          workspaceId,
          subjectUserId: ref.subjectId,
          target: { type: recordType, id: ref.recordId },
          details: { recordType, fields, reason, attempts },
        }))
        .catch(() => undefined);
      await this.analytics.track(null, 'visibility.reveal.requested', { recordType, fields: fields.length, result: reason }, { workspaceId }).catch(() => undefined);
      throw err;
    };

    // Пауза детекции массового раскрытия — до решения админа
    const paused = await this.redis.get(VISIBILITY_REDIS.revealPause(userId)).catch(() => null);
    if (paused) await deny('paused', forbidden(VISIBILITY_ERROR_CODES.revealPaused, undefined, { code: VISIBILITY_ERROR_CODES.revealPaused }));

    let needsStepUp = false;
    let delegated = false;
    for (const f of fields) {
      const d = await this.visibility.decisionFor(viewer, recordType, ref, f);
      if (d.level !== 'masked' || d.reveal !== 'one') {
        await deny('not_allowed', forbidden(VISIBILITY_ERROR_CODES.revealNotAllowed, undefined, { code: VISIBILITY_ERROR_CODES.revealNotAllowed, fieldKey: f }));
      }
      const entry = visibilityFieldEntry(recordType, f)!;
      if (entry.def.class === 'restricted' || entry.def.class === 'secret') needsStepUp = true;
      if (d.why.source === 'rule' && d.why.audience && d.why.audience.kind !== 'role') delegated = true;
    }
    if (needsStepUp) {
      try {
        await this.stepUp.assert(userId, 'visibility_reveal');
      } catch (err) {
        await deny('step_up_required', err as ApiError);
      }
    }

    // Квота, журнал, уведомление, аналитика — ОДНОЙ транзакцией: откат = раскрытия не было
    const settings = workspaceId ? await this.db.workspaceVisibilitySettings.findUnique({ where: { workspaceId }, select: { notifyOnReveal: true } }) : null;
    try {
      await this.db.$transaction(async (tx) => {
        await this.entitlements.consume(tx, { type: 'user', id: userId }, 'visibility.revealsPerDay', 1);
        await this.audit.record(tx, {
          key: 'pii.reveal',
          workspaceId,
          subjectUserId: ref.subjectId,
          target: { type: recordType, id: ref.recordId },
          details: { recordType, fields, mode: 'one', delegated },
        });
        if (settings?.notifyOnReveal && ref.subjectId && ref.subjectId !== userId) {
          await this.notifications.send(tx, {
            type: 'visibility.reveal.notice',
            to: [{ userId: ref.subjectId }],
            actorId: userId,
            workspaceId,
            ref: { type: 'visibility_reveal', id: workspaceId ?? ref.subjectId },
            payload: { recordType, recordTypeLabelKey: typeTitleKey(recordType), fieldCount: fields.length },
          });
        }
        await this.analytics.track(tx, 'visibility.reveal.requested', { recordType, fields: fields.length, result: 'ok' }, { workspaceId });
      });
    } catch (err) {
      if (err instanceof ApiError && err.getStatus() === 402) this.metrics.reveals.inc({ outcome: 'quota' });
      throw err;
    }
    this.metrics.reveals.inc({ outcome: 'ok' });
    await this.detect(userId, workspaceId);

    const out: Record<string, unknown> = {};
    for (const f of fields) out[f] = normalizeValue(values[f]);
    return {
      recordType,
      recordId: ref.recordId,
      values: out,
      showUntil: new Date(Date.now() + VISIBILITY_LIMITS.revealShowSec * 1000).toISOString(),
    };
  }

  /**
   * Детекция массового раскрытия (Uber God View: контроль без самопроверки не работает).
   * Окно в Redis; порог — тревога `detect.mass_reveal` организации, пауза раскрытий человеку,
   * уведомление владельцу и админам. Сбой Redis — без детекции (раскрытие уже записано).
   */
  private async detect(userId: string, workspaceId: string | null): Promise<void> {
    try {
      const key = VISIBILITY_REDIS.revealWindow(userId);
      const client = this.redis.getClient();
      const n = await client.incr(key);
      if (n === 1) await client.expire(key, VISIBILITY_LIMITS.massRevealWindowMin * 60);
      // «≥», а не «===»: окно, пережившее сбой между INCR и EXPIRE, иначе проскочило бы порог
      // навсегда; пауза уже стоит — повторно не ставим и тревогу не дублируем
      if (n < VISIBILITY_LIMITS.massRevealThreshold) return;
      const armed = await client.set(VISIBILITY_REDIS.revealPause(userId), '1', 'EX', VISIBILITY_LIMITS.massRevealPauseMin * 60, 'NX');
      if (armed !== 'OK') return;
      await this.db.$transaction(async (tx) => {
        await this.audit.record(tx, {
          key: 'detect.mass_reveal',
          workspaceId,
          subjectUserId: userId,
          actor: { kind: 'system' },
          details: { events: n, windowMin: VISIBILITY_LIMITS.massRevealWindowMin },
        });
        if (workspaceId) {
          const admins = await this.audiences.resolve([{ type: 'workspace', id: workspaceId }], { workspaceId }, { max: 50, onOverflow: 'truncate', roles: ['owner', 'admin'] });
          const to = admins.filter((id) => id !== userId);
          if (to.length) {
            await this.notifications.send(tx, {
              type: 'visibility.reveal.paused',
              to: to.map((id) => ({ userId: id })),
              workspaceId,
              ref: { type: 'visibility_policy', id: workspaceId },
              payload: { actorId: userId },
            });
          }
        }
      });
    } catch (err) {
      this.logger.warn(`mass reveal detection failed: ${(err as Error).message}`);
    }
  }

  /** Снять паузу раскрытий человеку (решение админа — команда Кабинета / организации). */
  async liftPause(userId: string): Promise<void> {
    await this.redis.del(VISIBILITY_REDIS.revealPause(userId)).catch(() => undefined);
    await this.redis.del(VISIBILITY_REDIS.revealWindow(userId)).catch(() => undefined);
  }
}

function normalizeValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'bigint') return v.toString();
  return v;
}
