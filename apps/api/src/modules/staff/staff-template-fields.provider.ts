import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { activeAssignmentWhere } from '../../shared/utils/assignment-window';
import { TemplateFieldRegistry, type TemplateFieldContext } from '../../core/templates/template-field.registry';
import { documentWords, type DocumentWords } from '../../shared/i18n/document-words';
import { I18nService } from '../../shared/i18n/i18n.service';
import { fullName } from '../../shared/utils/user-name';
import { OrgGraphService } from './org-graph.service';
import { holdersForPosition, managerOf, orgToday, pickAssignment } from './org-resolve';

/**
 * Группа полей шаблона «Сотрудник» — анкета человека (users: ФИО, ИИН, адрес,
 * удостоверение — блок «Для договоров и трудоустройства») + рабочее место в
 * организации контекста (StaffAssignment: должность, отдел, объект; основное
 * место — isPrimary) + РУКОВОДИТЕЛЬ по оргструктуре (managerOf по факту: «согласовано:
 * ____» в приказах перестаёт набираться руками) и руководитель объекта.
 *
 * subjectUserId — СТОРОНА документа (податель заявления, субъект приказа),
 * а не тот, кто нажал «Сформировать». Тумблеры «Видимости в Компаниях» здесь
 * не действуют: документ (приказ, договор) печатает ИИН по определению, а
 * право формировать проверяет сервис «Документы» — ровно как manager+ видит
 * реквизиты в ростере всегда.
 */
@Injectable()
export class StaffTemplateFieldsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly templateFields: TemplateFieldRegistry,
    private readonly graph: OrgGraphService,
    private readonly i18n: I18nService,
  ) {}

  onModuleInit() {
    this.templateFields.register({
      key: 'employee',
      tagPrefix: 'Employee',
      // `key` — имя ТЕГА внутри бланка, `id` — то же имя для ключа каталога
      fields: [
        { key: 'FullName', id: 'fullName' },
        { key: 'FirstName', id: 'firstName' },
        { key: 'LastName', id: 'lastName' },
        { key: 'MiddleName', id: 'middleName' },
        { key: 'Phone', id: 'phone' },
        { key: 'Iin', id: 'iin' },
        { key: 'Address', id: 'address' },
        { key: 'BirthDate', id: 'birthDate' },
        { key: 'IdDocument', id: 'idDocument' },
        { key: 'IdNumber', id: 'idNumber' },
        { key: 'IdIssuedBy', id: 'idIssuedBy' },
        { key: 'IdIssuedAt', id: 'idIssuedAt' },
        { key: 'Position', id: 'position' },
        { key: 'Department', id: 'department' },
        { key: 'Branch', id: 'branch' },
        // Оргструктура: руководитель по факту назначений (вершина → владелец организации)
        { key: 'Manager', id: 'manager' },
        { key: 'ManagerPosition', id: 'managerPosition' },
        { key: 'BranchHead', id: 'branchHead' },
        { key: 'BranchHeadPosition', id: 'branchHeadPosition' },
      ],
      resolve: (ctx) => this.resolve(ctx),
    });
  }

  private async resolve(ctx: TemplateFieldContext): Promise<Record<string, unknown> | null> {
    if (!ctx.subjectUserId) return null;
    const user = await this.db.user.findUnique({
      where: { id: ctx.subjectUserId },
      select: {
        firstName: true,
        lastName: true,
        middleName: true,
        phone: true,
        dateOfBirth: true,
        iin: true,
        residentialAddress: true,
        idDocNumber: true,
        idDocIssuedBy: true,
        idDocIssuedAt: true,
      },
    });
    if (!user) return null;

    // Приоритет — назначение, совпадающее с ДОГОВОРНОЙ должностью (Employment):
    // официант на двух объектах иначе получал в приказ объект ОСНОВНОГО места.
    // Нет трудовой карточки — основное место (isPrimary), затем первое по дате.
    let assignment: {
      id: string;
      position: { name: string; department: { name: string } | null } | null;
      branch: { name: string } | null;
    } | null = null;
    if (ctx.workspaceId) {
      const employment = await this.db.employment.findFirst({
        where: { workspaceId: ctx.workspaceId, userId: ctx.subjectUserId, status: { not: 'terminated' } },
        select: { legalPositionId: true, legalBranchId: true },
      });
      const include = {
        position: { select: { name: true, department: { select: { name: true } } } },
        branch: { select: { name: true } },
      } as const;
      if (employment?.legalPositionId) {
        assignment = await this.db.staffAssignment.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            userId: ctx.subjectUserId,
            positionId: employment.legalPositionId,
            ...(employment.legalBranchId ? { branchId: employment.legalBranchId } : {}),
            // Печатаем ДЕЙСТВУЮЩЕЕ назначение: закрытое осталось в истории.
            ...activeAssignmentWhere(),
          },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          include,
        });
        // Договорная должность есть, но точного назначения нет (расхождение факт/договор)
        // — пробуем без объекта, прежде чем откатиться на основное место.
        if (!assignment && employment.legalBranchId) {
          assignment = await this.db.staffAssignment.findFirst({
            where: {
              workspaceId: ctx.workspaceId,
              userId: ctx.subjectUserId,
              positionId: employment.legalPositionId,
              ...activeAssignmentWhere(),
            },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            include,
          });
        }
      }
      if (!assignment) {
        assignment = await this.db.staffAssignment.findFirst({
          where: { workspaceId: ctx.workspaceId, userId: ctx.subjectUserId, ...activeAssignmentWhere() },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          include,
        });
      }
    }

    // Строка удостоверения ПЕЧАТАЕТСЯ в бланке: и «№», и «выдано …», и формат
    // даты берутся в языке БУМАГИ, а не зрителя
    const w = documentWords(this.i18n, ctx.language);
    const idDoc = user.idDocNumber
      ? [
          w.t('templates.print.number', { value: user.idDocNumber }),
          user.idDocIssuedBy ? w.t('staff.form.idDocIssuedBy', { issuer: user.idDocIssuedBy }) : null,
          user.idDocIssuedAt ? w.date(user.idDocIssuedAt) : null,
        ]
          .filter(Boolean)
          .join(' ')
      : null;

    const manager = ctx.workspaceId
      ? await this.managerFields(ctx.workspaceId, ctx.subjectUserId, assignment?.id ?? null, w)
      : null;

    return {
      // Кадровый порядок: Фамилия Имя Отчество; незаполненное отчество имя не ломает
      FullName: [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || fullName(user),
      FirstName: user.firstName,
      LastName: user.lastName ?? null,
      MiddleName: user.middleName ?? null,
      Phone: user.phone,
      Iin: user.iin ?? null,
      Address: user.residentialAddress ?? null,
      BirthDate: user.dateOfBirth ?? null,
      IdDocument: idDoc,
      IdNumber: user.idDocNumber ?? null,
      IdIssuedBy: user.idDocIssuedBy ?? null,
      IdIssuedAt: user.idDocIssuedAt ?? null,
      Position: assignment?.position?.name ?? null,
      Department: assignment?.position?.department?.name ?? null,
      Branch: assignment?.branch?.name ?? null,
      Manager: manager?.managerName ?? null,
      ManagerPosition: manager?.managerPosition ?? null,
      BranchHead: manager?.branchHeadName ?? null,
      BranchHeadPosition: manager?.branchHeadPosition ?? null,
    };
  }

  /** Руководитель и руководитель объекта по факту — единственный вход managerOf/holdersForPosition */
  private async managerFields(
    workspaceId: string,
    userId: string,
    assignmentId: string | null,
    w: DocumentWords,
  ): Promise<{ managerName: string | null; managerPosition: string | null; branchHeadName: string | null; branchHeadPosition: string | null }> {
    const g = await this.graph.load(workspaceId);
    const m = managerOf(g, userId, { assignmentId });
    const managerName = m.userIds.length ? await this.kadrName(m.userIds[0]) : null;
    // Значение ПЕЧАТАЕТСЯ в бланке — язык у него язык БУМАГИ, не язык зрителя.
    const managerPosition = m.positionId
      ? (g.positionById.get(m.positionId)?.name ?? null)
      : m.userIds.length
        ? w.t('staff.card.orgOwner')
        : null;

    let branchHeadName: string | null = null;
    let branchHeadPosition: string | null = null;
    const a = pickAssignment(g, userId, { assignmentId });
    const branch = a ? g.branchById.get(a.branchId) : null;
    if (branch?.headPositionId) {
      const holders = holdersForPosition(g, branch.headPositionId, branch.id, orgToday());
      if (holders.userIds.length) {
        branchHeadName = await this.kadrName(holders.userIds[0]);
        branchHeadPosition = g.positionById.get(branch.headPositionId)?.name ?? null;
      }
    }
    return { managerName, managerPosition, branchHeadName, branchHeadPosition };
  }

  /** Кадровый порядок ФИО: Фамилия Имя Отчество */
  private async kadrName(userId: string): Promise<string | null> {
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true, middleName: true } });
    if (!u) return null;
    return [u.lastName, u.firstName, u.middleName].filter(Boolean).join(' ') || fullName(u);
  }
}
