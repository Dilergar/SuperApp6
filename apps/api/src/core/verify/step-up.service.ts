import { Injectable } from '@nestjs/common';
import {
  STEP_UP_REQUIRED_CODES,
  STEP_UP_WINDOW_MINUTES,
  STEP_UP_WINDOW_PURPOSES,
  stepUpWindowKey,
  type StepUpWindowPurpose,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { forbidden } from '../../shared/errors/api-error';
import { RedisService } from '../../shared/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { VerifyService } from './verify.service';

/**
 * «Сильное подтверждение» С ОКНОМ: пароль + SMS-код (`/verify/step-up` → `/verify/check`) →
 * окно N минут в Redis на ЦЕЛЬ (окно ключей не открывает чужие ИИН, и наоборот).
 * ЕДИНСТВЕННАЯ точка, куда позже встанут passkeys/ЭЦП: потребители зовут только
 * `assert(userId, purpose)`. Первый потребитель — управление ключами (`keys_manage`),
 * дальше — раскрытие строгих полей и правила видимости (`visibility_reveal|manage`).
 */
@Injectable()
export class StepUpService {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly verify: VerifyService,
    private readonly audit: AuditService,
  ) {}

  async status(userId: string, purpose: StepUpWindowPurpose): Promise<{ until: string | null }> {
    try {
      const raw = await this.redis.get(stepUpWindowKey(purpose, userId));
      const until = raw ? Number(raw) : 0;
      return { until: until > Date.now() ? new Date(until).toISOString() : null };
    } catch {
      return { until: null };
    }
  }

  /** Окно открыто? Иначе 403 с кодом цели (`keys.step_up_required` / `visibility.step_up_required`). */
  async assert(userId: string, purpose: StepUpWindowPurpose): Promise<void> {
    const { until } = await this.status(userId, purpose);
    if (!until) {
      const code = STEP_UP_REQUIRED_CODES[purpose];
      throw forbidden(code, undefined, { code, purpose });
    }
  }

  /** Гашение пропуска цели (в транзакции — откат не тратит пропуск) → окно; событие журнала той же транзакцией. */
  async confirm(userId: string, purpose: StepUpWindowPurpose, verifyToken: string): Promise<{ until: string }> {
    await this.db.$transaction(async (tx) => {
      const consumed = await this.verify.consume(tx, { verifyToken, purpose, expectedUserId: userId });
      await this.audit.record(tx, {
        key: 'auth.step_up.success',
        subjectUserId: userId,
        details: { purpose },
        evidence: { factor: 'password+sms', verifyChallengeId: consumed.challengeId },
      });
    });
    const minutes = STEP_UP_WINDOW_MINUTES[purpose];
    const until = Date.now() + minutes * 60_000;
    await this.redis.set(stepUpWindowKey(purpose, userId), String(until), minutes * 60);
    return { until: new Date(until).toISOString() };
  }

  /** Закрыть окно досрочно; без цели — все окна человека (смена пароля, «выйти везде», «Это не я»). */
  async end(userId: string, purpose?: StepUpWindowPurpose): Promise<void> {
    const purposes = purpose ? [purpose] : STEP_UP_WINDOW_PURPOSES;
    try {
      await this.redis.getClient().del(...purposes.map((p) => stepUpWindowKey(p, userId)));
    } catch {
      /* best-effort: окно и так истечёт */
    }
  }
}
