'use client';

// Корзина сервиса — общая таблица для Задач, Календаря и Диктофона (образец — корзина
// Диска): название, когда удалено, когда уйдёт навсегда, «Восстановить» / «Удалить
// навсегда» (с подтверждением). Слова — каталог `common.trash.*`; своё у сервиса —
// заголовок, подсказка и текст подтверждения окончательного удаления.

import { useTranslations } from 'next-intl';
import {
  Button,
  EmptyState,
  Icon,
  Spinner,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  useConfirm,
  type IconName,
  type TableColumn,
} from '@/components/ui';
import { useShortDate } from '@/lib/format';
import { toastApiError } from '@/lib/api-errors';
import { toast } from '@/lib/toast';

export interface TrashRow {
  id: string;
  title: string;
  icon: IconName;
  /** Вторая строка: подзадачи, «серия», длительность — своё у сервиса */
  meta?: React.ReactNode;
  deletedAt: string;
  purgeAt: string;
}

export interface TrashTableProps {
  rows: TrashRow[] | undefined;
  loading?: boolean;
  /** Подтверждение «навсегда»: заголовок и текст — слова сервиса */
  purgeConfirm: (row: TrashRow) => { title: string; message: string };
  onRestore: (row: TrashRow) => Promise<unknown>;
  onPurge: (row: TrashRow) => Promise<unknown>;
  /** Перечитать списки после действия (инвалидация ключей сервиса) */
  onChanged: () => void;
}

export function TrashTable({ rows, loading, purgeConfirm, onRestore, onPurge, onChanged }: TrashTableProps) {
  const t = useTranslations('common');
  const shortDate = useShortDate();
  const [confirm, confirmUI] = useConfirm();
  const columns: TableColumn[] = [
    { key: 'name', label: t('trash.colName') },
    { key: 'deleted', label: t('trash.colDeleted'), width: 'auto', align: 'end', hideOnMobile: true },
    { key: 'purge', label: t('trash.colPurge'), width: 'auto', align: 'end', hideOnMobile: true },
    { key: 'actions', label: '', width: 'auto', align: 'end' },
  ];

  if (loading) {
    return (
      <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}>
        <Spinner />
      </div>
    );
  }
  if (!rows?.length) return <EmptyState icon="delete" title={t('trash.empty')} />;

  const restore = (row: TrashRow) =>
    void onRestore(row)
      .then(() => {
        toast(t('trash.restored', { name: row.title }), 'success');
        onChanged();
      })
      .catch((e) => toastApiError(e));

  const purge = (row: TrashRow) =>
    confirm({ ...purgeConfirm(row), confirmLabel: t('trash.purge'), danger: true }, async () => {
      await onPurge(row);
      onChanged();
    });

  return (
    <>
      <Table columns={columns} aria-rowcount={rows.length + 1}>
        <TableHeader columns={columns} />
        {rows.map((row, i) => (
          <TableRow key={row.id} columns={columns} rowIndex={i + 2}>
            <TableCell title={row.title}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <Icon name={row.icon} size={18} style={{ color: 'var(--primary-dim)', flexShrink: 0 }} />
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.title}</span>
                  {row.meta && <span className="label-sm" style={{ color: 'var(--on-surface-variant)' }}>{row.meta}</span>}
                </span>
              </span>
            </TableCell>
            <TableCell align="end" hideOnMobile>{shortDate(row.deletedAt)}</TableCell>
            <TableCell align="end" hideOnMobile>{shortDate(row.purgeAt)}</TableCell>
            <TableCell align="end">
              <span style={{ display: 'inline-flex', gap: 6 }}>
                <Button variant="outline" size="sm" icon="restore" onClick={() => restore(row)}>
                  {t('trash.restore')}
                </Button>
                <Button variant="matte" tone="danger" size="sm" onClick={() => purge(row)}>
                  {t('trash.purge')}
                </Button>
              </span>
            </TableCell>
          </TableRow>
        ))}
      </Table>
      {confirmUI}
    </>
  );
}
