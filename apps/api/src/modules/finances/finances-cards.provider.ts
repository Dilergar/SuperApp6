import { Injectable, OnModuleInit } from '@nestjs/common';
import type { RichCardField, RichCardPayload } from '@superapp/shared';
import { RichCardRegistry } from '../../core/rich-cards/rich-cards.registry';
import { QuickActionRegistry } from '../../core/quick-actions/quick-actions.registry';
import type { RichCardDeps } from '../../core/rich-cards/rich-card.types';
import { FinancesService } from './finances.service';

const SYMBOLS: Record<string, string> = { KZT: '₸', USD: '$', EUR: '€', RUB: '₽' };
const money = (minor: number | bigint, code: string): string =>
  `${(Number(minor) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${SYMBOLS[code] ?? code}`;
const dateHuman = (d: Date): string =>
  d.toISOString().slice(0, 10).split('-').reverse().join('.');

const TYPE_TITLES: Record<string, string> = {
  expense: 'Расход',
  income: 'Доход',
  transfer: 'Перевод',
  debt_payment: 'Платёж по долгу',
  debt_draw: 'Кредит',
  opening: 'Корректировка остатка',
};

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
  ) {}

  onModuleInit() {
    this.richCards.registerRenderer('fin_transaction', (deps, viewerId, refId) =>
      this.renderTransaction(deps, viewerId, refId),
    );
    this.richCards.registerRenderer('fin_month', (deps, viewerId, refId) =>
      this.renderMonth(deps, viewerId, refId),
    );
    this.quickActions.register({
      key: 'finance.add-expense',
      label: 'Записать расход',
      icon: '💸',
      scopes: ['composer'],
      description: 'Трата — в вашу книгу Финансов, карточка — в чат',
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

    const sign = type === 'expense' || type === 'debt_payment' ? '−' : type === 'income' || type === 'debt_draw' ? '+' : '';
    const fields: RichCardField[] = [
      { label: 'Сумма', value: `${sign}${money(tx.amount, tx.currencyCode)}` },
      ...(tx.amountTo != null ? [{ label: 'Зачислено', value: money(tx.amountTo, tx.toAccount.currencyCode) }] : []),
      {
        label: type === 'income' ? 'На счёт' : 'Счёт',
        value: type === 'income' ? tx.toAccount.name : tx.fromAccount.name,
      },
      ...(type === 'transfer' ? [{ label: 'Куда', value: tx.toAccount.name }] : []),
      { label: 'Дата', value: dateHuman(tx.occurredOn) },
      ...(tx.personName ? [{ label: type === 'income' ? 'От кого' : 'На кого', value: tx.personName }] : []),
      ...(author ? [{ label: 'Записал(а)', value: `${author.firstName} ${author.lastName ?? ''}`.trim() }] : []),
    ];

    return {
      kind: 'rich_card',
      cardType: 'fin_transaction',
      ref: { type: 'fin_transaction', id: tx.id },
      title: category ? `${TYPE_TITLES[type]} · ${category.name}` : TYPE_TITLES[type] ?? 'Операция',
      subtitle: tx.note,
      icon: category?.icon ?? (type === 'transfer' ? '🔁' : '💸'),
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

    const joinSums = (sums: Array<{ currencyCode: string; amount: number }>): string =>
      sums.length ? sums.map((s) => money(s.amount, s.currencyCode)).join(' · ') : '—';

    const fields: RichCardField[] = [
      { label: 'Расходы', value: `−${joinSums(report.totalExpense)}` },
      { label: 'Доходы', value: `+${joinSums(report.totalIncome)}` },
      ...(report.debtPayments.length ? [{ label: 'Платежи по долгам', value: joinSums(report.debtPayments) }] : []),
      ...topSpends.map((t, i) => {
        const cat = catNames.get(t.categoryId);
        return {
          label: i === 0 ? 'Топ трат' : ' ',
          value: `${cat?.icon ? `${cat.icon} ` : ''}${cat?.name ?? 'Категория'} — ${money(t.amount, t.currencyCode)}`,
        };
      }),
    ];

    const label = new Date(`${period}-01T00:00:00Z`).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
    return {
      kind: 'rich_card',
      cardType: 'fin_month',
      ref: { type: 'fin_month', id: refId },
      title: `Итоги: ${label}`,
      subtitle: null,
      icon: '📊',
      fields,
      status: null,
      actions: [],
      href: '/finance',
    };
  }
}
