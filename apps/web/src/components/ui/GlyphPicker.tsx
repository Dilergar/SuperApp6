'use client';

// ============================================================
// Выбор значка — ОДИН на всё приложение (категории, валюта, витрины, лоты,
// хотелки, Группы, эмодзи в чате).
//
// Три каталога рядом: наши предметные иконки, эмодзи «Свои» (картинки) и
// эмодзи Noto (шрифт). Просмотр — по одному каталогу, ПОИСК — сразу по всем
// трём: набрал «машина» и видишь все варианты, берёшь тот, что нравится.
// Набор запоминается у каждого значка, глобального переключателя нет.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, IconButton } from './Button';
import { Chip } from './Chip';
import { Glyph } from './Glyph';
import { Icon } from './Icon';
import { Field, SearchField } from './Input';
import { SegmentedControl } from './Tabs';
import { usePopover } from './usePopover';
import {
  browseGlyphs, charToHex, GLYPH_PREFIX, loadGlyphIndex, parseGlyph, pushRecentGlyph,
  recentGlyphs, searchGlyphs, type GlyphHit, type GlyphIndex,
} from './glyph-data';

type Mode = 'icons' | 'fluent' | 'noto';

const MODE_ITEMS: Array<{ key: Mode; label: string }> = [
  { key: 'icons', label: 'Иконки' },
  { key: 'fluent', label: 'Свои' },
  { key: 'noto', label: 'Noto' },
];

export interface GlyphPickerProps {
  value?: string | null;
  onSelect: (value: string) => void;
  /** Показать «Убрать значок» (в формах значок необязателен). */
  onRemove?: () => void;
  /**
   * Показать ровно один каталог, без переключателя. Чат берёт 'noto': в текст
   * вставляется САМ символ, и рисовать его будет шрифт Noto — сетка Fluent там
   * обещала бы другую картинку, чем человек получит в сообщении.
   */
  only?: Mode;
  /** Подставить в поиск при открытии — обычно название сущности. */
  suggest?: string;
  /** Не закрывать после выбора (набор нескольких эмодзи в сообщение). */
  keepOpen?: boolean;
  onClose?: () => void;
}

/** Панель выбора. Позиционированием занимается обёртка (поповер). */
export function GlyphPicker({ value, onSelect, onRemove, only, suggest, keepOpen, onClose }: GlyphPickerProps) {
  const [index, setIndex] = useState<GlyphIndex | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  // Открываемся на том каталоге, из которого нынешний значок: человек чаще
  // меняет «на другую такую же», чем перескакивает между наборами.
  const [mode, setMode] = useState<Mode>(() => {
    if (only) return only;
    const g = parseGlyph(value);
    if (g.kind === 'image') return 'fluent';
    if (g.kind === 'text') return 'noto';
    return 'icons';
  });
  const [group, setGroup] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setRecent(recentGlyphs()); }, []);

  useEffect(() => {
    let alive = true;
    loadGlyphIndex().then(
      (i) => { if (alive) setIndex(i); },
      () => { if (alive) setFailed(true); },
    );
    return () => { alive = false; };
  }, []);

  // Подсказка по названию сущности («Питомцы» → сразу животные). Ставим ТОЛЬКО
  // если она что-то находит: пустая выдача при открытии выглядит как поломка.
  const suggestedRef = useRef(false);
  useEffect(() => {
    if (!index || suggestedRef.current) return;
    suggestedRef.current = true;
    const s = (suggest ?? '').trim();
    if (!s) return;
    const r = searchGlyphs(index, s, 1);
    if (r.icons.length || r.fluent.length || r.noto.length) setQuery(s);
  }, [index, suggest]);

  const searching = query.trim().length > 0;
  const results = useMemo(
    () => (index && searching ? searchGlyphs(index, query) : null),
    [index, query, searching],
  );

  const groups = index ? (mode === 'icons' ? index.iconGroups : index.emojiGroups) : [];
  useEffect(() => { setGroup(0); }, [mode]);

  const browse = useMemo(
    () => (index && !searching ? browseGlyphs(index, mode, group) : []),
    [index, mode, group, searching],
  );

  // «Недавние» в режиме одного каталога приводим К НЕМУ: в чате значок из
  // набора «Свои» — картинка, вставить её в текст нельзя, а тот же символ из
  // Noto вставляется. Что не переводится (наши иконки) — прячем.
  const shownRecent = useMemo(() => {
    if (!only) return recent;
    const covered = new Set(index?.emoji.filter((e) => e[5]).map((e) => e[0]) ?? []);
    const out: string[] = [];
    for (const v of recent) {
      const g = parseGlyph(v);
      if (g.kind === 'object') continue;
      if (only === 'noto') {
        out.push(v.startsWith(GLYPH_PREFIX.fluent) ? GLYPH_PREFIX.noto + v.slice(3) : v);
      } else if (only === 'fluent') {
        const hex = v.startsWith(GLYPH_PREFIX.noto) ? v.slice(3) : g.kind === 'text' ? charToHex(g.char) : '';
        if (hex && covered.has(hex)) out.push(GLYPH_PREFIX.fluent + hex);
        else if (v.startsWith(GLYPH_PREFIX.fluent)) out.push(v);
      } else {
        out.push(v);
      }
    }
    return [...new Set(out)];
  }, [only, recent, index]);

  const pick = useCallback((v: string) => {
    pushRecentGlyph(v);
    setRecent(recentGlyphs());
    onSelect(v);
    if (!keepOpen) onClose?.();
  }, [keepOpen, onClose, onSelect]);

  // Клавиатура по сетке — «бегущий фокус»: Tab заводит в неё ОДИН раз, дальше
  // стрелки. Иначе Tab пришлось бы жать до 380 раз (столько значков в
  // категории), и добраться до кнопок под сеткой было бы нельзя.
  const cellsOf = () => Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>('button[data-cell]') ?? []);

  useEffect(() => {
    const cells = cellsOf();
    cells.forEach((c, i) => { c.tabIndex = i === 0 ? 0 : -1; });
  }, [browse, results, shownRecent]);

  const onGridKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const cells = cellsOf();
    const at = cells.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0 || !cells.length) return;
    e.preventDefault();
    const w = cells[0].getBoundingClientRect().width;
    const cols = Math.max(1, Math.round((gridRef.current?.clientWidth ?? w) / (w + 2)));
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? cols : e.key === 'ArrowUp' ? -cols : 0;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? cells.length - 1 : Math.min(cells.length - 1, Math.max(0, at + step));
    cells[at].tabIndex = -1;
    cells[next].tabIndex = 0;
    cells[next].focus();
  };

  const cell = (hit: GlyphHit) => (
    <button
      key={hit.value}
      type="button"
      data-cell
      className="ui-glyph-cell"
      data-selected={hit.value === value ? 'true' : 'false'}
      title={hit.label}
      aria-label={hit.label}
      onClick={() => pick(hit.value)}
    >
      <Glyph value={hit.value} size={24} />
    </button>
  );

  // Срез выдачи показываем числом: «Noto · 48 из 214» честнее, чем молча
  // обрезанная сетка, по которой не понять, искать дальше или уточнять запрос.
  const section = (title: string, hits: GlyphHit[], total: number) => (hits.length ? (
    <div key={title}>
      <div className="label-caps" style={{ margin: '0.5rem 0 0.25rem' }}>
        {title}{total > hits.length ? ` · ${hits.length} из ${total}` : ''}
      </div>
      <div className="ui-glyph-grid">{hits.map(cell)}</div>
    </div>
  ) : null);

  return (
    <div className="ui-glyphpicker">
      <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
        <SearchField
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery('')}
          placeholder="Найти значок…"
          aria-label="Поиск значка"
          width="100%"
          autoFocus
        />
        {onClose && <IconButton icon="close" label="Закрыть" size={30} onClick={onClose} />}
      </div>

      {!searching && !only && (
        <div style={{ marginTop: '0.5rem' }}>
          <SegmentedControl aria-label="Набор значков" value={mode} onChange={setMode} items={MODE_ITEMS} />
        </div>
      )}

      {!searching && groups.length > 0 && (
        <div className="ui-glyph-cats">
          {groups.map((g, i) => (
            <Chip key={g.k} size="sm" tone="accent" selected={i === group} onClick={() => setGroup(i)}>
              {g.l}
            </Chip>
          ))}
        </div>
      )}

      <div className="ui-glyph-body" ref={gridRef} onKeyDown={onGridKey}>
        {failed && <div className="body-sm" style={{ padding: '1rem 0' }}>Не удалось загрузить набор значков.</div>}
        {!index && !failed && <div className="body-sm" style={{ padding: '1rem 0' }}>Загружаю…</div>}

        {index && searching && results && (
          <>
            {(!only || only === 'icons') && section('Иконки', results.icons, results.totals.icons)}
            {(!only || only === 'fluent') && section('Свои эмодзи', results.fluent, results.totals.fluent)}
            {(!only || only === 'noto') && section('Noto', results.noto, results.totals.noto)}
            {!results.icons.length && !results.fluent.length && !results.noto.length && (
              <div className="body-sm" style={{ padding: '1rem 0' }}>Ничего не нашлось. Попробуйте другое слово.</div>
            )}
          </>
        )}

        {index && !searching && (
          <>
            {shownRecent.length > 0 && group === 0 && (
              <>
                <div className="label-caps" style={{ margin: '0.25rem 0' }}>Недавние</div>
                <div className="ui-glyph-grid">{shownRecent.map((v) => cell({ value: v, label: 'Недавний значок' }))}</div>
                <div className="label-caps" style={{ margin: '0.5rem 0 0.25rem' }}>{groups[group]?.l}</div>
              </>
            )}
            <div className="ui-glyph-grid">{browse.map(cell)}</div>
          </>
        )}
      </div>

      {onRemove && value && (
        <div style={{ borderTop: '1px solid var(--divider)', paddingTop: '0.5rem' }}>
          <Button variant="ghost" size="sm" icon="close" onClick={() => { onRemove(); onClose?.(); }}>
            Убрать значок
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------- обёртки-триггеры ----------

/** Поповер с выборщиком у произвольной кнопки-якоря. */
function useGlyphPopover(props: Omit<GlyphPickerProps, 'onClose'>) {
  const pop = usePopover<HTMLButtonElement>({ maxHeight: 430 });
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const layer = pop.open && mounted
    ? createPortal(
        // role="dialog" — потому что триггер обещает его через aria-haspopup;
        // без роли скринридер объявляет «диалог», а попадает в безымянную группу.
        <div
          ref={pop.layerRef}
          className="ui-popover"
          role="dialog"
          aria-label="Выбор значка"
          style={{ ...pop.layerStyle, padding: '0.625rem', width: 336 }}
        >
          <GlyphPicker {...props} onClose={() => { pop.setOpen(false); pop.anchorRef.current?.focus(); }} />
        </div>,
        document.body,
      )
    : null;

  return { pop, layer };
}

export interface GlyphFieldProps extends Omit<GlyphPickerProps, 'onSelect' | 'onRemove' | 'onClose'> {
  label?: string;
  hint?: string;
  onChange: (value: string | null) => void;
  /** Сторона квадрата-кнопки, px. */
  size?: number;
  /** Что показать, пока значок не выбран. */
  fallback?: 'plus';
}

/** Поле формы «Значок»: квадрат с текущим значком, по клику — выбор. */
export function GlyphField({ label = 'Значок', hint, value, onChange, size = 44, suggest, only }: GlyphFieldProps) {
  const { pop, layer } = useGlyphPopover({
    value,
    suggest,
    only,
    onSelect: (v) => onChange(v),
    onRemove: () => onChange(null),
  });

  return (
    <Field label={label} hint={hint}>
      <button
        ref={pop.anchorRef}
        type="button"
        className="ui-glyph-trigger"
        style={{ width: size, height: size }}
        onClick={() => pop.setOpen(!pop.open)}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-label={value ? 'Изменить значок' : 'Выбрать значок'}
        title={value ? 'Изменить значок' : 'Выбрать значок'}
      >
        {value
          ? <Glyph value={value} size={Math.round(size * 0.55)} />
          : <Icon name="add" size={Math.round(size * 0.42)} style={{ color: 'var(--label)' }} />}
      </button>
      {layer}
    </Field>
  );
}

export interface GlyphPickerButtonProps extends Omit<GlyphPickerProps, 'onClose' | 'onRemove'> {
  label: string;
  size?: number;
}

/** Кнопка-иконка, открывающая выборщик (композер чата). */
export function GlyphPickerButton({ label, size = 38, ...rest }: GlyphPickerButtonProps) {
  const { pop, layer } = useGlyphPopover(rest);
  return (
    <>
      <IconButton
        ref={pop.anchorRef}
        icon="smiley"
        label={label}
        size={size}
        onClick={() => pop.setOpen(!pop.open)}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
      />
      {layer}
    </>
  );
}
