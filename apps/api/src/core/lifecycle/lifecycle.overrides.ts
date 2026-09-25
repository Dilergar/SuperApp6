import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';

type Tx = Prisma.TransactionClient;
/** Переопределения читает раннер на каждом прогоне; команда Кабинета сбрасывает кэш своего процесса. */
const TTL_MS = 60_000;

export interface LifecyclePolicyOverrideRow {
  policyId: string;
  paused: boolean;
  days: number | null;
  reason: string;
  changedById: string | null;
  changedAt: Date;
}

/**
 * Пауза и срок политики хранения, заданные командой Кабинета (`lifecycle.retention.pause` —
 * step-up, `lifecycle.retention.override` — «четыре глаза»). Строки нет — действует реестр.
 * Срок переопределения не ниже пола закона политики (проверяет команда); раннер берёт его
 * вместо умолчания реестра, пауза останавливает прогон (`stopped: paused`).
 */
@Injectable()
export class LifecycleOverrides {
  private cache: { at: number; rows: Map<string, LifecyclePolicyOverrideRow> } | null = null;

  constructor(private readonly db: DatabaseService) {}

  async all(): Promise<Map<string, LifecyclePolicyOverrideRow>> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.rows;
    const rows = await this.db.lifecyclePolicyOverride.findMany({ take: 1000 });
    const map = new Map(rows.map((r) => [r.policyId, r]));
    this.cache = { at: Date.now(), rows: map };
    return map;
  }

  async get(policyId: string): Promise<LifecyclePolicyOverrideRow | null> {
    return (await this.all()).get(policyId) ?? null;
  }

  /** Пауза: строка создаётся или обновляется; снятие паузы без срока — строка уходит. */
  async setPaused(tx: Tx, policyId: string, paused: boolean, reason: string, actorId: string): Promise<LifecyclePolicyOverrideRow | null> {
    const cur = await tx.lifecyclePolicyOverride.findUnique({ where: { policyId } });
    if (!paused && (!cur || cur.days === null)) {
      if (cur) await tx.lifecyclePolicyOverride.delete({ where: { policyId } });
      this.cache = null;
      return null;
    }
    const row = await tx.lifecyclePolicyOverride.upsert({
      where: { policyId },
      create: { policyId, paused, reason, changedById: actorId },
      update: { paused, reason, changedById: actorId, changedAt: new Date() },
    });
    this.cache = null;
    return row;
  }

  /** Срок: `null` — снять переопределение срока (пауза, если есть, остаётся). */
  async setDays(tx: Tx, policyId: string, days: number | null, reason: string, actorId: string): Promise<LifecyclePolicyOverrideRow | null> {
    const cur = await tx.lifecyclePolicyOverride.findUnique({ where: { policyId } });
    if (days === null && (!cur || !cur.paused)) {
      if (cur) await tx.lifecyclePolicyOverride.delete({ where: { policyId } });
      this.cache = null;
      return null;
    }
    const row = await tx.lifecyclePolicyOverride.upsert({
      where: { policyId },
      create: { policyId, days, reason, changedById: actorId },
      update: { days, reason, changedById: actorId, changedAt: new Date() },
    });
    this.cache = null;
    return row;
  }
}
