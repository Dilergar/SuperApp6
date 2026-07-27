'use client';

// ============================================================
// Pagination — постраничная навигация.
// Стрелки клампятся по границам; строка «Страница X из N» справа.
// На узких ширинах ряд переносится (flex-wrap), а не обрезается.
// ============================================================
import { Icon } from './Icon';
import { cx } from './tones';

export interface PaginationProps {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  /** Сколько номеров показывать вокруг текущего (окно). */
  window?: number;
  showSummary?: boolean;
  className?: string;
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

/** Номера страниц с многоточиями: 1 … 4 5 6 … 20 */
function buildPages(page: number, count: number, win: number): Array<number | '…'> {
  if (count <= win * 2 + 5) return Array.from({ length: count }, (_, i) => i + 1);
  const out: Array<number | '…'> = [1];
  const from = Math.max(2, page - win);
  const to = Math.min(count - 1, page + win);
  if (from > 2) out.push('…');
  for (let i = from; i <= to; i += 1) out.push(i);
  if (to < count - 1) out.push('…');
  out.push(count);
  return out;
}

export function Pagination({ page, pageCount, onChange, window: win = 1, showSummary = true, className }: PaginationProps) {
  if (pageCount <= 1) return null;
  const go = (p: number) => onChange(clamp(p, 1, pageCount));
  const pages = buildPages(page, pageCount, win);

  return (
    <nav
      className={cx(className)}
      aria-label="Постраничная навигация"
      style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flexWrap: 'wrap' }}
    >
      <button
        type="button"
        className="ui-page-btn ui-page-btn--outline"
        onClick={() => go(page - 1)}
        disabled={page <= 1}
        aria-label="Предыдущая страница"
      >
        <Icon name="caretLeft" size={15} />
      </button>

      {pages.map((p, i) =>
        p === '…' ? (
          <span key={`gap-${i}`} style={{ color: 'var(--label)', padding: '0 0.25rem', fontWeight: 700 }}>…</span>
        ) : (
          <button
            key={p}
            type="button"
            className="ui-page-btn"
            aria-current={p === page ? 'page' : undefined}
            aria-label={`Страница ${p}`}
            onClick={() => go(p)}
          >
            {p}
          </button>
        ),
      )}

      <button
        type="button"
        className="ui-page-btn ui-page-btn--outline"
        onClick={() => go(page + 1)}
        disabled={page >= pageCount}
        aria-label="Следующая страница"
      >
        <Icon name="caretRight" size={15} />
      </button>

      {showSummary && (
        <span className="meta" style={{ marginLeft: 'auto', paddingLeft: '0.75rem' }}>
          Страница {page} из {pageCount}
        </span>
      )}
    </nav>
  );
}
