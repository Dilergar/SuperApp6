import { Injectable, OnModuleInit } from '@nestjs/common';
import { ORG_FORMS, composeSignBasis, signBasisPartsOf } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { documentWords } from '../../shared/i18n/document-words';
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
    private readonly i18n: I18nService,
  ) {}

  onModuleInit() {
    this.templateFields.register({
      key: 'workspace',
      tagPrefix: 'Organization',
      // `key` — имя ТЕГА внутри бланка (`{Organization.Bin}`), `id` — то же имя
      // в camelCase, по нему реестр берёт подпись и пример из каталога.
      fields: [
        { key: 'Name', id: 'name' },
        { key: 'LegalName', id: 'legalName' },
        { key: 'OrgForm', id: 'orgForm' },
        { key: 'Bin', id: 'bin' },
        { key: 'LegalAddress', id: 'legalAddress' },
        { key: 'Kbe', id: 'kbe' },
        { key: 'Director', id: 'director' },
        { key: 'Ground', id: 'ground' },
        { key: 'Iik', id: 'iik' },
        { key: 'Bank', id: 'bank' },
        { key: 'Bik', id: 'bik' },
        { key: 'VatCertificate', id: 'vatCertificate' },
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

    // Юрформа ПЕЧАТАЕТСЯ в бланке — язык у неё язык БУМАГИ, не язык зрителя
    const w = documentWords(this.i18n, ctx.language);
    const orgFormLabel = requisites?.orgForm
      ? ORG_FORMS.includes(requisites.orgForm as (typeof ORG_FORMS)[number])
        ? w.t(`workspaces.orgForm.${requisites.orgForm}`)
        : requisites.orgForm
      : null;

    // Не-плательщик НДС — осознанно-пустое значение (''), а не «не заполнено».
    // Строка ПЕЧАТАЕТСЯ в бланке: и слова, и формат даты берём в языке бланка.
    const vat = requisites
      ? requisites.vatPayer
        ? [
            requisites.vatSeries ? w.t('templates.print.vatSeries', { value: requisites.vatSeries }) : null,
            requisites.vatNumber ? w.t('templates.print.vatNumber', { value: requisites.vatNumber }) : null,
            requisites.vatDate
              ? w.t('templates.print.vatDate', {
                  // Календарная дата: отдаём «YYYY-MM-DD» — форматтер разберёт её
                  // без часовых поясов и соберёт в правилах региона
                  value: w.date(requisites.vatDate.toISOString().slice(0, 10)),
                })
              : null,
          ]
            .filter(Boolean)
            .join(' ') || null
        : ''
      : null;

    return {
      Name: workspace.name,
      LegalName: requisites?.legalName ?? null,
      OrgForm: orgFormLabel,
      Bin: requisites?.bin ?? null,
      LegalAddress: requisites?.legalAddress ?? null,
      Kbe: requisites?.kbe ?? null,
      Director: director ? fullName(director) : null,
      // «действующего на основании Устава» — фраза собирается в языке БУМАГИ
      Ground: requisites ? composeSignBasis(signBasisPartsOf(requisites), w.cp, w.date) : null,
      Iik: primaryAccount?.iban ?? null,
      Bank: primaryAccount?.bankName ?? null,
      Bik: primaryAccount?.bik ?? null,
      VatCertificate: vat,
    };
  }
}
