import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  CONTRACT_TYPES,
  DISMISSAL_GROUNDS,
  HR_ACTION_KIND_LABELS,
  docDateRangeDays,
  type HrActionKind,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { activeAssignmentWhere } from '../../shared/utils/assignment-window';
import { TemplateFieldRegistry, type TemplateFieldContext } from '../../core/templates/template-field.registry';
import { fullName } from '../../shared/utils/user-name';

const dstr = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Группы полей шаблонов КЭДО: «Договор» (трудовая карточка), «Действие»
 * (кадровое действие) и «Подписант» (кто подписывает по маршруту шаблона —
 * резолвится ПРИ СОЗДАНИИ документа и печатается в бланке; смена подписанта в
 * маршруте = пересборка документа, механизм docGenKey).
 *
 * Контракт честности реестра: незаполненное = null (рендер откажет списком),
 * осознанно-пустое = ''.
 */
@Injectable()
export class HrTemplateFieldsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly templateFields: TemplateFieldRegistry,
  ) {}

  onModuleInit() {
    this.templateFields.register({
      key: 'employment_contract',
      tagPrefix: 'Договор',
      label: 'Трудовой договор',
      fields: [
        { key: 'Номер', label: 'Номер договора', example: 'ТД-2026-014' },
        { key: 'Дата договора', label: 'Дата договора', example: '01.09.2026' },
        { key: 'Дата приёма', label: 'Дата начала работы', example: '01.09.2026' },
        { key: 'Срок', label: 'Срок договора', example: 'на неопределённый срок' },
        { key: 'Должность', label: 'Должность по договору', example: 'Менеджер зала' },
        { key: 'Филиал', label: 'Место работы (филиал)', example: 'Филиал на Абая' },
        { key: 'Оклад', label: 'Оклад, тенге', example: '250 000' },
        { key: 'Ставка', label: 'Ставка', example: '1' },
        { key: 'График', label: 'Режим работы', example: '5/2, 09:00–18:00' },
        { key: 'Испытание до', label: 'Испытательный срок (до даты)', example: '01.12.2026' },
        { key: 'Табельный номер', label: 'Табельный номер', example: '0042' },
        { key: 'Дата увольнения', label: 'Дата прекращения', example: '30.09.2026' },
      ],
      resolve: (ctx) => this.resolveContract(ctx),
    });

    this.templateFields.register({
      key: 'hr_action',
      tagPrefix: 'Действие',
      label: 'Кадровое действие',
      fields: [
        { key: 'Вид', label: 'Вид действия', example: 'Перевод' },
        { key: 'Дата вступления', label: 'Дата вступления в силу', example: '01.09.2026' },
        { key: 'Дата окончания', label: 'Дата окончания (отпуск)', example: '14.09.2026' },
        { key: 'Дней', label: 'Дней (календарных, отпуск)', example: '14' },
        { key: 'Оклад', label: 'Новый оклад, тенге', example: '300 000' },
        { key: 'Новая должность', label: 'Новая должность', example: 'Старший менеджер' },
        { key: 'Новый филиал', label: 'Новый филиал', example: 'Филиал на Абая' },
        { key: 'Основание', label: 'Основание прекращения (статья ТК РК)', example: 'ст. 56 ТК РК' },
      ],
      resolve: (ctx) => this.resolveAction(ctx),
    });

    this.templateFields.register({
      key: 'hr_signer',
      tagPrefix: 'Подписант',
      label: 'Подписант (из маршрута)',
      fields: [
        { key: 'ФИО', label: 'ФИО подписанта', example: 'Ахметов Аскар Болатұлы' },
        { key: 'Должность', label: 'Должность подписанта', example: 'Директор' },
      ],
      resolve: (ctx) => this.resolveSigner(ctx),
    });
  }

  // ---------- «Договор» ----------

  private async resolveContract(ctx: TemplateFieldContext): Promise<Record<string, unknown> | null> {
    if (!ctx.workspaceId || !ctx.subjectUserId) return null;
    const e = await this.db.employment.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        userId: ctx.subjectUserId,
        // Совместительство: печатаем карточку ТОГО юрлица, от имени которого документ
        ...(ctx.legalEntityId ? { legalEntityId: ctx.legalEntityId } : {}),
      },
      // Живая карточка приоритетна; после увольнения печатается последняя
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    if (!e) return null;
    const typeLabel = CONTRACT_TYPES.find((t) => t.value === e.contractType)?.label ?? e.contractType;
    const term =
      e.contractType === 'indefinite'
        ? 'на неопределённый срок'
        : e.contractEndAt
          ? `${typeLabel.toLowerCase()}, до ${dstr(e.contractEndAt)!.split('-').reverse().join('.')}`
          : typeLabel.toLowerCase();
    return {
      Номер: e.contractNumber ?? null,
      'Дата договора': e.contractDate ?? null,
      'Дата приёма': e.hiredAt ?? null,
      Срок: term,
      Должность: e.legalPositionName ?? null,
      // Осознанно-пустое: без филиала местом работы служит адрес организации
      Филиал: e.legalBranchName ?? '',
      Оклад: e.salaryAmount === null ? null : Number(e.salaryAmount) / 100,
      Ставка: e.workRate ?? 1,
      График: e.workSchedule ?? null,
      'Испытание до': e.probationUntil ?? 'без испытательного срока',
      'Табельный номер': e.personnelNumber ?? '',
      'Дата увольнения': e.firedAt ?? null,
    };
  }

  // ---------- «Действие» ----------

  private async resolveAction(ctx: TemplateFieldContext): Promise<Record<string, unknown> | null> {
    if (!ctx.hrActionId) return null;
    const a = await this.db.hrAction.findUnique({ where: { id: ctx.hrActionId } });
    if (!a) return null;
    const p = (a.params ?? {}) as Record<string, unknown>;
    const groundLabel = DISMISSAL_GROUNDS.find((g) => g.value === p.ground)?.label ?? (p.ground as string) ?? null;
    const from = dstr(a.effectiveAt)!;
    const to = dstr(a.effectiveTo);
    let positionName: string | null = null;
    let branchName: string | null = null;
    if (typeof p.legalPositionId === 'string') {
      const pos = await this.db.staffPosition.findUnique({ where: { id: p.legalPositionId }, select: { name: true } });
      positionName = pos?.name ?? null;
    }
    if (typeof p.legalBranchId === 'string') {
      const br = await this.db.staffBranch.findUnique({ where: { id: p.legalBranchId }, select: { name: true } });
      branchName = br?.name ?? null;
    }
    return {
      Вид: HR_ACTION_KIND_LABELS[a.kind as HrActionKind] ?? a.kind,
      'Дата вступления': a.effectiveAt,
      'Дата окончания': a.effectiveTo ?? null,
      Дней: to ? docDateRangeDays({ from, to }) : null,
      Оклад: p.salaryAmount !== undefined ? Number(p.salaryAmount as number) / 100 : null,
      'Новая должность': positionName,
      // Осознанно-пустое: перевод без смены филиала
      'Новый филиал': branchName ?? '',
      Основание: groundLabel,
    };
  }

  // ---------- «Подписант» ----------

  /**
   * Кто подписывает ПО МАРШРУТУ шаблона: первый шаг «Подписать» опубликованного
   * маршрута → конкретный человек (должность разворачивается в старейшего
   * держателя). Решает ШАГ МАРШРУТА — формулировка «фактический из акта»
   * невозможна: до подписи акта не существует.
   */
  private async resolveSigner(ctx: TemplateFieldContext): Promise<Record<string, unknown> | null> {
    if (!ctx.workspaceId || !ctx.templateId) return null;
    const triggers = await this.db.processTrigger.findMany({
      where: { workspaceId: ctx.workspaceId, type: 'document', enabled: true, definition: { status: 'active' } },
      select: { definitionId: true, config: true },
    });
    const trigger = triggers.find(
      (t) => ((t.config ?? {}) as { templateId?: string }).templateId === ctx.templateId,
    );
    if (!trigger) return null;
    const def = await this.db.processDefinition.findUnique({
      where: { id: trigger.definitionId },
      select: { currentVersionId: true },
    });
    const version = def?.currentVersionId
      ? await this.db.processVersion.findUnique({ where: { id: def.currentVersionId }, select: { document: true } })
      : null;
    const nodes = ((version?.document ?? {}) as { nodes?: { type?: string; config?: Record<string, unknown> }[] }).nodes ?? [];
    const signNode = nodes.find((n) => n.type === 'human.approval' && (n.config?.kind ?? 'approval') === 'signature');
    if (!signNode?.config) return null;
    const cfg = signNode.config as { assigneeMode?: string; assigneeUserId?: string; positionId?: string };

    let signerUserId: string | null = null;
    let positionName: string | null = null;
    if (cfg.assigneeMode === 'member' && cfg.assigneeUserId) {
      signerUserId = cfg.assigneeUserId;
    } else if (cfg.assigneeMode === 'position' && cfg.positionId) {
      const holder = await this.db.staffAssignment.findFirst({
        // Подписант — ДЕЙСТВУЮЩИЙ держатель должности: закрытое назначение
        // не подставляет уволенного в приказ.
        where: { workspaceId: ctx.workspaceId, positionId: cfg.positionId, ...activeAssignmentWhere() },
        orderBy: { createdAt: 'asc' },
        select: { userId: true, position: { select: { name: true } } },
      });
      signerUserId = holder?.userId ?? null;
      positionName = holder?.position.name ?? null;
    } else if (cfg.assigneeMode === 'initiator') {
      signerUserId = ctx.actorUserId ?? null;
    }
    if (!signerUserId) return null;

    const user = await this.db.user.findUnique({
      where: { id: signerUserId },
      select: { firstName: true, lastName: true, middleName: true },
    });
    if (!user) return null;
    if (!positionName) {
      const assignment = await this.db.staffAssignment.findFirst({
        where: { workspaceId: ctx.workspaceId, userId: signerUserId, ...activeAssignmentWhere() },
        orderBy: { createdAt: 'asc' },
        select: { position: { select: { name: true } } },
      });
      positionName = assignment?.position.name ?? null;
    }
    return {
      ФИО: [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || fullName(user),
      Должность: positionName ?? '',
    };
  }
}
