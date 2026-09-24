import { Injectable, Logger } from '@nestjs/common';
import type { LifecyclePolicy } from '@superapp/shared';
import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** Что раннер даёт шагу purge модуля (одна пачка за вызов). */
export interface LifecyclePurgeBatchContext {
  policy: LifecyclePolicy;
  runId: string;
  /** Строка к удалению старше этого момента (срок политики); `null` — окно решает сам модуль (корзина 30 дней) */
  cutoff: Date | null;
  /** Размер пачки (AIMD раннера: растёт, пока пачка укладывается в цель по времени) */
  limit: number;
  /**
   * Курсор keyset шага (`encodeCursor` из @superapp/shared) — раннер хранит его между пачками
   * и заходами. Строки под заморозкой в голове очереди иначе выбирались бы каждой пачкой
   * снова, и прогон стоял бы на месте. `null` — с начала.
   */
  cursor: string | null;
  /** Прогон подтверждён человеком сверх порога «подозрительно много» (см. `LifecycleBlastRadiusError`) */
  force: boolean;
  /**
   * Отфильтровать удерживаемое В ТРАНЗАКЦИИ удаления: берёт общий замок заморозок (новая
   * заморозка ждёт коммита пачки) и возвращает id строк политики без действующей заморозки.
   * Шаг модуля зовёт его перед удалением в той же транзакции — TOCTOU закрыт так же, как у
   * общей пачки раннера (`NOT EXISTS` в самом DELETE).
   */
  releasable(tx: Tx, ids: readonly string[]): Promise<string[]>;
}

/**
 * Свой шаг purge модуля-владельца (`batched_delete.handler` реестра) — когда общей пачки
 * мало: удаление с эффектами (эскроу, файлы, права, чаты — корзины), байты вне базы
 * (файлы, временный каталог загрузок), срок из настроек организации.
 *
 * Контракт: ОДНА пачка ≤ `limit` строк за вызов, идемпотентно (прерванный прогон повторит
 * пачку), удерживаемое не трогать (`releasable`), права не проверять (решение принял
 * реестр). `more: false` — к удалению больше ничего.
 */
export interface LifecyclePurgeHandler {
  purgeBatch(ctx: LifecyclePurgeBatchContext): Promise<{ rows: number; more: boolean; cursor?: string | null }>;
  /** Сколько строк к удалению сейчас (dry-run, ожидание для кэпа радиуса); не умеет — `null` */
  estimate?(ctx: Omit<LifecyclePurgeBatchContext, 'limit' | 'releasable' | 'runId' | 'cursor' | 'force'>): Promise<number | null>;
}

/**
 * Шаг модуля видит подозрительно большой объём (ретеншн архива: к удалению разом больше
 * порога организаций) — бросает это, раннер останавливает прогон (`stopped: blast_radius`)
 * до подтверждения человеком (`force`). Atlassian 2022: 883 сайта одним скриптом.
 */
export class LifecycleBlastRadiusError extends Error {
  constructor(
    readonly due: number,
    readonly threshold: number,
  ) {
    super(`${due} due exceeds the blast-radius threshold ${threshold}`);
    this.name = 'LifecycleBlastRadiusError';
  }
}

/**
 * Реестр шагов purge модулей: ключ — `enforcement.handler` политики. Движок фичи не
 * импортирует — модуль регистрирует шаг в `onModuleInit` (паттерн FilesRefRegistry).
 * Смоук бута сверяет: каждый ключ реестра зарегистрирован (кроме ждущих этапа).
 */
@Injectable()
export class LifecyclePurgeHandlerRegistry {
  private readonly logger = new Logger(LifecyclePurgeHandlerRegistry.name);
  private readonly handlers = new Map<string, LifecyclePurgeHandler>();

  register(key: string, handler: LifecyclePurgeHandler): void {
    if (this.handlers.has(key)) this.logger.warn(`lifecycle purge handler "${key}" is already registered — overwriting`);
    this.handlers.set(key, handler);
  }

  get(key: string): LifecyclePurgeHandler | undefined {
    return this.handlers.get(key);
  }

  keys(): string[] {
    return [...this.handlers.keys()];
  }
}

/** Что каскад даёт хуку модуля. */
export interface LifecycleTenantPurgeContext {
  runId: string | null;
  /** Только посчитать (предпросмотр каскада) — хук, не умеющий считать, в предпросмотре не зовётся */
  dryRun: boolean;
  /** Момент, после которого шаг обязан вернуть управление (продолжит следующий заход); `null` — без бюджета */
  deadline: number | null;
  /**
   * Между пачками: заморозка на организации появилась — бросает, каскад останавливается
   * (`stopped: held`). Исполнитель проверяет и перед каждым шагом; хук с долгим циклом
   * зовёт сам, чтобы окно «заморозка поставлена — пачка ещё удаляет» было в одну пачку.
   */
  checkpoint(): Promise<void>;
  /** id строк политики без действующей заморозки — в транзакции удаления (см. пачки раннера) */
  releasable(tx: Tx, policyId: string, ids: readonly string[]): Promise<string[]>;
}

/** Каскад организации остановлен заморозкой (бросает `checkpoint`). */
export class LifecycleTenantHeldError extends Error {
  constructor(readonly workspaceId: string) {
    super(`organisation ${workspaceId} is under a legal hold — the purge stops`);
    this.name = 'LifecycleTenantHeldError';
  }
}

/**
 * Хук модуля в каскаде окончательного удаления организации (`onTenantPurge: registry_hook`
 * и `retain_legal` с шагом). Данные, которыми владеет СЕРВИС, а не схема (полиморфный
 * владелец, байты, права, эскроу), стираются его путём.
 *
 * Контракт: идемпотентен (прерванный каскад повторит шаг), права не проверяет (решение
 * принял ретеншн архива или команда Кабинета), на сбое БРОСАЕТ — каскад останавливается,
 * строка организации остаётся, и следующий заход продолжит с этого шага. Работает и для
 * организации, строки которой уже нет (уборка хвостов прошлых удалений). Большой объём —
 * пачками; `deadline` прошёл — вернуть `{ done: false }`, остаток доберёт следующий заход.
 */
export interface LifecycleTenantHook {
  purge(workspaceId: string, ctx: LifecycleTenantPurgeContext): Promise<void | { rows?: number; done?: boolean }>;
  /** Сколько строк шаг удалит (предпросмотр каскада); не умеет — `null` */
  estimate?(workspaceId: string): Promise<number | null>;
}

/**
 * Хуки каскада удаления организации. Порядок вызова задаёт план реестра
 * (`lifecycleTenantPurgePlan()`), не порядок регистрации.
 */
@Injectable()
export class LifecycleTenantHookRegistry {
  private readonly logger = new Logger(LifecycleTenantHookRegistry.name);
  private readonly hooks = new Map<string, LifecycleTenantHook>();

  register(key: string, hook: LifecycleTenantHook): void {
    if (this.hooks.has(key)) this.logger.warn(`tenant purge hook "${key}" is already registered — overwriting`);
    this.hooks.set(key, hook);
  }

  get(key: string): LifecycleTenantHook | undefined {
    return this.hooks.get(key);
  }

  entries(): Array<[string, LifecycleTenantHook]> {
    return [...this.hooks.entries()];
  }
}
