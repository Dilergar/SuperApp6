import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ZodTypeAny } from 'zod';
import { PLATFORM_RISK_RANK, type PlatformCapability, type PlatformCommandGroup, type PlatformEntity, type PlatformRisk } from '@superapp/shared';
import type { PlatformActor } from '../../shared/decorators/platform.decorator';

type Tx = Prisma.TransactionClient;

/** Контекст исполнения команды (актор + запрос). */
export interface CommandContext {
  actor: PlatformActor;
  reason: string | null;
  ticketRef: string | null;
  /** Заявка four-eyes, по которой исполняется команда (null — прямое исполнение) */
  approvalId: string | null;
}

export interface CommandTarget {
  type: string;
  id: string;
  workspaceId?: string | null;
}

export interface CommandOutcome {
  before?: unknown;
  after?: unknown;
  result?: unknown;
  /**
   * Чьи способности кабинета сбросить ПОСЛЕ коммита. Сброс внутри транзакции
   * гонится с параллельным чтением: оно видит ещё старое состояние и заново
   * кладёт его в кэш на минуту — отозванная роль продолжала бы действовать.
   */
  invalidateStaff?: string[];
}

/**
 * Декларация команды кабинета — ЕДИНСТВЕННАЯ дверь мутаций. Фича регистрирует
 * команду в своём `onModuleInit`; исполнитель делает всё остальное: capability,
 * step-up, причина, dual control, идемпотентность, маскирование, аудит, шина.
 */
export interface PlatformCommandDef<I = unknown> {
  key: string;
  version: number;
  group: PlatformCommandGroup;
  titleKey: string;
  descriptionKey?: string;
  input: ZodTypeAny;
  capability: PlatformCapability;
  risk: PlatformRisk;
  /** Через одобрение второго сотрудника при включённой политике four-eyes */
  dualControl?: boolean;
  /**
   * Мягкий four-eyes: если держателя одобряющего права НЕТ ни одного (в кабинете
   * один владелец), команда исполняется напрямую, а не отказом `no_approver`.
   * Ставится ТОЛЬКО там, где отказ запер бы кабинет насмерть: состав штата и сама
   * политика (второго сотрудника некому добавить, а политику — некому выключить).
   * Жёсткие команды (оверрайды тарифов) при отсутствии второго отказывают.
   */
  dualControlSoft?: boolean;
  /** Требовать sudo (по умолчанию — risk >= high) */
  stepUp?: boolean;
  /**
   * Запретить действие НА СЕБЯ: цель — сам сотрудник либо организация, которой он
   * владеет. Ставится у всего, что выдаёт права или привилегии: сотрудник кабинета
   * не выписывает их себе ни при какой политике — это не предмет журнала, а предмет
   * запрета (у команд штата тот же гвард стоит внутри `PlatformAccessService`).
   */
  forbidSelfTarget?: boolean;
  /**
   * Требовать причину (по умолчанию — risk >= high). Объявляется там, где причина
   * нужна и у нетяжёлой команды: раскрытие персональных данных объясняют всегда.
   */
  reasonRequired?: boolean;
  /** Есть предпросмотр (execute в откатываемой транзакции) */
  dryRun?: boolean;
  /** В карточках каких сущностей команда показывается (пусто — общая) */
  entities?: PlatformEntity[];
  /** Поля входа, маскируемые в журнале (плюс автоматически по имени поля) */
  redact?: string[];
  /**
   * Хранить ли `result` в журнале (`after.__result`). `false` — для команд, чей
   * результат сам есть PII (раскрытие телефона): в журнал попадает только факт (S7).
   */
  persistResult?: boolean;
  target(input: I): CommandTarget | null;
  execute(ctx: CommandContext, input: I, tx: Tx): Promise<CommandOutcome>;
  /** Отдельный предпросмотр (иначе — execute в откатываемой транзакции) */
  preview?(ctx: CommandContext, input: I): Promise<CommandOutcome>;
}

export const commandNeedsStepUp = (def: PlatformCommandDef): boolean =>
  def.stepUp ?? PLATFORM_RISK_RANK[def.risk] >= PLATFORM_RISK_RANK.high;
export const commandNeedsReason = (def: PlatformCommandDef): boolean =>
  def.reasonRequired === true || PLATFORM_RISK_RANK[def.risk] >= PLATFORM_RISK_RANK.high;

@Injectable()
export class PlatformCommandRegistry {
  private readonly logger = new Logger(PlatformCommandRegistry.name);
  private readonly commands = new Map<string, PlatformCommandDef>();

  register<I>(def: PlatformCommandDef<I>): void {
    if (this.commands.has(def.key)) this.logger.warn(`command "${def.key}" already registered; overwriting`);
    this.commands.set(def.key, def as PlatformCommandDef);
  }

  get(key: string): PlatformCommandDef | undefined {
    return this.commands.get(key);
  }

  list(): PlatformCommandDef[] {
    return [...this.commands.values()].sort((a, b) => a.key.localeCompare(b.key));
  }
}
