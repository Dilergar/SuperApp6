import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { EntitlementKey, EntitlementSubjectRef } from '@superapp/shared';

type Tx = Prisma.TransactionClient;

/**
 * Провайдер РАСХОДА для ключа-лимита: сколько живых сущностей у субъекта сейчас.
 * Регистрирует ВЛАДЕЛЕЦ данных (organizations → члены, circles → группы). Движок
 * зовёт его В ТРАНЗАКЦИИ создания под advisory-локом (`assertCanCreate`), поэтому
 * COUNT обязан уметь читать через `tx`.
 */
export interface UsageProvider {
  count(subject: EntitlementSubjectRef, tx?: Tx): Promise<number>;
}

/**
 * Ночная сверка расходуемой квоты с фактом (drift-фикс): владелец данных пересчитывает
 * счётчики всех своих субъектов и пишет их через `EntitlementsQuotaService.set`.
 * Возвращает число пересчитанных субъектов (для лога).
 */
export interface QuotaReconcileProvider {
  reconcile(): Promise<number>;
}

@Injectable()
export class UsageProviderRegistry {
  private readonly logger = new Logger(UsageProviderRegistry.name);
  private readonly providers = new Map<string, UsageProvider>();

  register(key: EntitlementKey, provider: UsageProvider): void {
    if (this.providers.has(key)) this.logger.warn(`usage provider for "${key}" already registered; overwriting`);
    this.providers.set(key, provider);
  }

  get(key: string): UsageProvider | undefined {
    return this.providers.get(key);
  }
}

@Injectable()
export class QuotaReconcileRegistry {
  private readonly logger = new Logger(QuotaReconcileRegistry.name);
  private readonly providers = new Map<string, QuotaReconcileProvider>();

  register(key: EntitlementKey, provider: QuotaReconcileProvider): void {
    if (this.providers.has(key)) this.logger.warn(`quota reconcile for "${key}" already registered; overwriting`);
    this.providers.set(key, provider);
  }

  entries(): [string, QuotaReconcileProvider][] {
    return [...this.providers.entries()];
  }
}
