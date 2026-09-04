import { Injectable, OnModuleInit } from '@nestjs/common';
import { ORG_FORMS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { TemplateFieldRegistry, type TemplateFieldContext } from '../../core/templates/template-field.registry';
import { fullName } from '../../shared/utils/user-name';

/**
 * Группа полей шаблона «Организация» — реквизиты из «Анкеты компании»
 * (WorkspaceRequisites + основной банковский счёт). Правило платформы: данные
 * вводятся ОДИН раз в анкете, документы читают их отсюда.
 *
 * Тумблер видимости реквизитов сотрудникам здесь НЕ действует сознательно:
 * право сформировать документ проверяет сервис «Документы» (Этап 4), а документ
 * печатает реквизиты по определению — как счёт на оплату.
 *
 * Контракт честности: незаполненный реквизит = null → формирование откажет
 * списком «заполните Анкету компании», а не напечатает приказ с пустотой.
 */
@Injectable()
export class WorkspacesTemplateFieldsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly templateFields: TemplateFieldRegistry,
  ) {}

  onModuleInit() {
    this.templateFields.register({
      key: 'workspace',
      tagPrefix: 'Организация',
      label: 'Организация',
      fields: [
        { key: 'Название', label: 'Название (бренд)', example: 'Ромашка' },
        { key: 'Юрнаименование', label: 'Юридическое наименование', example: 'ТОО «Ромашка»' },
        { key: 'Юрформа', label: 'Организационно-правовая форма', example: 'ТОО' },
        { key: 'БИН', label: 'БИН', example: '123456789012' },
        { key: 'Юрадрес', label: 'Юридический адрес', example: 'г. Алматы, ул. Абая, 1' },
        { key: 'КБе', label: 'КБе', example: '17' },
        { key: 'Директор', label: 'Директор (ФИО)', example: 'Ахметов Аскар' },
        { key: 'Основание', label: 'Основание подписи', example: 'Устава' },
        { key: 'ИИК', label: 'ИИК (IBAN основного счёта)', example: 'KZ86125KZT5004100100' },
        { key: 'Банк', label: 'Банк', example: 'АО «Народный Банк Казахстана»' },
        { key: 'БИК', label: 'БИК', example: 'HSBKKZKX' },
        { key: 'Свидетельство НДС', label: 'Свидетельство НДС', example: 'серия 60001 № 0031205 от 01.01.2026' },
      ],
      resolve: (ctx) => this.resolve(ctx),
    });
  }

  private async resolve(ctx: TemplateFieldContext): Promise<Record<string, unknown> | null> {
    if (!ctx.workspaceId) return null;
    // Реквизиты берутся у ЮРЛИЦА контекста (договор подписывает конкретное ТОО);
    // не задано — головное. Бренд-название организации остаётся полем «Название».
    const requisites = ctx.legalEntityId
      ? await this.db.legalEntity.findFirst({
          where: { id: ctx.legalEntityId, workspaceId: ctx.workspaceId },
        })
      : await this.db.legalEntity.findFirst({
          where: { workspaceId: ctx.workspaceId, isHead: true },
        });
    const [workspace, primaryAccount] = await Promise.all([
      this.db.workspace.findUnique({ where: { id: ctx.workspaceId }, select: { name: true } }),
      requisites
        ? this.db.workspaceBankAccount.findFirst({
            where: { legalEntityId: requisites.id },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          })
        : Promise.resolve(null),
    ]);
    if (!workspace) return null;

    const director =
      requisites?.directorUserId
        ? await this.db.user.findUnique({
            where: { id: requisites.directorUserId },
            select: { firstName: true, lastName: true },
          })
        : null;

    const orgFormLabel = requisites?.orgForm
      ? (ORG_FORMS.find((f) => f.value === requisites.orgForm)?.label ?? requisites.orgForm)
      : null;

    // Не-плательщик НДС — осознанно-пустое значение (''), а не «не заполнено»
    const vat = requisites
      ? requisites.vatPayer
        ? [
            requisites.vatSeries ? `серия ${requisites.vatSeries}` : null,
            requisites.vatNumber ? `№ ${requisites.vatNumber}` : null,
            requisites.vatDate
              ? `от ${requisites.vatDate.toISOString().slice(0, 10).split('-').reverse().join('.')}`
              : null,
          ]
            .filter(Boolean)
            .join(' ') || null
        : ''
      : null;

    return {
      Название: workspace.name,
      Юрнаименование: requisites?.legalName ?? null,
      Юрформа: orgFormLabel,
      БИН: requisites?.bin ?? null,
      Юрадрес: requisites?.legalAddress ?? null,
      КБе: requisites?.kbe ?? null,
      Директор: director ? fullName(director) : null,
      Основание: requisites?.signBasis ?? null,
      ИИК: primaryAccount?.iban ?? null,
      Банк: primaryAccount?.bankName ?? null,
      БИК: primaryAccount?.bik ?? null,
      'Свидетельство НДС': vat,
    };
  }
}
