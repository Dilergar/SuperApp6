'use client';

// Простой список объектов для сквозных разделов («Избранное», «Недавние», «Корзина»,
// «Доступно мне»). Виртуализация здесь не нужна: все три списка ограничены страницей.

import type { DriveNodeDto } from '@superapp/shared';
import {
  Button,
  Chip,
  EmptyState,
  Icon,
  Spinner,
  TableCell,
  Table,
  TableHeader,
  TableRow,
  type TableColumn,
} from '@/components/ui';
import { useTranslations } from 'next-intl';
import { useBytes, useShortDate } from '@/lib/format';
import { driveIcon } from './drive-ui';

/** Колонки таблицы: заголовки — ключи каталога, слово подставляет компонент. */
const COLUMN_KEYS = [
  { key: 'name', labelKey: 'browser.colName' },
  { key: 'size', labelKey: 'browser.colSize', width: 'auto', align: 'end', hideOnMobile: true },
  { key: 'date', labelKey: 'browser.colUpdated', width: 'auto', align: 'end', hideOnMobile: true },
  { key: 'actions', labelKey: null, width: 'auto', align: 'end' },
] as const;

export interface DriveNodeListProps {
  nodes: DriveNodeDto[] | undefined;
  loading?: boolean;
  emptyTitle: string;
  emptyText?: string;
  emptyIcon?: 'folder' | 'star' | 'clock' | 'delete' | 'share';
  /** Действия строки (например «Восстановить» / «Удалить навсегда» в корзине) */
  renderActions?: (node: DriveNodeDto) => React.ReactNode;
  onOpen?: (node: DriveNodeDto) => void;
}

export function DriveNodeList({
  nodes,
  loading,
  emptyTitle,
  emptyText,
  emptyIcon = 'folder',
  renderActions,
  onOpen,
}: DriveNodeListProps) {
  const t = useTranslations('drive');
  const humanSize = useBytes();
  const shortDate = useShortDate();
  const COLUMNS: TableColumn[] = COLUMN_KEYS.map((c) => ({ ...c, label: c.labelKey ? t(c.labelKey) : '' }));
  if (loading) {
    return (
      <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}>
        <Spinner />
      </div>
    );
  }
  if (!nodes?.length) return <EmptyState icon={emptyIcon} title={emptyTitle} description={emptyText} />;

  return (
    <Table columns={COLUMNS} aria-rowcount={nodes.length + 1}>
      <TableHeader columns={COLUMNS} />
      {nodes.map((node, i) => (
        <TableRow
          key={node.id}
          columns={COLUMNS}
          rowIndex={i + 2}
          onClick={onOpen ? () => onOpen(node) : undefined}
        >
          <TableCell title={node.name}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <Icon name={driveIcon(node)} size={18} style={{ color: 'var(--primary-dim)', flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
              {node.systemKey && <Chip tone="neutral">{t('systemFolder.chip')}</Chip>}
            </span>
          </TableCell>
          <TableCell align="end" hideOnMobile>
            {node.subtreeBytes === null ? '—' : humanSize(node.subtreeBytes)}
          </TableCell>
          <TableCell align="end" hideOnMobile>
            {shortDate(node.trashedAt ?? node.updatedAt)}
          </TableCell>
          <TableCell align="end">
            <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', gap: 6 }}>
              {renderActions?.(node)}
            </span>
          </TableCell>
        </TableRow>
      ))}
    </Table>
  );
}

export { Button };
