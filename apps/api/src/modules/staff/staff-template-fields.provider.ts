import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { TemplateFieldRegistry, type TemplateFieldContext } from '../../core/templates/template-field.registry';
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
  ) {}

  onModuleInit() {
    this.templateFields.register({
      key: 'employee',
      tagPrefix: 'Сотрудник',
      label: 'Сотрудник',
      fields: [
        // key «ФИО» не переименовывать: это тег {Сотрудник.ФИО} в уже написанных бланках
        { key: 'ФИО', label: 'ФИО (фамилия, имя, отчество)', example: 'Ахметов Аскар Болатұлы' },
        { key: 'Имя', label: 'Имя', example: 'Аскар' },
        { key: 'Фамилия', label: 'Фамилия', example: 'Ахметов' },
        { key: 'Отчество', label: 'Отчество', example: 'Болатұлы' },
        { key: 'Телефон', label: 'Телефон', example: '+7 700 123 45 67' },
        { key: 'ИИН', label: 'ИИН', example: '901231300123' },
        { key: 'Адрес', label: 'Адрес проживания', example: 'г. Алматы, мкр. Самал-2, д. 33' },
        { key: 'Дата рождения', label: 'Дата рождения', example: '31.12.1990' },
        { key: 'Удостоверение', label: 'Удостоверение (строкой)', example: '№ 038000000 выдано МВД РК 01.02.2020' },
        { key: 'Номер удостоверения', label: 'Номер удостоверения', example: '038000000' },
        { key: 'Кем выдано удостоверение', label: 'Кем выдано', example: 'МВД РК' },
        { key: 'Дата выдачи удостоверения', label: 'Дата выдачи', example: '01.02.2020' },
        { key: 'Должность', label: 'Должность', example: 'Менеджер зала' },
        { key: 'Отдел', label: 'Отдел', example: 'Отдел продаж' },
        { key: 'Филиал', label: 'Объект (филиал)', example: 'Филиал на Абая' },
        // Оргструктура: руководитель по факту назначений (вершина → владелец организации)
        { key: 'Руководитель', label: 'Руководитель (ФИО)', example: 'Иванова Айгуль Сериковна' },
        { key: 'Руководитель Должность', label: 'Должность руководителя', example: 'Руководитель отдела продаж' },
        { key: 'Руководитель объекта', label: 'Руководитель объекта (ФИО)', example: 'Сейтжанов Ерлан' },
        { key: 'Руководитель объекта Должность', label: 'Должность руководителя объекта', example: 'Управляющий точкой' },
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
          },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          include,
        });
        // Договорная должность есть, но точного назначения нет (расхождение факт/договор)
        // — пробуем без объекта, прежде чем откатиться на основное место.
        if (!assignment && employment.legalBranchId) {
          assignment = await this.db.staffAssignment.findFirst({
            where: { workspaceId: ctx.workspaceId, userId: ctx.subjectUserId, positionId: employment.legalPositionId },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            include,
          });
        }
      }
      if (!assignment) {
        assignment = await this.db.staffAssignment.findFirst({
          where: { workspaceId: ctx.workspaceId, userId: ctx.subjectUserId },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          include,
        });
      }
    }

    const idDoc = user.idDocNumber
      ? [
          `№ ${user.idDocNumber}`,
          user.idDocIssuedBy ? `выдано ${user.idDocIssuedBy}` : null,
          user.idDocIssuedAt ? user.idDocIssuedAt.toISOString().slice(0, 10).split('-').reverse().join('.') : null,
        ]
          .filter(Boolean)
          .join(' ')
      : null;

    const manager = ctx.workspaceId ? await this.managerFields(ctx.workspaceId, ctx.subjectUserId, assignment?.id ?? null) : null;

    return {
      // Кадровый порядок: Фамилия Имя Отчество; незаполненное отчество имя не ломает
      ФИО: [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || fullName(user),
      Имя: user.firstName,
      Фамилия: user.lastName ?? null,
      Отчество: user.middleName ?? null,
      Телефон: user.phone,
      ИИН: user.iin ?? null,
      Адрес: user.residentialAddress ?? null,
      'Дата рождения': user.dateOfBirth ?? null,
      Удостоверение: idDoc,
      'Номер удостоверения': user.idDocNumber ?? null,
      'Кем выдано удостоверение': user.idDocIssuedBy ?? null,
      'Дата выдачи удостоверения': user.idDocIssuedAt ?? null,
      Должность: assignment?.position?.name ?? null,
      Отдел: assignment?.position?.department?.name ?? null,
      Филиал: assignment?.branch?.name ?? null,
      Руководитель: manager?.managerName ?? null,
      'Руководитель Должность': manager?.managerPosition ?? null,
      'Руководитель объекта': manager?.branchHeadName ?? null,
      'Руководитель объекта Должность': manager?.branchHeadPosition ?? null,
    };
  }

  /** Руководитель и руководитель объекта по факту — единственный вход managerOf/holdersForPosition */
  private async managerFields(
    workspaceId: string,
    userId: string,
    assignmentId: string | null,
  ): Promise<{ managerName: string | null; managerPosition: string | null; branchHeadName: string | null; branchHeadPosition: string | null }> {
    const g = await this.graph.load(workspaceId);
    const m = managerOf(g, userId, { assignmentId });
    const managerName = m.userIds.length ? await this.kadrName(m.userIds[0]) : null;
    const managerPosition = m.positionId ? (g.positionById.get(m.positionId)?.name ?? null) : m.userIds.length ? 'Владелец организации' : null;

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
