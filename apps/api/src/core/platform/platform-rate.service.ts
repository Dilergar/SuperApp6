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
 * Счётчик — минутное окно в Redis (семейство `platform:rate:*` реестра хранилищ);
 * Redis недоступен → считаем по журналу чтений.
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

  /**
   * Бюджет запросов панели движка со СВОИМ потолком: дашборд аналитики — пачка запросов
   * за раз, общий потолок просмотров он выбирал бы сразу. Redis недоступен → без потолка:
   * ответ панели — k-анонимный агрегат, а не чужая запись (у просмотров и поиска запасной
   * счёт — журнал чтений).
   */
  async assertPanelBudget(actor: PlatformActor, panel: string, perMinute: number): Promise<void> {
    let n: number;
    try {
      n = await this.bump(`panel.${panel}`, actor.userId);
    } catch {
      return;
    }
    if (n > perMinute) throw tooMany('platform.rate_limited', undefined, { code: PLATFORM_ERROR_CODES.rateLimited, resendInSec: 60 });
  }

  private async consume(actor: PlatformActor, kind: 'lookup' | 'view', perMinute: number): Promise<void> {
    let n: number;
    try {
      n = await this.bump(kind, actor.userId);
    } catch {
      /* Redis недоступен — лимит по журналу чтений (best-effort) */
      n = await this.audit.accessCount(actor.userId, kind === 'lookup' ? 'search' : 'view', 60_000);
    }
    if (n > perMinute) throw tooMany('platform.rate_limited', undefined, { code: PLATFORM_ERROR_CODES.rateLimited, resendInSec: 60 });
  }

  /** +1 в минутном окне. Одним MULTI: сбой между INCR и EXPIRE оставил бы счётчик без срока навсегда. */
  private async bump(kind: string, userId: string): Promise<number> {
    const key = PLATFORM_REDIS.rate(kind, userId, String(Math.floor(Date.now() / 60_000)));
    const res = await this.redis.getClient().multi().incr(key).expire(key, 120, 'NX').exec();
    const [err, n] = res?.[0] ?? [new Error('Redis MULTI aborted'), 0];
    if (err) throw err;
    return Number(n);
  }
}
