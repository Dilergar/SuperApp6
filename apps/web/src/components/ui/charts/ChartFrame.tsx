'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '../Button';
import { Table, TableCell, TableHeader, TableRow } from '../Table';

export interface ChartTable {
  columns: string[];
  rows: Array<{ key: string; cells: ReactNode[] }>;
}

/**
 * Рамка графика: у КАЖДОГО графика есть таблица-дублёр. Невидимой она доступна
 * скринридеру всегда, кнопкой «таблицей» — глазу. Всплывашка значения не единственный
 * путь к числу (правило: подсказка дополняет, а не запирает).
 */
export function ChartFrame({ children, table, caption, dimmed }: { children: ReactNode; table: ChartTable; caption: string; dimmed?: boolean }) {
  const t = useTranslations('common');
  const [asTable, setAsTable] = useState(false);
  const columns = table.columns.map((label, i) => ({ key: String(i), label, align: i === 0 ? ('start' as const) : ('end' as const), width: i === 0 ? 'minmax(8rem, 1.4fr)' : 'minmax(4rem, 1fr)' }));
  return (
    <div className={dimmed ? 'ui-chart-refetch' : undefined}>
      {asTable ? (
        <div style={{ overflowX: 'auto' }}>
          <Table columns={columns} lines>
            <TableHeader columns={columns} />
            {table.rows.map((r) => (
              <TableRow key={r.key}>
                {r.cells.map((c, i) => (
                  <TableCell key={i} align={i === 0 ? 'start' : 'end'}>{c}</TableCell>
                ))}
              </TableRow>
            ))}
          </Table>
        </div>
      ) : (
        <>
          {children}
          {/* Обёртка обязательна: `width: 1px` на самой <table> не действует (таблица растёт по
              содержимому) — скрытый дублёр раздувал страницу и давал горизонтальный скролл на 375px */}
          <div className="ui-sr-only">
            <table>
              <caption>{caption}</caption>
              <thead>
                <tr>
                  {table.columns.map((c, i) => (
                    <th key={i} scope="col">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r) => (
                  <tr key={r.key}>
                    {r.cells.map((c, i) => (i === 0 ? <th key={i} scope="row">{c}</th> : <td key={i}>{c}</td>))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--spacing-2)' }}>
        <Button size="sm" variant="ghost" icon={asTable ? 'chart' : 'table'} onClick={() => setAsTable((v) => !v)}>
          {asTable ? t('charts.showChart') : t('charts.showTable')}
        </Button>
      </div>
    </div>
  );
}
