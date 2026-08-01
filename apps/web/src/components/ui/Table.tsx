'use client';

// ============================================================
// TableHeader / TableRow / TableCell — строчная таблица кита.
//
// Почему НЕ настоящий <table>: строк бывает десять тысяч, и такой список обязан
// виртуализироваться, а виртуализатору нужно самому решать, какие строки живут в
// DOM. Внутрь <tbody> это не вставить, не сломав разметку. Поэтому здесь CSS-grid
// с ролями доступности (table/row/columnheader/cell) — для скринридера это таблица,
// для виртуализатора обычный список.
//
// Кит виртуализацию НЕ тянет: строки рисует вызывающий (в Диске — через Virtuoso),
// а отсюда берёт разметку, выравнивание, плотность и клавиатуру.
// ============================================================
import type { CSSProperties, ReactNode } from 'react';
import { Icon } from './Icon';
import { cx } from './tones';

export interface TableColumn {
  key: string;
  label: string;
  /** Доля ширины в grid-template (по умолчанию `minmax(0,1fr)`) */
  width?: string;
  align?: 'start' | 'end';
  /** Колонка сортируемая — заголовок становится кнопкой */
  sortable?: boolean;
  /**
   * Скрывать на узком экране. Такой колонке нужен `width: 'auto'`: скрытая ячейка
   * перестаёт занимать место только у трека, зависящего от содержимого, — с `1fr`
   * или фиксированной шириной колонка исчезнет, а дырка от неё останется.
   */
  hideOnMobile?: boolean;
}

function template(columns: TableColumn[]): string {
  return columns.map((c) => c.width ?? 'minmax(0,1fr)').join(' ');
}

export interface TableHeaderProps {
  columns: TableColumn[];
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  onSort?: (key: string) => void;
  className?: string;
}

/**
 * Шапка. Строки живут отдельно, поэтому `role="table"` вешает вызывающий на общий
 * контейнер — иначе шапка и строки оказались бы в разных таблицах.
 */
export function TableHeader({ columns, sortKey, sortDir, onSort, className }: TableHeaderProps) {
  return (
    <div
      role="row"
      className={cx('ui-tbl-row ui-tbl-head', className)}
      style={{ gridTemplateColumns: template(columns) }}
    >
      {columns.map((c) => {
        const active = sortKey === c.key;
        const content = (
          <>
            {c.label}
            {active && (
              <Icon name={sortDir === 'desc' ? 'arrowDown' : 'arrowUp'} size={12} className="ui-tbl-sort" />
            )}
          </>
        );
        return (
          <div
            key={c.key}
            role="columnheader"
            aria-sort={active ? (sortDir === 'desc' ? 'descending' : 'ascending') : undefined}
            className={cx('ui-tbl-cell', c.align === 'end' && 'ui-tbl-end', c.hideOnMobile && 'ui-tbl-hide-sm')}
          >
            {c.sortable && onSort ? (
              <button type="button" className="ui-tbl-sortbtn" onClick={() => onSort(c.key)}>
                {content}
              </button>
            ) : (
              content
            )}
          </div>
        );
      })}
    </div>
  );
}

export interface TableRowProps {
  columns: TableColumn[];
  children: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  /** 1-based номер строки: без него виртуализированная таблица «врёт» скринридеру */
  rowIndex?: number;
  className?: string;
  style?: CSSProperties;
}

export function TableRow({
  columns,
  children,
  selected,
  onClick,
  onDoubleClick,
  rowIndex,
  className,
  style,
}: TableRowProps) {
  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      aria-selected={selected}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (onDoubleClick ?? onClick)();
              }
            }
          : undefined
      }
      className={cx('ui-tbl-row', selected && 'ui-tbl-selected', onClick && 'ui-tbl-clickable', className)}
      style={{ gridTemplateColumns: template(columns), ...style }}
    >
      {children}
    </div>
  );
}

export interface TableCellProps {
  children: ReactNode;
  align?: 'start' | 'end';
  hideOnMobile?: boolean;
  className?: string;
  title?: string;
}

export function TableCell({ children, align, hideOnMobile, className, title }: TableCellProps) {
  return (
    <div
      role="cell"
      title={title}
      className={cx('ui-tbl-cell', align === 'end' && 'ui-tbl-end', hideOnMobile && 'ui-tbl-hide-sm', className)}
    >
      {children}
    </div>
  );
}
