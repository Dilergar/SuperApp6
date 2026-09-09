import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  COUNTERPARTY_REF_TYPE,
  ORG_FORMS,
  TAX_REGIMES,
  composeSignBasis,
  signBasisPartsOf,
  type SearchSourceType,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { ChatterRefRegistry } from '../../core/chatter/chatter-ref.registry';
import { SearchRegistry } from '../../core/search/search.registry';
import { TemplateFieldRegistry, type TemplateFieldContext } from '../../core/templates/template-field.registry';
import { I18nService } from '../../shared/i18n/i18n.service';
import { documentWords } from '../../shared/i18n/document-words';
import type { SearchProviderOpts, SearchProviderResult } from '../../core/search/search.types';
import { CounterpartiesService } from './counterparties.service';

/**
 * Регистрации сервиса «Контрагенты» во всех движках — одним файлом (паттерн
 * DocumentsRegistriesProvider): движки про контрагентов не знают, сервис
 * регистрируется в них сам.
 */
@Injectable()
export class CounterpartiesRegistriesProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly counterparties: CounterpartiesService,
    private readonly chatterRegistry: ChatterRefRegistry,
    private readonly searchRegistry: SearchRegistry,
    private readonly templateFields: TemplateFieldRegistry,
    private readonly i18n: I18nService,
  ) {}

  onModuleInit(): void {
    // ---- Хроника карточки: видит команда организации ----
    this.chatterRegistry.register(COUNTERPARTY_REF_TYPE, {
      canView: (viewerId, refId) => this.canView(viewerId, refId),
    });

    // ---- Глобальный поиск: имя и БИН ----
    this.searchRegistry.register({
      type: COUNTERPARTY_REF_TYPE,
      labelKey: 'counterparties.breadcrumb',
      search: (viewerId, query, opts) => this.search(viewerId, query, opts),
    });

    // ---- Группа полей шаблона «Контрагент» ----
    // Владелец данных отдаёт свою группу (Принцип 1): теги {Counterparty.Bin} в
    // договорах и АВР заполняются из справочника, панель конструктора и
    // компилятор получают поля сами.
    this.templateFields.register({
      key: 'counterparty',
      tagPrefix: 'Counterparty',
      // `key` — имя БЛАНКА, `id` — латинское имя поля для ключа каталога
      fields: [
        { key: 'Name', id: 'name' },
        { key: 'LegalName', id: 'legalName' },
        { key: 'OrgForm', id: 'orgForm' },
        { key: 'Bin', id: 'bin' },
        { key: 'Iin', id: 'iin' },
        // Форма Р-1 (АВР) печатает одну графу «ИИН/БИН» — отдаём готовое значение
        { key: 'BinOrIin', id: 'binOrIin' },
        { key: 'LegalAddress', id: 'legalAddress' },
        // Пусто в карточке = совпадает с юридическим (резолвер сам подставит юрадрес)
        { key: 'ActualAddress', id: 'actualAddress' },
        { key: 'Kbe', id: 'kbe' },
        { key: 'TaxRegime', id: 'taxRegime' },
        { key: 'Iik', id: 'iik' },
        { key: 'Bank', id: 'bank' },
        { key: 'Bik', id: 'bik' },
        { key: 'VatCertificate', id: 'vatCertificate' },
        { key: 'Director', id: 'director' },
        { key: 'Ground', id: 'ground' },
        { key: 'Signer', id: 'signer' },
        { key: 'SignerPosition', id: 'signerPosition' },
        { key: 'SignerPhone', id: 'signerPhone' },
      ],
      resolve: (ctx) => this.resolve(ctx),
    });
  }

  /** Команда организации-владельца карточки (Подрядчик изолирован) */
  private async canView(viewerId: string, refId: string): Promise<boolean> {
    const row = await this.db.counterparty.findUnique({
      where: { id: refId },
      select: { workspaceId: true },
    });
    if (!row) return false;
    const membership = await this.db.userRole.findFirst({
      where: {
        userId: viewerId,
        context: 'workspace',
        tenantId: row.workspaceId,
        isActive: true,
        role: { not: 'contractor' },
      },
      select: { id: true },
    });
    return !!membership;
  }

  /**
   * Поиск по справочнику. Права режутся В SQL: только организации, где зритель
   * в команде (модель поиска документов).
   */
  private async search(
    viewerId: string,
    query: string,
    opts: SearchProviderOpts,
  ): Promise<SearchProviderResult> {
    const memberships = await this.db.userRole.findMany({
      where: { userId: viewerId, context: 'workspace', isActive: true, role: { not: 'contractor' } },
      select: { tenantId: true },
    });
    const workspaceIds = memberships.map((m) => m.tenantId).filter((v): v is string => !!v);
    if (!workspaceIds.length) return { items: [] };

    const rows = await this.db.counterparty.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        archivedAt: null,
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { legalName: { contains: query, mode: 'insensitive' } },
          { bin: { contains: query } },
        ],
      },
      orderBy: { name: 'asc' },
      take: opts.limit,
    });
    return {
      items: rows.map((r) => ({
        type: COUNTERPARTY_REF_TYPE as SearchSourceType,
        id: r.id,
        title: r.name,
        snippet:
          [r.legalName, r.bin ? `${this.i18n.translate('counterparties.idLabel.either')} ${r.bin}` : null]
            .filter(Boolean)
            .join(' · ') || this.i18n.translate('counterparties.breadcrumb'),
        url: `/workspaces/${r.workspaceId}/counterparties?open=${r.id}`,
        chatId: null,
        messageId: null,
        avatar: null,
        createdAt: r.createdAt.toISOString(),
        score: 0,
      })),
    };
  }

  /**
   * Значения группы «Контрагент». Контракт честности: незаполненный реквизит —
   * null (рендер откажет списком), осознанно-пустое — ''.
   *
   * Fail-closed по организации: контрагент обязан принадлежать организации
   * контекста — иначе знание чужого id печатало бы чужие реквизиты в документ.
   */
  private async resolve(ctx: TemplateFieldContext): Promise<Record<string, unknown> | null> {
    if (!ctx.counterpartyId || !ctx.workspaceId) return null;
    const row = await this.db.counterparty.findUnique({ where: { id: ctx.counterpartyId } });
    if (!row || row.workspaceId !== ctx.workspaceId) return null;

    const [primaryAccount, contact] = await Promise.all([
      this.db.counterpartyBankAccount.findFirst({
        where: { counterpartyId: row.id },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      }),
      ctx.counterpartyContactId
        ? this.db.counterpartyContact.findFirst({
            where: { id: ctx.counterpartyContactId, counterpartyId: row.id },
          })
        : Promise.resolve(null),
    ]);

    // Значения ПЕЧАТАЮТСЯ в бланке — язык у них язык БУМАГИ, не язык зрителя
    const w = documentWords(this.i18n, ctx.language);
    const orgFormLabel = row.orgForm
      ? ORG_FORMS.includes(row.orgForm as (typeof ORG_FORMS)[number])
        ? w.t(`workspaces.orgForm.${row.orgForm}`)
        : row.orgForm
      : row.kind === 'entrepreneur'
        ? w.t('workspaces.orgForm.ip')
        : null;

    // Не-плательщик НДС — осознанно-пустое (''), как у группы «Организация».
    // Строка ПЕЧАТАЕТСЯ в бланке: и слова, и формат даты — в языке бланка.
    const vat = row.vatPayer
      ? [
          row.vatSeries ? w.t('templates.print.vatSeries', { value: row.vatSeries }) : null,
          row.vatNumber ? w.t('templates.print.vatNumber', { value: row.vatNumber }) : null,
          row.vatDate
            ? w.t('templates.print.vatDate', {
                // Календарная дата: «YYYY-MM-DD» разбирается без часовых поясов
                value: w.date(row.vatDate.toISOString().slice(0, 10)),
              })
            : null,
        ]
          .filter(Boolean)
          .join(' ') || null
      : '';

    return {
      Name: row.name,
      LegalName: row.legalName ?? (row.kind === 'individual' ? row.name : null),
      OrgForm: orgFormLabel,
      // БИН заполнен только у юрлица, ИИН — у ИП и физлица: чужая графа = ''
      Bin: row.kind === 'legal' ? row.bin : '',
      Iin: row.kind === 'legal' ? '' : row.bin,
      BinOrIin: row.bin,
      LegalAddress: row.legalAddress,
      // Пусто = «фактический совпадает с юридическим» — печатаем юрадрес
      ActualAddress: row.actualAddress ?? row.legalAddress,
      Kbe: row.kbe,
      TaxRegime: row.taxRegime
        ? TAX_REGIMES.includes(row.taxRegime as (typeof TAX_REGIMES)[number])
          ? w.t(`workspaces.taxRegime.${row.taxRegime}`)
          : row.taxRegime
        : null,
      Iik: primaryAccount?.iban ?? null,
      Bank: primaryAccount?.bankName ?? null,
      Bik: primaryAccount?.bik ?? null,
      VatCertificate: vat,
      Director: row.directorName,
      // «действующего на основании Приказа № 12-к от …» — в языке БУМАГИ
      Ground: composeSignBasis(signBasisPartsOf(row), w.cp, w.date),
      Signer: contact?.name ?? row.directorName,
      SignerPosition:
        contact?.position ??
        (contact ? '' : row.kind === 'legal' ? w.t('templates.print.signerPositionDefault') : ''),
      SignerPhone: contact?.phone ?? '',
    };
  }
}
