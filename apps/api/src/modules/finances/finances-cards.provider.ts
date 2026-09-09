import { Injectable, OnModuleInit } from '@nestjs/common';
import { glyphPrefix, type RichCardField, type RichCardPayload } from '@superapp/shared';
import { RichCardRegistry } from '../../core/rich-cards/rich-cards.registry';
import { QuickActionRegistry } from '../../core/quick-actions/quick-actions.registry';
import { I18nService } from '../../shared/i18n/i18n.service';
import type { RichCardDeps } from '../../core/rich-cards/rich-card.types';
import { FinancesService } from './finances.service';

const SYMBOLS: Record<string, string> = { KZT: '₸', USD: '$', EUR: '€', RUB: '₽' };

/**
 * Финансы × чат (Принцип 3): rich-card рендереры + quick action «Записать расход».
 * Карточки — СНИМКИ (модель Splitwise): shareToChat рендерит от имени шарящего и кладёт
 * payload в сообщение — получатель видит снимок БЕЗ доступа к книге; живой рендер (и,
 * значит, кнопка «Открыть в Финансах») работает только у тех, кому книга доступна.
 * Кнопок-действий у карточек нет — финансы приватны, действия только внутри /finance.
 */
@Injectable()
export class FinancesCardsProvider implements OnModuleInit {
  constructor(
    private readonly richCards: RichCardRegistry,
    private readonly quickActions: QuickActionRegistry,
    private readonly finances: FinancesService,
    private readonly i18n: I18nService,
  ) {}

  /** Деньги словами языка зрителя: знак валюты — из кода счёта, а не из региона. */
  private money(minor: number | bigint, code: string): string {
    return this.i18n.format().money(Number(minor), { scale: 2, symbol: SYMBOLS[code] ?? code });
  }

  onModuleInit() {
    this.richCards.registerRenderer('fin_transaction', (deps, viewerId, refId) =>
      this.renderTransaction(deps, viewerId, refId),
    );
    this.richCards.registerRenderer('fin_month', (deps, viewerId, refId) =>
      this.renderMonth(deps, viewerId, refId),
    );
    this.quickActions.register({
      key: 'finance.add-expense',
      labelKey: 'finance.quickAction.label',
      icon: '💸',
      scopes: ['composer'],
      descriptionKey: 'finance.quickAction.description',
    });
  }

  private async renderTransaction(deps: RichCardDeps, viewerId: string, refId: string): Promise<RichCardPayload | null> {
    const tx = await deps.db.finTransaction.findFirst({
      where: { id: refId, deletedAt: null },
      include: { fromAccount: true, toAccount: true },
    });
    if (!tx) return null;
    if (!(await this.finances.canViewBook(viewerId, tx.bookId))) return null;

    const kinds = { from: tx.fromAccount.kind, to: tx.toAccount.kind };
    let type = 'transfer';
    if ((kinds.from === 'asset' || kinds.from === 'liability') && kinds.to === 'expense') type = 'expense';
    else if (kinds.from === 'income') type = 'income';
    else if (kinds.from === 'asset' && kinds.to === 'liability') type = 'debt_payment';
    else if (kinds.from === 'liability' && kinds.to === 'asset') type = 'debt_draw';
    else if (kinds.from === 'equity' || kinds.to === 'equity') type = 'opening';

    const category = type === 'expense' ? tx.toAccount : type === 'income' ? tx.fromAccount : null;
    const author = await deps.db.user.findUnique({
      where: { id: tx.createdById },
      select: { firstName: true, lastName: true },
    });

    const t = (key: string) => this.i18n.translate(key);
    const sign = type === 'expense' || type === 'debt_payment' ? '−' : type === 'income' || type === 'debt_draw' ? '+' : '';
    const fields: RichCardField[] = [
      { label: t('finance.card.amount'), value: `${sign}${this.money(tx.amount, tx.currencyCode)}` },
      ...(tx.amountTo != null
        ? [{ label: t('finance.card.credited'), value: this.money(tx.amountTo, tx.toAccount.currencyCode) }]
        : []),
      {
        label: t(type === 'income' ? 'finance.card.toAccount' : 'finance.card.account'),
        value: type === 'income' ? tx.toAccount.name : tx.fromAccount.name,
      },
      ...(type === 'transfer' ? [{ label: t('finance.card.destination'), value: tx.toAccount.name }] : []),
      { label: t('finance.card.date'), value: this.i18n.format().date(tx.occurredOn) },
      ...(tx.personName
        ? [{ label: t(type === 'income' ? 'finance.card.fromWhom' : 'finance.card.toWhom'), value: tx.personName }]
        : []),
      ...(author
        ? [{ label: t('finance.card.recordedBy'), value: `${author.firstName} ${author.lastName ?? ''}`.trim() }]
        : []),
    ];

    // Заголовок собирается по ВИДУ операции: ключ собирается от того же слова, что и ветка выше.
    const typeTitle = t(`finance.txType.${type}`);
    return {
      kind: 'rich_card',
      cardType: 'fin_transaction',
      ref: { type: 'fin_transaction', id: tx.id },
      title: category ? `${typeTitle} · ${category.name}` : typeTitle,
      subtitle: tx.note,
      icon: category?.icon ?? (type === 'transfer' ? 'refresh' : 'finance'),  // фолбэк — имя иконки кита, эмодзи категории остаётся как есть
      fields,
      status: null,
      actions: [],
      href: '/finance',
    };
  }

  /** refId = `<bookId>:<YYYY-MM>` — «Итоги месяца» для семейного чата. */
  private async renderMonth(deps: RichCardDeps, viewerId: string, refId: string): Promise<RichCardPayload | null> {
    const sep = refId.lastIndexOf(':');
    if (sep < 0) return null;
    const bookId = refId.slice(0, sep);
    const period = refId.slice(sep + 1);
    if (!/^\d{4}-\d{2}$/.test(period)) return null;
    if (!(await this.finances.canViewBook(viewerId, bookId))) return null;

    let report;
    try {
      report = await this.finances.getMonthReport(viewerId, period, bookId);
    } catch {
      return null;
    }

    // Топ-3 категории по тратам (первая валюта каждой категории; имена — одним запросом).
    const topSpends = [...report.expenseByCategory].sort((a, b) => b.amount - a.amount).slice(0, 3);
    const catNames = new Map<string, { name: string; icon: string | null }>();
    if (topSpends.length) {
      const cats = await deps.db.finAccount.findMany({
        where: { id: { in: topSpends.map((t) => t.categoryId) } },
        select: { id: true, name: true, icon: true },
      });
      for (const c of cats) catNames.set(c.id, { name: c.name, icon: c.icon });
    }

    const t = (key: string, values?: Record<string, string>) => this.i18n.translate(key, values);
    const joinSums = (sums: Array<{ currencyCode: string; amount: number }>): string =>
      sums.length ? sums.map((s) => this.money(s.amount, s.currencyCode)).join(' · ') : '—';

    const fields: RichCardField[] = [
      { label: t('finance.card.expenses'), value: `−${joinSums(report.totalExpense)}` },
      { label: t('finance.card.incomes'), value: `+${joinSums(report.totalIncome)}` },
      ...(report.debtPayments.length
        ? [{ label: t('finance.card.debtPayments'), value: joinSums(report.debtPayments) }]
        : []),
      ...topSpends.map((s, i) => {
        const cat = catNames.get(s.categoryId);
        return {
          label: i === 0 ? t('finance.card.topSpending') : ' ',
          // Значок в СТРОКЕ: печатать значение как есть нельзя — у него бывает
          // пометка набора ('fl:1f697'). glyphPrefix отдаёт символ или пустоту.
          value: `${glyphPrefix(cat?.icon)}${cat?.name ?? t('finance.card.category')} — ${this.money(s.amount, s.currencyCode)}`,
        };
      }),
    ];

    const label = this.i18n.format().date(`${period}-01`, 'monthYear');
    return {
      kind: 'rich_card',
      cardType: 'fin_month',
      ref: { type: 'fin_month', id: refId },
      title: t('finance.card.monthTotals', { period: label }),
      subtitle: null,
      icon: '📊',
      fields,
      status: null,
      actions: [],
      href: '/finance',
    };
  }
}
