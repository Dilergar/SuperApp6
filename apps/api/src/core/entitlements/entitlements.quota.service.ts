import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ENTITLEMENT_REGISTRY, type EntitlementKey, type EntitlementPeriod, type EntitlementSubjectRef, uuidv7 } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { utcTs } from '../../shared/database/sql-time';

type Tx = Prisma.TransactionClient;

export interface QuotaState {
  used: number;
  periodStart: Date | null;
  periodEnd: Date | null;
}

export interface ConsumeResult {
  ok: boolean;
  used: number;
  previousUsed: number;
  limit: number | null;
  periodEnd: Date | null;
}

/**
 * Счётчики расходуемых квот. Правила S14:
 * - `delta` только серверная (клиент её не передаёт никогда);
 * - `consume` = INSERT … ON CONFLICT DO NOTHING + условный UPDATE в ОДНОЙ транзакции
 *   вызывающего, fail-closed (нет строки после insert → отказ);
 * - лимит — параметром из резолвера; ленивый сброс периода тем же UPDATE;
 * - `release` = GREATEST(used − delta, 0) — в минус не уходим.
 * Период считается по UTC (сутки/месяц) — детерминированно и одинаково на всех инстансах.
 */
@Injectable()
export class EntitlementsQuotaService {
  constructor(private readonly db: DatabaseService) {}

  /** Окно периода [start, end) по UTC; без периода — обе границы null. */
  periodWindow(period: EntitlementPeriod | undefined, now: Date): { start: Date | null; end: Date | null } {
    if (!period) return { start: null, end: null };
    if (period === 'day') {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return { start, end: new Date(start.getTime() + 86_400_000) };
    }
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { start, end };
  }

  /**
   * Списать `delta` под потолком `limit` (null = без ограничения). Возвращает `ok=false`
   * при отказе — вызывающий бросает 402 со своими деталями (ключ, значение, unlock).
   */
  async consume(tx: Tx, subject: EntitlementSubjectRef, key: EntitlementKey, delta: number, limit: number | null): Promise<ConsumeResult> {
    if (!Number.isFinite(delta) || delta < 0) throw new Error(`entitlements: bad delta ${delta}`);
    const now = new Date();
    const { start, end } = this.periodWindow(ENTITLEMENT_REGISTRY[key].period, now);
    const nowTs = utcTs(now);
    const startTs = start ? utcTs(start) : Prisma.sql`NULL`;
    const endTs = end ? utcTs(end) : Prisma.sql`NULL`;

    await tx.$executeRaw`
      INSERT INTO quota_counters (id, subject_type, subject_id, key, used, period_start, period_end, updated_at)
      VALUES (${uuidv7()}::uuid, ${subject.type}, ${subject.id}, ${key}, 0, ${startTs}, ${endTs}, ${nowTs})
      ON CONFLICT (subject_type, subject_id, key) DO NOTHING
    `;

    // Текущее «до» — для порогов уведомлений (та же транзакция, строка уже есть)
    const before = await tx.$queryRaw<{ used: bigint; period_end: Date | null }[]>`
      SELECT used, period_end FROM quota_counters
      WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND key = ${key}
      FOR UPDATE
    `;
    const row = before[0];
    if (!row) return { ok: false, used: 0, previousUsed: 0, limit, periodEnd: end }; // fail-closed
    const stale = row.period_end !== null && row.period_end.getTime() <= now.getTime();
    const previousUsed = stale ? 0 : Number(row.used);

    const limitSql = limit === null ? Prisma.sql`NULL::bigint` : Prisma.sql`${BigInt(Math.floor(limit))}::bigint`;
    const updated = await tx.$queryRaw<{ used: bigint }[]>`
      UPDATE quota_counters SET
        used = (CASE WHEN period_end IS NOT NULL AND period_end <= ${nowTs} THEN 0 ELSE used END) + ${BigInt(Math.floor(delta))}::bigint,
        period_start = CASE WHEN period_end IS NOT NULL AND period_end <= ${nowTs} THEN ${startTs} ELSE period_start END,
        period_end = CASE WHEN period_end IS NOT NULL AND period_end <= ${nowTs} THEN ${endTs} ELSE period_end END,
        updated_at = ${nowTs}
      WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND key = ${key}
        AND (${limitSql} IS NULL
             OR (CASE WHEN period_end IS NOT NULL AND period_end <= ${nowTs} THEN 0 ELSE used END) + ${BigInt(Math.floor(delta))}::bigint <= ${limitSql})
      RETURNING used
    `;
    if (!updated.length) return { ok: false, used: previousUsed, previousUsed, limit, periodEnd: end };
    return { ok: true, used: Number(updated[0].used), previousUsed, limit, periodEnd: end };
  }

  /** Вернуть `delta` (удаление файла). Строки нет — нечего возвращать. */
  async release(tx: Tx, subject: EntitlementSubjectRef, key: EntitlementKey, delta: number): Promise<void> {
    if (!Number.isFinite(delta) || delta <= 0) return;
    await tx.$executeRaw`
      UPDATE quota_counters SET used = GREATEST(used - ${BigInt(Math.floor(delta))}::bigint, 0), updated_at = ${utcTs(new Date())}
      WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND key = ${key}
    `;
  }

  /** Все счётчики субъекта с учётом протухшего периода (used=0, если период истёк). */
  async peekAll(subject: EntitlementSubjectRef, tx: Tx | DatabaseService = this.db): Promise<Map<string, QuotaState>> {
    const rows = await tx.quotaCounter.findMany({ where: { subjectType: subject.type, subjectId: subject.id } });
    const now = Date.now();
    const out = new Map<string, QuotaState>();
    for (const r of rows) {
      const stale = r.periodEnd !== null && r.periodEnd.getTime() <= now;
      const def = ENTITLEMENT_REGISTRY[r.key as EntitlementKey];
      const window = stale && def?.period ? this.periodWindow(def.period, new Date()) : null;
      out.set(r.key, {
        used: stale ? 0 : Number(r.used),
        periodStart: window ? window.start : r.periodStart,
        periodEnd: window ? window.end : r.periodEnd,
      });
    }
    return out;
  }

  async peek(subject: EntitlementSubjectRef, key: EntitlementKey, tx?: Tx): Promise<QuotaState | null> {
    return (await this.peekAll(subject, tx)).get(key) ?? null;
  }

  /**
   * Сверка: выставить фактическое значение (крон владельца данных).
   *
   * Окно периода ставится и здесь: строка, созданная сверкой БЕЗ `period_end`, уже
   * никогда не сбросилась бы лениво (и `consume`, и `peekAll` смотрят ровно на
   * `period_end`) — периодическая квота осталась бы исчерпанной навсегда. У ключа
   * без периода обе границы остаются NULL («навсегда», байты Диска).
   */
  async set(subject: EntitlementSubjectRef, key: EntitlementKey, used: number, tx: Tx | DatabaseService = this.db): Promise<void> {
    const value = BigInt(Math.max(0, Math.floor(used)));
    const { start, end } = this.periodWindow(ENTITLEMENT_REGISTRY[key].period, new Date());
    await tx.quotaCounter.upsert({
      where: { subjectType_subjectId_key: { subjectType: subject.type, subjectId: subject.id, key } },
      create: { subjectType: subject.type, subjectId: subject.id, key, used: value, periodStart: start, periodEnd: end },
      // Сверка знает факт ТЕКУЩЕГО периода — окно переставляем на него; у ключа без
      // периода границы не трогаем (они NULL и должны такими остаться).
      update: end ? { used: value, periodStart: start, periodEnd: end } : { used: value },
    });
  }

  /** Субъекты, у которых есть счётчик ключа (для сверки «владельцы без файлов → ноль»). */
  async subjectsWithCounter(key: EntitlementKey): Promise<EntitlementSubjectRef[]> {
    const rows = await this.db.quotaCounter.findMany({ where: { key, used: { gt: 0 } }, select: { subjectType: true, subjectId: true } });
    return rows.map((r) => ({ type: r.subjectType as EntitlementSubjectRef['type'], id: r.subjectId }));
  }

  async forget(tx: Tx, subject: EntitlementSubjectRef): Promise<void> {
    await tx.quotaCounter.deleteMany({ where: { subjectType: subject.type, subjectId: subject.id } });
  }
}
