'use client';

// ============================================================
// Значок сущности: разбор значения, каталоги и поиск.
//
// Значок хранится ОДНОЙ строкой (как и раньше — в 6 таблицах), но теперь
// значение может нести пометку набора:
//
//   ph:car                предметная иконка нашего каталога (Phosphor Light)
//   fl:1f697              эмодзи набора «Свои» (картинка Fluent 128px)
//   nt:1f697              эмодзи набора Noto (символ, шрифт Noto Color Emoji)
//   receipt               имя иконки КИТА — так значок ставит КОД (фолбэки строк)
//   🚗                    голый символ — старые записи; рисуется тем же Noto
//
// Почему пометка, а не отдельная колонка: набор — свойство КАЖДОГО значка
// (человек берёт ту картинку, что нравится, отдельно для «Еды» и «Транспорта»),
// а миграции шести таблиц ради этого не нужны. Старые записи продолжают
// работать и вид получают автоматически — их рисует шрифт Noto.
// ============================================================

import { useEffect, useReducer } from 'react';
import { ICONS, type IconName } from './Icon';

export const GLYPH_PREFIX = { object: 'ph:', fluent: 'fl:', noto: 'nt:' } as const;

export type ParsedGlyph =
  | { kind: 'none' }
  | { kind: 'icon'; name: IconName }      // иконка кита (ставится кодом)
  | { kind: 'object'; name: string }      // предметная иконка каталога
  | { kind: 'image'; hex: string }        // картинка Fluent
  | { kind: 'text'; char: string };       // символ (Noto/легаси)

/** Кодпоинты → сам символ: 1f469-200d-1f4bb → 👩‍💻 */
export function hexToChar(hex: string): string {
  try {
    return String.fromCodePoint(...hex.split('-').map((p) => parseInt(p, 16)));
  } catch {
    return '';
  }
}

/** Символ → кодпоинты в том же виде, что в каталоге. */
export function charToHex(char: string): string {
  return [...char].map((c) => c.codePointAt(0)!.toString(16)).join('-');
}

export function parseGlyph(value: string | null | undefined): ParsedGlyph {
  const v = (value ?? '').trim();
  if (!v) return { kind: 'none' };
  if (v.startsWith(GLYPH_PREFIX.object)) return { kind: 'object', name: v.slice(3) };
  if (v.startsWith(GLYPH_PREFIX.fluent)) return { kind: 'image', hex: v.slice(3) };
  if (v.startsWith(GLYPH_PREFIX.noto)) return { kind: 'text', char: hexToChar(v.slice(3)) };
  // Имя из реестра кита — так значок задаёт КОД (иконка счёта, вид операции).
  // Проверка обязана быть здесь: напечатать «receipt» текстом — известная ловушка.
  if (v in ICONS) return { kind: 'icon', name: v as IconName };
  return { kind: 'text', char: v };
}

export const fluentUrl = (hex: string) => `/glyphs/fluent/${hex}.webp`;

// ---------- каталог ----------

export interface GlyphIndex {
  v: number;
  meta: { fluentCovered: number; emojiPx: number };
  emojiGroups: Array<{ k: string; l: string }>;
  /** [кодпоинт, символ, название, синонимы, индекс группы, есть ли картинка Fluent] */
  emoji: Array<[string, string, string, string, number, number]>;
  iconGroups: Array<{ k: string; l: string }>;
  /** [имя, название, синонимы, индекс группы] */
  icons: Array<[string, string, string, number]>;
}

let indexCache: GlyphIndex | null = null;
let indexPromise: Promise<GlyphIndex> | null = null;

export function loadGlyphIndex(): Promise<GlyphIndex> {
  if (indexCache) return Promise.resolve(indexCache);
  if (!indexPromise) {
    indexPromise = fetch('/glyphs/index.json')
      .then((r) => r.json())
      .then((data: GlyphIndex) => { indexCache = data; return data; })
      .catch((e) => { indexPromise = null; throw e; });
  }
  return indexPromise;
}

let pathsCache: Record<string, string> | null = null;
let pathsPromise: Promise<Record<string, string>> | null = null;
const pathsWaiters = new Set<() => void>();

export function loadIconPaths(): Promise<Record<string, string>> {
  if (pathsCache) return Promise.resolve(pathsCache);
  if (!pathsPromise) {
    pathsPromise = fetch('/glyphs/icons.json')
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        pathsCache = data;
        pathsWaiters.forEach((w) => w());
        return data;
      })
      .catch((e) => { pathsPromise = null; throw e; });
  }
  return pathsPromise;
}

/**
 * Контуры предметных иконок. Их не может быть в бандле: 453 React-компонента
 * утащили бы в граф КАЖДОЙ страницы то, что нужно единицам мест. Файл грузится
 * один раз за сессию и кэшируется браузером.
 */
export function useIconPaths(): Record<string, string> | null {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (pathsCache) return;
    let alive = true;
    const wake = () => { if (alive) bump(); };
    pathsWaiters.add(wake);
    loadIconPaths().catch(() => undefined);
    return () => { alive = false; pathsWaiters.delete(wake); };
  }, []);
  return pathsCache;
}

// ---------- поиск ----------

export interface GlyphHit {
  /** Готовое значение для сохранения: 'ph:car' | 'fl:1f697' | 'nt:1f697'. */
  value: string;
  label: string;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').trim();

/**
 * Ранг совпадения. Точный синоним стоит ВЫШЕ, чем начало длинного названия:
 * на «машина» первым должен идти 🚗 «автомобиль» (синоним «машина»), а не
 * «машина скорой помощи», у которой запрос просто оказался первым словом.
 */
function rank(query: string, label: string, tags: string): number {
  const l = norm(label);
  const words = norm(tags).split(/\s+/).filter(Boolean);
  if (l === query) return 5;
  if (words.includes(query)) return 4;
  if (l.startsWith(query)) return 3;
  if (words.some((w) => w.startsWith(query))) return 2;
  if (l.includes(query) || words.some((w) => w.includes(query))) return 1;
  return 0;
}

export interface GlyphSearchResult {
  icons: GlyphHit[];
  fluent: GlyphHit[];
  noto: GlyphHit[];
  /** Сколько найдено ВСЕГО (выдача срезана лимитом — показываем это числом). */
  totals: { icons: number; fluent: number; noto: number };
}

/** Поиск сразу по трём каталогам — «машина» показывает и иконку, и оба эмодзи. */
export function searchGlyphs(index: GlyphIndex, rawQuery: string, limit = 48): GlyphSearchResult {
  const q = norm(rawQuery);
  if (!q) return { icons: [], fluent: [], noto: [], totals: { icons: 0, fluent: 0, noto: 0 } };

  const icons: Array<GlyphHit & { r: number }> = [];
  for (const [name, label, tags] of index.icons) {
    const r = rank(q, label, `${tags} ${name}`);
    if (r) icons.push({ value: GLYPH_PREFIX.object + name, label, r });
  }

  const fluent: Array<GlyphHit & { r: number }> = [];
  const noto: Array<GlyphHit & { r: number }> = [];
  for (const [hex, , label, tags, , hasFluent] of index.emoji) {
    const r = rank(q, label, tags);
    if (!r) continue;
    if (hasFluent) fluent.push({ value: GLYPH_PREFIX.fluent + hex, label, r });
    noto.push({ value: GLYPH_PREFIX.noto + hex, label, r });
  }

  // Сортировка только по рангу: у Array.sort стабильный порядок, поэтому внутри
  // одного ранга сохраняется последовательность самого стандарта — та же, что во
  // всех эмодзи-клавиатурах. Сортировать «по длине названия» пробовали: сетка
  // перетасовывается непредсказуемо, и глазом искать труднее.
  const top = (arr: Array<GlyphHit & { r: number }>) =>
    arr.sort((a, b) => b.r - a.r).slice(0, limit).map(({ value, label }) => ({ value, label }));

  return {
    icons: top(icons),
    fluent: top(fluent),
    noto: top(noto),
    totals: { icons: icons.length, fluent: fluent.length, noto: noto.length },
  };
}

/** Значки одной категории при пустом поиске. */
export function browseGlyphs(index: GlyphIndex, mode: 'icons' | 'fluent' | 'noto', groupIdx: number): GlyphHit[] {
  if (mode === 'icons') {
    return index.icons
      .filter(([, , , g]) => g === groupIdx)
      .map(([name, label]) => ({ value: GLYPH_PREFIX.object + name, label }));
  }
  const out: GlyphHit[] = [];
  for (const [hex, , label, , g, hasFluent] of index.emoji) {
    if (g !== groupIdx) continue;
    if (mode === 'fluent' && !hasFluent) continue;
    out.push({ value: (mode === 'fluent' ? GLYPH_PREFIX.fluent : GLYPH_PREFIX.noto) + hex, label });
  }
  return out;
}

// ---------- недавние ----------

const RECENT_KEY = 'sa6_recent_glyphs';
const RECENT_MAX = 16;

export function recentGlyphs(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function pushRecentGlyph(value: string) {
  if (typeof window === 'undefined' || !value) return;
  try {
    const next = [value, ...recentGlyphs().filter((v) => v !== value)].slice(0, RECENT_MAX);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Приватный режим/переполнение — «недавние» не та вещь, ради которой стоит падать.
  }
}
