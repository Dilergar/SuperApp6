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
  TableHeader,
  TableRow,
  type TableColumn,
} from '@/components/ui';
import { driveIcon, humanSize, shortDate } from './drive-ui';

const COLUMNS: TableColumn[] = [
  { key: 'name', label: 'Название' },
  { key: 'size', label: 'Размер', width: 'auto', align: 'end', hideOnMobile: true },
  { key: 'date', label: 'Изменён', width: 'auto', align: 'end', hideOnMobile: true },
  { key: 'actions', label: '', width: 'auto', align: 'end' },
];

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
  if (loading) {
    return (
      <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}>
        <Spinner />
      </div>
    );
  }
  if (!nodes?.length) return <EmptyState icon={emptyIcon} title={emptyTitle} description={emptyText} />;

  return (
    <div role="table" aria-rowcount={nodes.length + 1}>
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
              {node.systemKey && <Chip tone="neutral">системная</Chip>}
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
    </div>
  );
}

export { Button };
