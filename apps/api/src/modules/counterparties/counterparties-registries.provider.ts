import { Injectable, OnModuleInit } from '@nestjs/common';
import { COUNTERPARTY_REF_TYPE, ORG_FORMS, TAX_REGIMES, type SearchSourceType } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { ChatterRefRegistry } from '../../core/chatter/chatter-ref.registry';
import { SearchRegistry } from '../../core/search/search.registry';
import { TemplateFieldRegistry, type TemplateFieldContext } from '../../core/templates/template-field.registry';
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
  ) {}

  onModuleInit(): void {
    // ---- Хроника карточки: видит команда организации ----
    this.chatterRegistry.register(COUNTERPARTY_REF_TYPE, {
      canView: (viewerId, refId) => this.canView(viewerId, refId),
    });

    // ---- Глобальный поиск: имя и БИН ----
    this.searchRegistry.register({
      type: COUNTERPARTY_REF_TYPE,
      label: 'Контрагенты',
      search: (viewerId, query, opts) => this.search(viewerId, query, opts),
    });

    // ---- Группа полей шаблона «Контрагент» ----
    // Владелец данных отдаёт свою группу (Принцип 1): теги {Контрагент.БИН} в
    // договорах и АВР заполняются из справочника, панель конструктора и
    // компилятор получают поля сами.
    this.templateFields.register({
      key: 'counterparty',
      tagPrefix: 'Контрагент',
      label: 'Контрагент',
      fields: [
        { key: 'Название', label: 'Название (рабочее имя)', example: 'Ромашка' },
        { key: 'Юрнаименование', label: 'Юридическое наименование', example: 'ТОО «Ромашка»' },
        { key: 'Юрформа', label: 'Организационно-правовая форма', example: 'ТОО' },
        { key: 'БИН', label: 'БИН (юрлицо)', example: '123456789012' },
        { key: 'ИИН', label: 'ИИН (ИП, физлицо)', example: '850101300123' },
        // Форма Р-1 (АВР) печатает одну графу «ИИН/БИН» — отдаём готовое значение
        { key: 'БИН-ИИН', label: 'БИН или ИИН (графа Р-1)', example: '123456789012' },
        { key: 'Юрадрес', label: 'Юридический адрес', example: 'г. Астана, пр. Абая, 1' },
        // Пусто в карточке = совпадает с юридическим (резолвер сам подставит юрадрес)
        { key: 'Фактический адрес', label: 'Фактический адрес', example: 'г. Астана, пр. Абая, 1' },
        { key: 'КБе', label: 'КБе', example: '17' },
        { key: 'Налоговый режим', label: 'Налоговый режим', example: 'Упрощённая декларация' },
        { key: 'ИИК', label: 'ИИК (IBAN основного счёта)', example: 'KZ86125KZT5004100100' },
        { key: 'Банк', label: 'Банк', example: 'АО «Kaspi Bank»' },
        { key: 'БИК', label: 'БИК', example: 'CASPKZKA' },
        { key: 'Свидетельство НДС', label: 'Свидетельство НДС', example: 'серия 60001 № 0031205 от 01.01.2026' },
        { key: 'Руководитель', label: 'Руководитель (ФИО)', example: 'Иванов Иван' },
        { key: 'Основание', label: 'Основание подписи', example: 'Устава' },
        { key: 'Подписант', label: 'Подписант (контактное лицо)', example: 'Иванов Иван' },
        { key: 'Подписант Должность', label: 'Должность подписанта', example: 'Директор' },
        { key: 'Подписант Телефон', label: 'Телефон подписанта', example: '+7 777 123 45 67' },
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
        snippet: [r.legalName, r.bin ? `БИН/ИИН ${r.bin}` : null].filter(Boolean).join(' · ') || 'Контрагент',
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

    const orgFormLabel = row.orgForm
      ? (ORG_FORMS.find((f) => f.value === row.orgForm)?.label ?? row.orgForm)
      : row.kind === 'entrepreneur'
        ? 'ИП'
        : null;

    // Не-плательщик НДС — осознанно-пустое (''), как у группы «Организация»
    const vat = row.vatPayer
      ? [
          row.vatSeries ? `серия ${row.vatSeries}` : null,
          row.vatNumber ? `№ ${row.vatNumber}` : null,
          row.vatDate ? `от ${row.vatDate.toISOString().slice(0, 10).split('-').reverse().join('.')}` : null,
        ]
          .filter(Boolean)
          .join(' ') || null
      : '';

    return {
      Название: row.name,
      Юрнаименование: row.legalName ?? (row.kind === 'individual' ? row.name : null),
      Юрформа: orgFormLabel,
      // БИН заполнен только у юрлица, ИИН — у ИП и физлица: чужая графа = ''
      БИН: row.kind === 'legal' ? row.bin : '',
      ИИН: row.kind === 'legal' ? '' : row.bin,
      'БИН-ИИН': row.bin,
      Юрадрес: row.legalAddress,
      // Пусто = «фактический совпадает с юридическим» — печатаем юрадрес
      'Фактический адрес': row.actualAddress ?? row.legalAddress,
      КБе: row.kbe,
      'Налоговый режим': row.taxRegime
        ? (TAX_REGIMES.find((r) => r.value === row.taxRegime)?.label ?? row.taxRegime)
        : null,
      ИИК: primaryAccount?.iban ?? null,
      Банк: primaryAccount?.bankName ?? null,
      БИК: primaryAccount?.bik ?? null,
      'Свидетельство НДС': vat,
      Руководитель: row.directorName,
      Основание: row.signBasis,
      Подписант: contact?.name ?? row.directorName,
      'Подписант Должность': contact?.position ?? (contact ? '' : row.kind === 'legal' ? 'Директор' : ''),
      'Подписант Телефон': contact?.phone ?? '',
    };
  }
}
