import { Injectable } from '@nestjs/common';
import { PLATFORM_ERROR_CODES, PLATFORM_LIMITS } from '@superapp/shared';
import { RedisService } from '../../shared/redis/redis.service';
import { tooMany } from '../../shared/errors/api-error';
import type { PlatformActor } from '../../shared/decorators/platform.decorator';
import { PlatformAuditService } from './platform-audit.service';
import { PLATFORM_REDIS } from './platform.constants';

/**
 * Потолки чтений кабинета — ОДИН бюджет на сотрудника, общий для всех дверей: поиск,
 * карточка 360, панель, карточка субъекта тарифов, предпросмотр команды. Живёт
 * отдельным сервисом именно поэтому: как только счётчик принадлежал бы одной витрине,
 * выгрузка шла бы соседней ручкой того же кабинета мимо потолка.
 *
 * Счётчик — минутное окно в Redis; Redis недоступен → считаем по журналу чтений.
 */
@Injectable()
export class PlatformRateService {
  constructor(
    private readonly redis: RedisService,
    private readonly audit: PlatformAuditService,
  ) {}

  /** Бюджет просмотров чужих данных (карточка, панель, карточка субъекта, предпросмотр). */
  async assertViewBudget(actor: PlatformActor): Promise<void> {
    await this.consume(actor, 'view', PLATFORM_LIMITS.entityViewsPerMinute);
  }

  /** Бюджет поисковых запросов. */
  async assertLookupBudget(actor: PlatformActor): Promise<void> {
    await this.consume(actor, 'lookup', PLATFORM_LIMITS.lookupPerMinute);
  }

  private async consume(actor: PlatformActor, kind: 'lookup' | 'view', perMinute: number): Promise<void> {
    const window = String(Math.floor(Date.now() / 60_000));
    try {
      const client = this.redis.getClient();
      const key = PLATFORM_REDIS.rate(kind, actor.userId, window);
      const n = await client.incr(key);
      if (n === 1) await client.expire(key, 120);
      if (n > perMinute) throw tooMany('platform.rate_limited', undefined, { code: PLATFORM_ERROR_CODES.rateLimited, resendInSec: 60 });
    } catch (err) {
      if ((err as { status?: number }).status === 429) throw err;
      /* Redis недоступен — лимит по журналу чтений (best-effort) */
      const n = await this.audit.accessCount(actor.userId, kind === 'lookup' ? 'search' : 'view', 60_000);
      if (n > perMinute) throw tooMany('platform.rate_limited', undefined, { code: PLATFORM_ERROR_CODES.rateLimited, resendInSec: 60 });
    }
  }
}
