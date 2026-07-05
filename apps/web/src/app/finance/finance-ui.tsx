'use client';

// ============================================================
// Общие мини-виджеты финансов — используются и «Отчётами» (BudgetLine),
// и «Обзором»: одна точка правды для порогов/цветов лимита.
// ============================================================

/** Пороги лимита — синхронны с бэкенд-уведомлениями 80%/100%. */
export function budgetProgress(spent: number, amount: number): {
  pct: number;
  over: boolean;
  warn: boolean;
  color: string;
} {
  const pct = amount > 0 ? Math.round((spent / amount) * 100) : 0;
  const over = spent > amount;
  const warn = !over && spent >= amount * 0.8;
  return { pct, over, warn, color: over ? 'var(--danger)' : warn ? 'var(--warning)' : 'var(--success)' };
}

/** Полоска план-факта лимита. */
export function BudgetBar({ spent, amount, small }: { spent: number; amount: number; small?: boolean }) {
  const { pct, color } = budgetProgress(spent, amount);
  return (
    <div style={{ height: small ? 5 : 7, background: 'var(--surface-container-high)', borderRadius: 999, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: color, borderRadius: 999, transition: 'width 0.3s ease' }} />
    </div>
  );
}
