import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { TemplateFieldRegistry, type TemplateFieldContext } from '../../core/templates/template-field.registry';
import { fullName } from '../../shared/utils/user-name';

/**
 * Группа полей шаблона «Сотрудник» — анкета человека (users: ФИО, ИИН, адрес,
 * удостоверение — блок «Для договоров и трудоустройства») + рабочее место в
 * организации контекста (StaffAssignment: должность, отдел, филиал; первое
 * назначение считается основным — порядок создания, как в ростере).
 *
 * subjectUserId — СТОРОНА документа (податель заявления, субъект приказа),
 * а не тот, кто нажал «Сформировать». Тумблеры «Видимости в Компаниях» здесь
 * не действуют: документ (приказ, договор) печатает ИИН по определению, а
 * право формировать проверяет сервис «Документы» (Этап 4) — ровно как
 * manager+ видит реквизиты в ростере всегда.
 */
@Injectable()
export class StaffTemplateFieldsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly templateFields: TemplateFieldRegistry,
  ) {}

  onModuleInit() {
    this.templateFields.register({
      key: 'employee',
      tagPrefix: 'Сотрудник',
      label: 'Сотрудник',
      fields: [
        { key: 'ФИО', label: 'Фамилия и имя', example: 'Ахметов Аскар' },
        { key: 'Имя', label: 'Имя', example: 'Аскар' },
        { key: 'Фамилия', label: 'Фамилия', example: 'Ахметов' },
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
        { key: 'Филиал', label: 'Филиал', example: 'Филиал на Абая' },
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

    const assignment = ctx.workspaceId
      ? await this.db.staffAssignment.findFirst({
          where: { workspaceId: ctx.workspaceId, userId: ctx.subjectUserId },
          orderBy: { createdAt: 'asc' },
          include: {
            position: { select: { name: true, department: { select: { name: true } } } },
            branch: { select: { name: true } },
          },
        })
      : null;

    const idDoc = user.idDocNumber
      ? [
          `№ ${user.idDocNumber}`,
          user.idDocIssuedBy ? `выдано ${user.idDocIssuedBy}` : null,
          user.idDocIssuedAt ? user.idDocIssuedAt.toISOString().slice(0, 10).split('-').reverse().join('.') : null,
        ]
          .filter(Boolean)
          .join(' ')
      : null;

    return {
      ФИО: fullName(user),
      Имя: user.firstName,
      Фамилия: user.lastName ?? null,
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
    };
  }
}
