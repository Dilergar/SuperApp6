import { Injectable } from '@nestjs/common';
import { KEYS_ERROR_CODES, KEYS_LIMITS, KEYS_REDIS, type KeysStepUpStatusDto } from '@superapp/shared';
import { DatabaseService } from '../../../shared/database/database.service';
import { forbidden } from '../../../shared/errors/api-error';
import { RedisService } from '../../../shared/redis/redis.service';
import { VerifyService } from '../../verify/verify.service';
import { AuditService } from '../../audit/audit.service';

/**
 * «Сильное подтверждение» для управления ключами (решение грилла №8): пароль + SMS-код
 * (`core/verify`, цель `keys_manage`) → окно 15 минут в Redis. ЕДИНСТВЕННАЯ точка,
 * куда позже встанут passkeys/ЭЦП: потребители зовут только `assert(userId)`.
 */
@Injectable()
export class KeysStepUpService {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly verify: VerifyService,
    private readonly audit: AuditService,
  ) {}

  async status(userId: string): Promise<KeysStepUpStatusDto> {
    try {
      const raw = await this.redis.get(KEYS_REDIS.stepUp(userId));
      const until = raw ? Number(raw) : 0;
      return { until: until > Date.now() ? new Date(until).toISOString() : null };
    } catch {
      return { until: null };
    }
  }

  /** Окно открыто? Иначе 403 `keys.step_up_required` — клиент ведёт в шаг пароль → код. */
  async assert(userId: string): Promise<void> {
    const { until } = await this.status(userId);
    if (!until) throw forbidden('keys.step_up_required', undefined, { code: KEYS_ERROR_CODES.stepUpRequired });
  }

  /** Гашение пропуска `keys_manage` (в транзакции — откат не тратит пропуск) → окно. */
  async confirm(userId: string, verifyToken: string): Promise<KeysStepUpStatusDto> {
    await this.db.$transaction(async (tx) => {
      const consumed = await this.verify.consume(tx, { verifyToken, purpose: 'keys_manage', expectedUserId: userId });
      // Подтверждение личности — событие журнала безопасности той же транзакцией
      await this.audit.record(tx, { key: 'auth.step_up.success', subjectUserId: userId, details: { purpose: 'keys_manage' }, evidence: { factor: 'password+sms', verifyChallengeId: consumed.challengeId } });
    });
    const until = Date.now() + KEYS_LIMITS.stepUpMinutes * 60_000;
    await this.redis.set(KEYS_REDIS.stepUp(userId), String(until), KEYS_LIMITS.stepUpMinutes * 60);
    return { until: new Date(until).toISOString() };
  }

  /** Закрыть окно досрочно (кнопка «Завершить» в UI; смена пароля и logout-all зовут то же). */
  async end(userId: string): Promise<void> {
    try {
      await this.redis.del(KEYS_REDIS.stepUp(userId));
    } catch {
      /* best-effort: окно и так истечёт */
    }
  }
}
