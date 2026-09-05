'use client';

// ============================================================
// Table / TableHeader / TableRow / TableGroupRow / TableCell — строчная таблица кита.
//
// Почему НЕ настоящий <table>: строк бывает десять тысяч, и такой список обязан
// виртуализироваться, а виртуализатору нужно самому решать, какие строки живут в
// DOM. Внутрь <tbody> это не вставить, не сломав разметку. Поэтому здесь CSS-grid
// с ролями доступности (table/row/columnheader/cell) — для скринридера это таблица,
// для виртуализатора обычный список.
//
// ДВА режима сетки:
//  • `<Table columns>` — ОБЩАЯ сетка. Контейнер держит grid-template-columns,
//    шапка и строки — subgrid'ы. Только так колонки по содержимому (`max-content`) выровнены по всей
//    таблице: у строки-сетки трек по содержимому считается по ЭТОЙ строке, и
//    чипы разной ширины разводили одну колонку соседних строк на десятки пикселей.
//    Штатный режим для всех невиртуализированных таблиц.
//  • без `<Table>` (строки получают `columns` сами) — каждая строка своя сетка.
//    Нужен только виртуализатору: Virtuoso оборачивает строки своими div'ами, и
//    subgrid до них не дотягивается. В этом режиме колонки — фиксированные px
//    либо ОДНА `fr`; `auto` разъедется.
//
// Кит виртуализацию НЕ тянет: строки рисует вызывающий (в Диске — через Virtuoso),
// а отсюда берёт разметку, выравнивание, плотность и клавиатуру.
// ============================================================
import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import { Icon } from './Icon';
import { IconButton } from './Button';
import { cx } from './tones';

export interface TableColumn {
  key: string;
  label: string;
  /**
   * Трек в grid-template (по умолчанию `minmax(0,1fr)`). Колонка «по содержимому»
   * внутри `<Table>` — `max-content`, не `auto`: в тесноте `auto` сжимается до нуля
   * и режет чипы, а `max-content` держит ширину, и таблица уходит в горизонтальный
   * скролл своей обёртки — что и нужно.
   */
  width?: string;
  align?: 'start' | 'end';
  /** Подсказка к заголовку (title): длинную расшифровку — сюда, а не в label, иначе колонка раздувается под шапку */
  title?: string;
  /** Колонка сортируемая — заголовок становится кнопкой */
  sortable?: boolean;
  /**
   * Скрывать на узком экране. Внутри `<Table>` трек такой колонки уходит из
   * шаблона целиком (ширина любая). Без `<Table>` ей нужен `width: 'auto'`: скрытая ячейка
   * перестаёт занимать место только у трека, зависящего от содержимого, — с `1fr`
   * или фиксированной шириной колонка исчезнет, а дырка от неё останется.
   */
  hideOnMobile?: boolean;
}

function template(columns: TableColumn[]): string {
  return columns.map((c) => c.width ?? 'minmax(0,1fr)').join(' ');
}

const TableCtx = createContext<TableColumn[] | null>(null);

/**
 * Колонки и шаблон строки: внутри `<Table>` шаблон отдаёт контейнер (строка —
 * subgrid), снаружи строка обязана принести `columns` сама.
 */
function useGrid(own?: TableColumn[]): { columns: TableColumn[]; rowTemplate?: string } {
  const shared = useContext(TableCtx);
  if (shared) return { columns: own ?? shared };
  if (!own) throw new Error('Строка таблицы вне <Table> обязана получить columns');
  return { columns: own, rowTemplate: template(own) };
}

export interface TableProps {
  columns: TableColumn[];
  children: ReactNode;
  /**
   * Линованная таблица: тонкие линии между строками и колонками, жирная — перед
   * строкой-группой, подсветка строки по наведению. Для плотных справочных
   * таблиц, где глаз ищет по строке и колонке (штатное расписание). По умолчанию
   * строки «воздушные», как в Диске.
   */
  lines?: boolean;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
  'aria-rowcount'?: number;
}

/**
 * Контейнер с общей сеткой колонок. Строки внутри `columns` не передают.
 * На узком экране трек колонки `hideOnMobile` не пустеет, а исчезает из
 * шаблона — иначе от него оставался бы зазор.
 */
export function Table({ columns, children, lines, className, style, ...aria }: TableProps) {
  const vars = {
    '--ui-tbl-cols': template(columns),
    '--ui-tbl-cols-sm': template(columns.filter((c) => !c.hideOnMobile)),
  } as CSSProperties;
  return (
    <TableCtx.Provider value={columns}>
      <div role="table" className={cx('ui-tbl', lines && 'ui-tbl--lines', className)} style={{ ...vars, ...style }} {...aria}>
        {children}
      </div>
    </TableCtx.Provider>
  );
}

export interface TableHeaderProps {
  /** Внутри `<Table>` не нужны */
  columns?: TableColumn[];
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  onSort?: (key: string) => void;
  className?: string;
}

/**
 * Шапка. Без `<Table>` строки живут отдельно, поэтому `role="table"` вешает
 * вызывающий на общий контейнер — иначе шапка и строки оказались бы в разных таблицах.
 */
export function TableHeader({ columns: own, sortKey, sortDir, onSort, className }: TableHeaderProps) {
  const { columns, rowTemplate } = useGrid(own);
  return (
    <div
      role="row"
      className={cx('ui-tbl-row ui-tbl-head', className)}
      style={rowTemplate ? { gridTemplateColumns: rowTemplate } : undefined}
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
            title={c.title}
            aria-sort={active ? (sortDir === 'desc' ? 'descending' : 'ascending') : undefined}
            className={cx('ui-tbl-cell', c.align === 'end' && 'ui-tbl-end', c.hideOnMobile && 'ui-tbl-hide-sm')}
          >
            <span className="ui-tbl-cellin">
              {c.sortable && onSort ? (
                <button type="button" className="ui-tbl-sortbtn" onClick={() => onSort(c.key)}>
                  {content}
                </button>
              ) : (
                content
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export interface TableRowProps {
  /** Внутри `<Table>` не нужны */
  columns?: TableColumn[];
  children: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  /** 1-based номер строки: без него виртуализированная таблица «врёт» скринридеру */
  rowIndex?: number;
  /** Итоговая строка: жирный текст, в режиме `lines` — жирная линия сверху */
  footer?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function TableRow({
  columns: own,
  children,
  selected,
  onClick,
  onDoubleClick,
  rowIndex,
  footer,
  className,
  style,
}: TableRowProps) {
  const { rowTemplate } = useGrid(own);
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
      className={cx('ui-tbl-row', selected && 'ui-tbl-selected', onClick && 'ui-tbl-clickable', footer && 'ui-tbl-foot', className)}
      style={rowTemplate ? { gridTemplateColumns: rowTemplate, ...style } : style}
    >
      {children}
    </div>
  );
}

export interface TableGroupRowProps {
  children: ReactNode;
  rowIndex?: number;
  /** Сворачиваемая группа: стрелка слева; клик по строке (мимо кнопок) переключает */
  expanded?: boolean;
  onToggle?: () => void;
  /** Что сворачиваем — подпись стрелки для скринридера: «Свернуть «Бухгалтер»» */
  toggleLabel?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * Строка-заголовок группы на всю ширину (штатная единица над своими людьми).
 * Только внутри `<Table>`. Одна ячейка с `aria-colspan` на все колонки — для
 * скринридера это по-прежнему строка той же таблицы; содержимое — flex-полоса.
 */
export function TableGroupRow({
  children,
  rowIndex,
  expanded = true,
  onToggle,
  toggleLabel,
  className,
  style,
}: TableGroupRowProps) {
  const { columns } = useGrid();
  // Клик по кнопке, ссылке или меню внутри строки — их дело, не сворачивание;
  // стрелка сама зовёт onToggle, поэтому здесь её клик тоже пропускаем.
  const onRowClick = onToggle
    ? (e: React.MouseEvent<HTMLDivElement>) => {
        if ((e.target as HTMLElement).closest('button, a, [role="menu"]')) return;
        onToggle();
      }
    : undefined;
  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      onClick={onRowClick}
      className={cx('ui-tbl-row ui-tbl-group', onToggle && 'ui-tbl-group--toggle', className)}
      style={style}
    >
      <div role="cell" aria-colspan={columns.length} className="ui-tbl-groupcell">
        {onToggle && (
          <IconButton
            icon="caretDown"
            label={`${expanded ? 'Свернуть' : 'Развернуть'} ${toggleLabel ?? 'группу'}`}
            size={28}
            round={false}
            aria-expanded={expanded}
            onClick={onToggle}
            className={cx('ui-tbl-caret', !expanded && 'ui-tbl-caret--collapsed')}
          />
        )}
        {children}
      </div>
    </div>
  );
}

export interface TableCellProps {
  /** Пустая ячейка (итоговая строка) — законна */
  children?: ReactNode;
  align?: 'start' | 'end';
  hideOnMobile?: boolean;
  className?: string;
  title?: string;
}

/**
 * Содержимое живёт во внутренней обёртке: многоточие работает только у блока с
 * текстом, а сама ячейка — flex, чтобы тянуться на высоту строки (вертикальные
 * линии режима `lines` иначе были бы короче строки) и центрировать содержимое.
 */
export function TableCell({ children, align, hideOnMobile, className, title }: TableCellProps) {
  return (
    <div
      role="cell"
      title={title}
      className={cx('ui-tbl-cell', align === 'end' && 'ui-tbl-end', hideOnMobile && 'ui-tbl-hide-sm', className)}
    >
      <span className="ui-tbl-cellin">{children}</span>
    </div>
  );
}
