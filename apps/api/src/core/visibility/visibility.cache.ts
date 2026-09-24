import { Injectable, Logger } from '@nestjs/common';
import { VISIBILITY_LIMITS, VISIBILITY_REDIS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { WorkspaceContextService } from '../../shared/context/workspace-context.service';
import { EMPTY_POLICY, compileRules, type CompiledPolicy } from './visibility.plan';
import { VisibilityMetrics } from './visibility.metrics';

const RULE_SELECT = {
  id: true,
  fieldKey: true,
  groupKey: true,
  sectionKey: true,
  audienceKind: true,
  audienceId: true,
  effect: true,
  level: true,
  mask: true,
  reveal: true,
  stage: true,
} as const;

/** Маленький LRU с TTL (≤ 30 с) — для фактов о зрителе, ключ которых несёт эпоху прав. */
export class TtlLru<V> {
  private readonly map = new Map<string, { v: V; at: number }>();
  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }
  set(key: string, v: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { v, at: Date.now() });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  clear(): void {
    this.map.clear();
  }
}

/**
 * Кэш опубликованных политик. Кэшируется ГРАФ + ВЕРСИЯ, не решения (урок TAO): правила
 * владельца по типу лежат в Redis (L2, TTL `policyL2TtlSec`) с версией `pv`; публикация стирает ключ
 * ПОСЛЕ коммита, поэтому следующий запрос любого процесса видит новую версию (кросс-
 * процессного L1 у политик нет намеренно — он пережил бы отзыв на всех, кроме публикующего).
 * В пределах запроса — мемо (одна политика читается один раз). Промах — синхронно из БД;
 * сбой Redis — БД; сбой БД — исключение (вызывающий сработает fail-closed).
 */
@Injectable()
export class VisibilityCache {
  private readonly logger = new Logger(VisibilityCache.name);
  private readonly memo = new WeakMap<object, Map<string, CompiledPolicy>>();

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly ctx: WorkspaceContextService,
    private readonly metrics: VisibilityMetrics,
  ) {}

  private memoFor(): Map<string, CompiledPolicy> | null {
    const store = this.ctx.get();
    if (!store) return null;
    let m = this.memo.get(store);
    if (!m) {
      m = new Map();
      this.memo.set(store, m);
    }
    return m;
  }

  /** Опубликованная политика одного владельца по типу. */
  async policy(ownerKind: 'workspace' | 'user', ownerId: string, recordType: string): Promise<CompiledPolicy> {
    return (await this.policies(ownerKind, [ownerId], recordType)).get(ownerId) ?? EMPTY_POLICY;
  }

  /** Пакетно: политики многих владельцев (ростер — личные политики сотен людей) — один MGET + один SELECT промахов. */
  async policies(ownerKind: 'workspace' | 'user', ownerIds: readonly string[], recordType: string): Promise<Map<string, CompiledPolicy>> {
    const out = new Map<string, CompiledPolicy>();
    const memo = this.memoFor();
    const need: string[] = [];
    for (const id of new Set(ownerIds)) {
      const hit = memo?.get(`${ownerKind}:${id}:${recordType}`);
      if (hit) out.set(id, hit);
      else need.push(id);
    }
    if (!need.length) return out;

    const keys = need.map((id) => VISIBILITY_REDIS.policy(ownerKind, id, recordType));
    let cached: (string | null)[] = [];
    try {
      cached = await this.redis.getClient().mget(...keys);
    } catch (err) {
      this.logger.warn(`visibility policy cache read failed: ${(err as Error).message}`);
      cached = need.map(() => null);
    }
    const misses: string[] = [];
    need.forEach((id, i) => {
      const raw = cached[i];
      if (raw) {
        try {
          const p = JSON.parse(raw) as CompiledPolicy;
          out.set(id, p);
          memo?.set(`${ownerKind}:${id}:${recordType}`, p);
          this.metrics.policyCache.inc({ hit: 'true' });
          return;
        } catch {
          /* битая запись — перечитать */
        }
      }
      misses.push(id);
    });
    if (!misses.length) return out;
    this.metrics.policyCache.inc({ hit: 'false' }, misses.length);

    const rows = await this.db.visibilityPolicy.findMany({
      where: { ownerType: ownerKind, ownerId: { in: misses }, recordType, status: 'published' },
      // Порядок строк — часть семантики: при равной специфичности побеждает первое правило
      select: { ownerId: true, version: true, rules: { select: RULE_SELECT, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] } },
    });
    const byOwner = new Map(rows.map((r) => [r.ownerId, r]));
    const pipe = this.redis.getClient().pipeline();
    for (const id of misses) {
      const row = byOwner.get(id);
      const p: CompiledPolicy = row ? { pv: row.version, rules: compileRules(recordType, row.rules) } : { pv: 0, rules: [] };
      out.set(id, p);
      memo?.set(`${ownerKind}:${id}:${recordType}`, p);
      pipe.set(VISIBILITY_REDIS.policy(ownerKind, id, recordType), JSON.stringify(p), 'EX', VISIBILITY_LIMITS.policyL2TtlSec);
    }
    await pipe.exec().catch((err: Error) => this.logger.warn(`visibility policy cache write failed: ${err.message}`));
    return out;
  }

  /** Стереть кэш политики владельца (ПОСЛЕ коммита публикации/правки) — во всех процессах разом. */
  async invalidate(ownerKind: 'workspace' | 'user', ownerId: string, recordTypes: readonly string[]): Promise<void> {
    const memo = this.memoFor();
    for (const t of recordTypes) memo?.delete(`${ownerKind}:${ownerId}:${t}`);
    try {
      if (recordTypes.length) await this.redis.getClient().del(...recordTypes.map((t) => VISIBILITY_REDIS.policy(ownerKind, ownerId, t)));
    } catch (err) {
      // Не стёрли — ключ доживёт TTL (`policyL2TtlSec`). Логируем громко: это окно устаревшей политики
      this.logger.error(`visibility policy cache invalidation failed (${ownerKind}:${ownerId}): ${(err as Error).message}`);
    }
  }
}
