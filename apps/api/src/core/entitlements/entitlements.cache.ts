import { Injectable, Logger } from '@nestjs/common';
import type { EntitlementSubjectRef, EntitlementSubjectType } from '@superapp/shared';
import { RedisService } from '../../shared/redis/redis.service';
import { DryRun } from '../../shared/context/dry-run.context';
import { WorkspaceContextService } from '../../shared/context/workspace-context.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { ENTITLEMENT_BUS_EVENTS, ENTITLEMENT_REDIS, ENTITLEMENT_SNAPSHOT_TTL_SEC } from './entitlements.constants';
import type { ResolvedValue } from './entitlements.resolver';

/** Снимок субъекта, как он лежит в кэше (даты — ISO-строки: JSON). */
export interface RawSnapshot {
  subjectType: EntitlementSubjectType;
  subjectId: string;
  values: Record<string, ResolvedValueWire>;
  subscription: RawSubscription | null;
  /** Недавно (≤ 30 дней) закончившаяся подписка — для чипа «тариф истёк» при отсутствии живой */
  recentlyEnded: RawRecentlyEnded | null;
  expiresAt: string | null;
  computedAt: string;
}

export interface RawRecentlyEnded {
  planKey: string;
  planLabelKey: string;
  status: string;
  endedAt: string;
}

export interface ResolvedValueWire {
  value: ResolvedValue['value'];
  source: ResolvedValue['source'];
  sourceKind: ResolvedValue['sourceKind'];
  sourceUntil: string | null;
}

export interface RawSubscription {
  id: string;
  planKey: string;
  planLabelKey: string;
  version: number;
  status: string;
  startedAt: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
  expiresAt: string | null;
}

/**
 * Кэш снимков: Redis по ключу с ДВУМЯ эпохами (каталога и субъекта) + мемо на запрос
 * в ALS. Образец — `bumpEpochs`/`bumpLater` core/access: бамп в транзакции ДО коммита
 * плюс повторный через 2 с закрывает окно, в котором сосед успел бы закэшировать
 * докоммитное состояние. Redis недоступен → честный пересчёт из БД.
 */
@Injectable()
export class EntitlementsCache {
  private readonly logger = new Logger(EntitlementsCache.name);
  /** Мемо на запрос: объект ALS-контекста → subjectKey → снимок */
  private readonly memo = new WeakMap<object, Map<string, Promise<RawSnapshot>>>();

  constructor(
    private readonly redis: RedisService,
    private readonly wsContext: WorkspaceContextService,
    private readonly events: EventBusService,
  ) {}

  private subjectKey(s: EntitlementSubjectRef): string {
    return `${s.type}:${s.id}`;
  }

  /** Имя субъекта в картах пакетного чтения (`getManyOrCompute`). */
  keyOf(s: EntitlementSubjectRef): string {
    return this.subjectKey(s);
  }

  async getOrCompute(subject: EntitlementSubjectRef, compute: () => Promise<RawSnapshot>): Promise<RawSnapshot> {
    const store = this.wsContext.get();
    if (store) {
      let map = this.memo.get(store);
      if (!map) this.memo.set(store, (map = new Map()));
      const hit = map.get(this.subjectKey(subject));
      if (hit) return hit;
      const key = this.subjectKey(subject);
      const p = this.fromRedisOrCompute(subject, compute);
      map.set(key, p);
      // Отказ не мемоизируем: один блип БД не должен «залипнуть» на весь запрос —
      // следующий читатель обязан попробовать снова, а не получить ту же ошибку.
      p.catch(() => map.delete(key));
      return p;
    }
    return this.fromRedisOrCompute(subject, compute);
  }

  /**
   * Снимки ПАЧКИ субъектов: один `mget` эпох, один `mget` снимков и ОДИН пакетный
   * компьют на все промахи. Так косметика на карточках людей (`personKeysFor`)
   * стоит двух команд Redis вместо двух на человека, а на холодном кэше — четырёх
   * запросов в БД вместо четырёх на человека.
   */
  async getManyOrCompute(
    subjects: EntitlementSubjectRef[],
    computeMissing: (missing: EntitlementSubjectRef[]) => Promise<Map<string, RawSnapshot>>,
  ): Promise<Map<string, RawSnapshot>> {
    const out = new Map<string, RawSnapshot>();
    const unique = new Map<string, EntitlementSubjectRef>();
    for (const s of subjects) unique.set(this.subjectKey(s), s);
    if (!unique.size) return out;

    const store = this.wsContext.get();
    let memo: Map<string, Promise<RawSnapshot>> | null = null;
    if (store) {
      memo = this.memo.get(store) ?? null;
      if (!memo) this.memo.set(store, (memo = new Map()));
    }

    // 1) мемо ЭТОГО запроса (три места подряд просят одних и тех же людей)
    const pending: EntitlementSubjectRef[] = [];
    for (const [key, subject] of unique) {
      const hit = memo?.get(key);
      if (hit) {
        out.set(key, await hit);
        continue;
      }
      pending.push(subject);
    }

    // 2) Redis пачкой; недоступен или промах — в компьют
    const redisKeys = new Map<string, string>();
    let missing = pending;
    if (pending.length) {
      try {
        const client = this.redis.getClient();
        const epochs = await client.mget(
          ENTITLEMENT_REDIS.catalogEpoch,
          ...pending.map((s) => ENTITLEMENT_REDIS.subjectEpoch(s.type, s.id)),
        );
        const cat = epochs[0] ?? '0';
        pending.forEach((s, i) => redisKeys.set(this.subjectKey(s), ENTITLEMENT_REDIS.snapshot(cat, s.type, s.id, epochs[i + 1] ?? '0')));
        const cached = await client.mget(...pending.map((s) => redisKeys.get(this.subjectKey(s)) as string));
        const stillMissing: EntitlementSubjectRef[] = [];
        pending.forEach((s, i) => {
          const key = this.subjectKey(s);
          const raw = cached[i];
          const parsed = raw ? this.parse(raw) : null;
          if (!parsed) {
            stillMissing.push(s);
            return;
          }
          out.set(key, parsed);
          memo?.set(key, Promise.resolve(parsed));
        });
        missing = stillMissing;
      } catch (err) {
        this.logger.debug(`batch cache read skipped: ${(err as Error).message}`);
        missing = pending;
      }
    }

    // 3) промахи — одним пакетом, результат в мемо и в Redis
    if (missing.length) {
      const computed = await computeMissing(missing);
      const writes: [string, RawSnapshot][] = [];
      for (const s of missing) {
        const key = this.subjectKey(s);
        const snap = computed.get(key);
        if (!snap) continue;
        out.set(key, snap);
        memo?.set(key, Promise.resolve(snap));
        const redisKey = redisKeys.get(key);
        if (redisKey) writes.push([redisKey, snap]);
      }
      if (writes.length) await this.writeMany(writes);
    }
    return out;
  }

  /** Снимок из Redis: просроченный по своим срокам не отдаём (TTL мог быть старше сдвига дат). */
  private parse(raw: string): RawSnapshot | null {
    try {
      const parsed = JSON.parse(raw) as RawSnapshot;
      if (!parsed.expiresAt || new Date(parsed.expiresAt).getTime() > Date.now()) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  private async writeMany(entries: [string, RawSnapshot][]): Promise<void> {
    try {
      const client = this.redis.getClient();
      const pipeline = client.pipeline();
      for (const [key, snap] of entries) {
        const ttl = this.ttlFor(snap);
        if (ttl > 0) pipeline.set(key, JSON.stringify(snap), 'EX', ttl);
      }
      await pipeline.exec();
    } catch (err) {
      this.logger.debug(`batch cache write skipped: ${(err as Error).message}`);
    }
  }

  /** Сбросить мемо текущего запроса (после мутации в этом же запросе снимок обязан пересчитаться). */
  forgetInRequest(subject: EntitlementSubjectRef): void {
    const store = this.wsContext.get();
    if (!store) return;
    this.memo.get(store)?.delete(this.subjectKey(subject));
  }

  private async fromRedisOrCompute(subject: EntitlementSubjectRef, compute: () => Promise<RawSnapshot>): Promise<RawSnapshot> {
    let key: string | null = null;
    try {
      const client = this.redis.getClient();
      const [cat, ep] = await client.mget(ENTITLEMENT_REDIS.catalogEpoch, ENTITLEMENT_REDIS.subjectEpoch(subject.type, subject.id));
      key = ENTITLEMENT_REDIS.snapshot(cat ?? '0', subject.type, subject.id, ep ?? '0');
      const cached = await client.get(key);
      const parsed = cached ? this.parse(cached) : null;
      if (parsed) return parsed;
    } catch (err) {
      this.logger.debug(`cache read skipped: ${(err as Error).message}`);
    }
    const snap = await compute();
    if (key) {
      try {
        const ttl = this.ttlFor(snap);
        if (ttl > 0) await this.redis.getClient().set(key, JSON.stringify(snap), 'EX', ttl);
      } catch (err) {
        this.logger.debug(`cache write skipped: ${(err as Error).message}`);
      }
    }
    return snap;
  }

  private ttlFor(snap: RawSnapshot): number {
    if (!snap.expiresAt) return ENTITLEMENT_SNAPSHOT_TTL_SEC;
    const left = Math.floor((new Date(snap.expiresAt).getTime() - Date.now()) / 1000);
    return Math.max(0, Math.min(ENTITLEMENT_SNAPSHOT_TTL_SEC, left));
  }

  /**
   * Бамп эпохи субъекта (в транзакции мутации) + отложенный повтор после коммита + сигнал шине.
   *
   * В предпросмотре команды кабинета не делает НИЧЕГО в Redis и на шине: транзакция
   * там откатывается, а INCR и событие «тариф изменился» не откатились бы — членам
   * организации прилетал бы сокет о несостоявшемся изменении. Мемо запроса всё равно
   * сбрасываем: внутри той же транзакции резолвер обязан увидеть черновое состояние.
   */
  async bump(subject: EntitlementSubjectRef): Promise<void> {
    this.forgetInRequest(subject);
    if (DryRun.active()) return;
    await this.incr(ENTITLEMENT_REDIS.subjectEpoch(subject.type, subject.id));
    this.bumpLater(subject);
  }

  /** Эпоха каталога — общая на всю платформу: в предпросмотре её не трогаем (иначе холодный кэш у всех). */
  async bumpCatalog(): Promise<void> {
    if (DryRun.active()) return;
    await this.incr(ENTITLEMENT_REDIS.catalogEpoch);
    const timer = setTimeout(() => void this.incr(ENTITLEMENT_REDIS.catalogEpoch), 2000);
    timer.unref?.();
  }

  /** Текущая эпоха каталога (для in-memory кэша опубликованных значений планов). */
  async catalogEpoch(): Promise<string> {
    try {
      return (await this.redis.get(ENTITLEMENT_REDIS.catalogEpoch)) ?? '0';
    } catch {
      return String(Date.now()); // Redis недоступен → кэш каталога в памяти не переиспользуется
    }
  }

  private bumpLater(subject: EntitlementSubjectRef): void {
    const timer = setTimeout(() => {
      void this.incr(ENTITLEMENT_REDIS.subjectEpoch(subject.type, subject.id));
      this.events.emit(ENTITLEMENT_BUS_EVENTS.changed, { subjectType: subject.type, subjectId: subject.id }, 'entitlements');
    }, 2000);
    timer.unref?.();
  }

  private async incr(key: string): Promise<void> {
    try {
      await this.redis.getClient().incr(key);
    } catch (err) {
      this.logger.warn(`epoch bump failed (${key}): ${(err as Error).message}`);
    }
  }
}
