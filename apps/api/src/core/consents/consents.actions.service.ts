import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CONSENT_LIMITS,
  PD_RECIPIENTS,
  isPdRecipientKey,
  type ConsentSubjectType,
  type CursorPage,
  type PdActionType,
  type PdBasis,
  type PdFieldCode,
  type PdPurpose,
  type PdRecipientKey,
  type PdTransferDto,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { MonthlyPartitions } from '../../shared/database/monthly-partitions';
import { DryRun } from '../../shared/context/dry-run.context';

type Tx = Prisma.TransactionClient;

export interface PdActionInput {
  /** Чьи данные. Несколько субъектов одной передачи — несколько записей (`recordMany`) */
  subjectId: string;
  subjectType?: ConsentSubjectType;
  /** Получатель из реестра `PD_RECIPIENTS`: тип действия, страна, основание и поля берутся из него */
  recipient?: PdRecipientKey;
  /** Явный тип — только для действий без получателя (распространение, срок согласия) */
  actionType?: PdActionType;
  basis?: PdBasis;
  /** Коды полей; по умолчанию — поля получателя из реестра. НИКОГДА не значения */
  fields?: readonly PdFieldCode[];
  purpose: PdPurpose;
  /** Страна фактического получателя, если реестр её не знает (адрес вебхука) */
  country?: string | null;
  consentAcceptanceId?: string | null;
  workspaceId?: string | null;
  refType?: string | null;
  refId?: string | null;
  occurredAt?: Date;
}

/**
 * Учёт действий с ПДн (Правила № 179/НҚ п. 9 пп. 5). `record(tx, …)` зовётся В МЕСТЕ
 * ФАКТИЧЕСКОЙ ПЕРЕДАЧИ: отправка SMS, web push, синхронизация Google Calendar, доставка
 * вебхука, публичная ссылка, смена видимости карточки, приёмка и отзыв согласия.
 *
 * `tx = null` — для мест без транзакции (канал доставки уже отправил сообщение): запись
 * best-effort, её сбой передачу не роняет, но попадает в лог. С `tx` запись атомарна с мутацией.
 * Таблица — месячные партиции; партиция месяца записи гарантируется перед вставкой.
 */
@Injectable()
export class ConsentsActionsService implements OnModuleInit {
  private readonly logger = new Logger(ConsentsActionsService.name);
  private readonly partitions: MonthlyPartitions;

  constructor(private readonly db: DatabaseService) {
    // Ретеншн не применяется: учёт действий — доказательная база оператора, партиции не сбрасываются
    // (`dropExpired` движок не зовёт); срок в спецификации — формальность конструктора
    this.partitions = new MonthlyPartitions(db, { table: 'pd_action_records', column: 'occurred_at', retentionDays: 36_500 });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.partitions.ensureAhead();
    } catch (err) {
      this.logger.error(`pd_action_records partitions: ${(err as Error).message}`);
    }
  }

  /** Крон движка: партиции на три месяца вперёд. */
  async ensurePartitions(): Promise<void> {
    await this.partitions.ensureAhead();
  }

  private build(input: PdActionInput): Prisma.PdActionRecordCreateManyInput {
    const def = input.recipient ? PD_RECIPIENTS[input.recipient] : null;
    const crossBorder = def ? def.crossBorder : false;
    const actionType: PdActionType = input.actionType ?? (crossBorder ? 'cross_border' : 'transfer');
    return {
      actionType,
      subjectType: input.subjectType ?? 'user',
      subjectId: input.subjectId,
      recipientKey: input.recipient ?? null,
      crossBorder,
      country: input.country ?? def?.country ?? null,
      basis: input.basis ?? def?.basis ?? 'consent',
      consentAcceptanceId: input.consentAcceptanceId ?? null,
      fields: [...(input.fields ?? def?.fields ?? [])],
      purpose: input.purpose,
      workspaceId: input.workspaceId ?? null,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      occurredAt: input.occurredAt ?? new Date(),
    };
  }

  async record(tx: Tx | null, input: PdActionInput): Promise<void> {
    await this.recordMany(tx, [input]);
  }

  async recordMany(tx: Tx | null, inputs: PdActionInput[]): Promise<void> {
    if (!inputs.length) return;
    const rows = inputs.map((i) => this.build(i));
    if (tx) {
      // Партицию нельзя создавать внутри чужой транзакции (DDL под её блокировками) —
      // она гарантирована заранее (`ensureAhead` на буте и кроном); здесь только вставка
      await tx.pdActionRecord.createMany({ data: rows });
      return;
    }
    // Предпросмотр команды кабинета: эффект вне транзакции молчит
    if (DryRun.active()) return;
    try {
      for (const r of rows) await this.partitions.ensureFor(r.occurredAt as Date);
      await this.db.pdActionRecord.createMany({ data: rows });
    } catch (err) {
      this.logger.error(`pd action record failed (${rows[0]!.purpose}, ${rows.length} rows): ${(err as Error).message}`);
    }
  }

  /** «Кому передавались мои данные»: передачи и распространение (без служебных записей о сроке согласия). */
  async transfersOf(userId: string, query: { cursor?: string; limit?: number }): Promise<CursorPage<PdTransferDto>> {
    const limit = query.limit ?? CONSENT_LIMITS.pageSize;
    let before: { id: bigint; at: Date } | null = null;
    if (query.cursor) {
      const [idRaw, atRaw] = query.cursor.split('_');
      const at = new Date(Number(atRaw));
      if (/^\d+$/.test(idRaw ?? '') && !Number.isNaN(at.getTime())) before = { id: BigInt(idRaw!), at };
    }
    const rows = await this.db.pdActionRecord.findMany({
      where: {
        subjectType: 'user',
        subjectId: userId,
        actionType: { in: ['transfer', 'cross_border', 'publication'] },
        ...(before ? { OR: [{ occurredAt: { lt: before.at } }, { occurredAt: before.at, id: { lt: before.id } }] } : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id.toString(),
        actionType: r.actionType as PdActionType,
        recipientKey: isPdRecipientKey(r.recipientKey) ? r.recipientKey : null,
        recipientName: isPdRecipientKey(r.recipientKey) ? PD_RECIPIENTS[r.recipientKey].name : null,
        crossBorder: r.crossBorder,
        country: r.country,
        basis: r.basis as PdBasis,
        fields: r.fields as PdFieldCode[],
        purpose: r.purpose as PdPurpose,
        occurredAt: r.occurredAt.toISOString(),
      })),
      nextCursor: rows.length > limit && last ? `${last.id.toString()}_${last.occurredAt.getTime()}` : null,
    };
  }
}
