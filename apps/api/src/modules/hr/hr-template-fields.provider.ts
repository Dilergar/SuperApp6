import { Injectable, OnModuleInit } from '@nestjs/common';
import { docDateRangeDays } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { documentWords } from '../../shared/i18n/document-words';
import { activeAssignmentWhere } from '../../shared/utils/assignment-window';
import { TemplateFieldRegistry, type TemplateFieldContext } from '../../core/templates/template-field.registry';
import { fullName } from '../../shared/utils/user-name';

const dstr = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

// Язык ПЕЧАТНОЙ ФОРМЫ приезжает в контексте резолва (`ctx.language`) — это язык
// самого документа, а не зрителя: `apps/api/src/shared/i18n/document-words.ts`.

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
    private readonly i18n: I18nService,
  ) {}

  onModuleInit() {
    this.templateFields.register({
      key: 'employment_contract',
      tagPrefix: 'Contract',
      // `key` — имя БЛАНКА, `id` — латинское имя поля для ключа каталога
      fields: [
        { key: 'Number', id: 'number' },
        { key: 'Date', id: 'date' },
        { key: 'StartDate', id: 'startDate' },
        { key: 'Term', id: 'term' },
        { key: 'Position', id: 'position' },
        { key: 'Branch', id: 'branch' },
        { key: 'Salary', id: 'salary' },
        { key: 'Rate', id: 'rate' },
        { key: 'Schedule', id: 'schedule' },
        { key: 'ProbationUntil', id: 'probationUntil' },
        { key: 'PersonnelNumber', id: 'personnelNumber' },
        { key: 'EndDate', id: 'endDate' },
      ],
      resolve: (ctx) => this.resolveContract(ctx),
    });

    this.templateFields.register({
      key: 'hr_action',
      tagPrefix: 'Action',
      fields: [
        { key: 'Kind', id: 'kind' },
        { key: 'EffectiveFrom', id: 'effectiveFrom' },
        { key: 'EffectiveTo', id: 'effectiveTo' },
        { key: 'Days', id: 'days' },
        { key: 'Salary', id: 'salary' },
        { key: 'NewPosition', id: 'newPosition' },
        { key: 'NewBranch', id: 'newBranch' },
        { key: 'Ground', id: 'ground' },
      ],
      resolve: (ctx) => this.resolveAction(ctx),
    });

    this.templateFields.register({
      key: 'hr_signer',
      tagPrefix: 'Signer',
      fields: [
        { key: 'FullName', id: 'fullName' },
        { key: 'Position', id: 'position' },
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
    const w = documentWords(this.i18n, ctx.language);
    const typeLabel = w.t(`hr.contractType.${e.contractType}`);
    const term =
      e.contractType === 'indefinite'
        ? typeLabel.toLowerCase()
        : e.contractEndAt
          ? `${typeLabel.toLowerCase()}, ${w.t('hr.form.until')} ${w.date(e.contractEndAt)}`
          : typeLabel.toLowerCase();
    return {
      Number: e.contractNumber ?? null,
      Date: e.contractDate ?? null,
      StartDate: e.hiredAt ?? null,
      Term: term,
      Position: e.legalPositionName ?? null,
      // Осознанно-пустое: без филиала местом работы служит адрес организации
      Branch: e.legalBranchName ?? '',
      Salary: e.salaryAmount === null ? null : Number(e.salaryAmount) / 100,
      Rate: e.workRate ?? 1,
      Schedule: e.workSchedule ?? null,
      ProbationUntil: e.probationUntil ?? w.t('hr.form.noProbation'),
      PersonnelNumber: e.personnelNumber ?? '',
      EndDate: e.firedAt ?? null,
    };
  }

  // ---------- «Действие» ----------

  private async resolveAction(ctx: TemplateFieldContext): Promise<Record<string, unknown> | null> {
    if (!ctx.hrActionId) return null;
    const a = await this.db.hrAction.findUnique({ where: { id: ctx.hrActionId } });
    if (!a) return null;
    const p = (a.params ?? {}) as Record<string, unknown>;
    const w = documentWords(this.i18n, ctx.language);
    const groundKey = typeof p.ground === 'string' ? `hr.ground.${p.ground}` : null;
    const groundLabel =
      groundKey && this.i18n.has(groundKey, w.locale) ? w.t(groundKey) : (p.ground as string) ?? null;
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
      Kind: this.i18n.has(`hr.actionKind.${a.kind}`, w.locale) ? w.t(`hr.actionKind.${a.kind}`) : a.kind,
      EffectiveFrom: a.effectiveAt,
      EffectiveTo: a.effectiveTo ?? null,
      Days: to ? docDateRangeDays({ from, to }) : null,
      Salary: p.salaryAmount !== undefined ? Number(p.salaryAmount as number) / 100 : null,
      NewPosition: positionName,
      // Осознанно-пустое: перевод без смены филиала
      NewBranch: branchName ?? '',
      Ground: groundLabel,
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
      FullName: [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || fullName(user),
      Position: positionName ?? '',
    };
  }
}
