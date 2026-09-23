import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AUDIT_LIMITS,
  CONSENT_LIMITS,
  PD_RECIPIENTS,
  isPdRecipientKey,
  type AuditEventKey,
  type ConsentSubjectType,
  type CursorPage,
  type PdActionType,
  type PdBasis,
  type PdFieldCode,
  type PdPurpose,
  type PdRecipientKey,
  type PdTransferDto,
} from '@superapp/shared';
import { AuditService, type AuditRecordInput } from '../audit/audit.service';
import { AuditQueryService } from '../audit/audit.query.service';

type Tx = Prisma.TransactionClient;

export interface PdActionInput {
  /** Чьи данные. Несколько субъектов одной передачи — несколько записей (`recordMany`) */
  subjectId: string;
  subjectType?: ConsentSubjectType;
  /** Получатель из реестра `PD_RECIPIENTS`: тип действия, страна, основание и поля берутся из него */
  recipient?: PdRecipientKey;
  /** Явный тип — только для действий без получателя (распространение) */
  actionType?: Exclude<PdActionType, 'consent_term'>;
  basis?: PdBasis;
  /** Коды полей; по умолчанию — поля получателя из реестра. НИКОГДА не значения */
  fields?: readonly PdFieldCode[];
  purpose: PdPurpose;
  /** Страна фактического получателя, если реестр её не знает (адрес вебхука) */
  country?: string | null;
  /** Приёмка согласия-основания (`consent_acceptances.id`) */
  consentAcceptanceId?: string | null;
  workspaceId?: string | null;
  refType?: string | null;
  refId?: string | null;
}

/** Тип действия → ключ события журнала (явная таблица: ключи видны стражу `check:audit`). */
const PD_EVENT_OF: Record<Exclude<PdActionType, 'consent_term'>, AuditEventKey> = {
  transfer: 'pd.transfer',
  cross_border: 'pd.cross_border',
  publication: 'pd.publication',
};
const PD_ACTION_OF: Record<string, Exclude<PdActionType, 'consent_term'>> = { 'pd.transfer': 'transfer', 'pd.cross_border': 'cross_border', 'pd.publication': 'publication' };
const TRANSFER_KEYS = Object.values(PD_EVENT_OF);

/**
 * Учёт действий с ПДн (Правила № 179/НҚ п. 9 пп. 5) — события `pd.*` журнала безопасности
 * (core/audit; бывший `pd_action_records`). `record(tx, …)` зовётся В МЕСТЕ ФАКТИЧЕСКОЙ
 * ПЕРЕДАЧИ: отправка SMS, web push, синхронизация Google Calendar, доставка вебхука,
 * публичная ссылка, смена видимости карточки. Срок согласия (приёмка/отзыв) — события
 * `consents.accepted|revoked`, их пишет сам движок согласий.
 *
 * `tx = null` — для мест без транзакции (канал доставки уже отправил сообщение): запись
 * best-effort, её сбой передачу не роняет, но попадает в метрику. С `tx` запись атомарна с
 * мутацией. Окно ленты человека эти события не режет: «Мои данные» показывают всю историю.
 */
@Injectable()
export class ConsentsActionsService {
  constructor(
    private readonly audit: AuditService,
    private readonly query: AuditQueryService,
  ) {}

  private build(input: PdActionInput): AuditRecordInput<AuditEventKey> {
    const def = input.recipient ? PD_RECIPIENTS[input.recipient] : null;
    const crossBorder = def ? def.crossBorder : false;
    const actionType = input.actionType ?? (crossBorder ? 'cross_border' : 'transfer');
    const workspaceSubject = input.subjectType === 'workspace';
    return {
      key: PD_EVENT_OF[actionType],
      subjectUserId: workspaceSubject ? null : input.subjectId,
      workspaceId: workspaceSubject ? input.subjectId : (input.workspaceId ?? null),
      details: {
        recipient: input.recipient ?? null,
        recipientCountry: input.country ?? def?.country ?? null,
        basis: input.basis ?? def?.basis ?? 'consent',
        fields: [...(input.fields ?? def?.fields ?? [])],
        purpose: input.purpose,
        crossBorder,
      },
      ref: input.refType && input.refId ? { type: input.refType, id: input.refId } : null,
      related: input.consentAcceptanceId ? { consentAcceptanceId: input.consentAcceptanceId } : null,
    } as AuditRecordInput<AuditEventKey>;
  }

  async record(tx: Tx | null, input: PdActionInput): Promise<void> {
    await this.recordMany(tx, [input]);
  }

  async recordMany(tx: Tx | null, inputs: PdActionInput[]): Promise<void> {
    for (const input of inputs) {
      const row = this.build(input);
      if (tx) await this.audit.record(tx, row);
      else await this.audit.recordBestEffort(row);
    }
  }

  /** «Кому передавались мои данные»: передачи и распространение (без окна ленты). */
  async transfersOf(userId: string, query: { cursor?: string; limit?: number }): Promise<CursorPage<PdTransferDto>> {
    const limit = Math.min(query.limit ?? CONSENT_LIMITS.pageSize, AUDIT_LIMITS.feedPageSize * 2);
    const { rows, nextCursor } = await this.query.rows({ kind: 'subject', userId }, { keys: TRANSFER_KEYS, cursor: query.cursor, limit });
    return {
      items: rows.map((r) => {
        const d = (r.details && typeof r.details === 'object' && !Array.isArray(r.details) ? r.details : {}) as Record<string, unknown>;
        const recipientKey = isPdRecipientKey(d.recipient) ? d.recipient : null;
        return {
          id: r.id.toString(),
          actionType: PD_ACTION_OF[r.eventKey] ?? 'transfer',
          recipientKey,
          recipientName: recipientKey ? PD_RECIPIENTS[recipientKey].name : null,
          crossBorder: d.crossBorder === true,
          country: typeof d.recipientCountry === 'string' ? d.recipientCountry : null,
          basis: (typeof d.basis === 'string' ? d.basis : 'consent') as PdBasis,
          fields: (Array.isArray(d.fields) ? d.fields : []) as PdFieldCode[],
          purpose: d.purpose as PdPurpose,
          occurredAt: r.occurredAt.toISOString(),
        };
      }),
      nextCursor,
    };
  }
}
