import { unzipSync, zipSync } from 'fflate';
import type { TemplateIssueDto, TemplateTagDto } from '@superapp/shared';
import { TEMPLATE_INDEX_TAG, TEMPLATE_LIMITS } from '@superapp/shared';
import {
  TemplateCompileError,
  TemplateDataError,
  type TemplateExtractResult,
  type TemplateRenderDriver,
  type TemplateRenderOptions,
  type TemplateRenderResult,
  type TemplateValues,
} from './template.types';
import { applyFormatterChain, TemplateFormatError } from './template-formatters';

/**
 * СОБСТВЕННЫЙ драйвер рендера .docx (решение пользователя 2026-08-03: готовые
 * отвергнуты — easy-template-x молча ломает файл, у docxtemplater Excel платный,
 * у carbone мина с датами и закрытая лицензия с v4).
 *
 * Как устроен .docx: ZIP с XML-частями; текст лежит в узлах `<w:t>` внутри
 * прогонов `<w:r>`. Главная беда формата — Word РВЁТ набранный тег
 * `{Организация.БИН}` на несколько прогонов (проверка орфографии, правки,
 * смена форматирования посреди слова), поэтому наивная замена тег не находит.
 *
 * Подход (алгоритм по образцу MIT-кода docxtemplater, реализация своя):
 *  1. Собираем все текст-узлы части с их смещениями в XML.
 *  2. Склеиваем «виртуальный текст» — карту виртуальная позиция → (узел, смещение).
 *     Между узлами, разделёнными КОНЦОМ АБЗАЦА или структурным элементом
 *     (<w:br/>, <w:tab/>, рисунок, поле), ставится сентинел: тег через такую
 *     границу не собирается — это честная ошибка компиляции, а не тихая склейка.
 *  3. Ищем теги в виртуальном тексте (они могут пересекать границы узлов).
 *  4. Замена — хирургия ТОЛЬКО внутри текст-узлов: значение целиком уходит в
 *     первый узел тега (наследует его форматирование), остальные пустеют.
 *     Всё прочее в файле — стили, картинки, нумерация — не трогается байт-в-байт.
 *  5. Повтор {#X}…{/X} работает на СТРОКЕ ТАБЛИЦЫ: находим объемлющий <w:tr>,
 *     клонируем строку на каждый элемент коллекции, теги внутри резолвятся в
 *     скоупе элемента ({Поле}, {№}), затем — обычная подстановка.
 *
 * Ошибки — ТОЛЬКО громкие (главный урок проверки кандидатов): битый шаблон →
 * TemplateCompileError со списком, нет данных → TemplateDataError со списком
 * недостающих полей. Слово «undefined» в документе появиться не может.
 */

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Части, в которых живёт текст документа (тело, колонтитулы, сноски) */
const PART_RE = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

/**
 * Структурные элементы, через которые тег НЕ собирается. Конец абзаца
 * покрывает и границы ячеек таблицы (в каждой ячейке свой <w:p>). Разрыв
 * строки/таба посреди тега оставил бы в документе «хвост» разметки — честнее
 * отказать словами «тег разорван переносом».
 */
const HARD_BREAK_RE =
  /<\/w:p>|<w:br[\s/>]|<w:tab[\s/>]|<w:drawing[\s>]|<w:pict[\s>]|<w:object[\s>]|<w:fldChar[\s>]|<w:footnoteReference[\s>]|<w:endnoteReference[\s>]/;

const SENTINEL = '\u0000';

interface TextNode {
  /** Смещение '<w:t' в XML части */
  outerStart: number;
  /** Смещение сразу ЗА '</w:t>' (или '/>') */
  outerEnd: number;
  /** Смещение первого символа внутреннего текста (-1 у самозакрытого) */
  innerStart: number;
  /** Сырой внутренний текст (XML-экранированный) */
  text: string;
}

interface Segment {
  nodeIdx: number;
  vStart: number;
  vEnd: number;
}

interface LexedTag {
  kind: 'field' | 'repeat_open' | 'repeat_close';
  /** Путь поля либо ключ коллекции (у {/} — пустая строка) */
  path: string;
  formatters: { key: string; arg?: string }[];
  raw: string;
  vStart: number;
  vEnd: number;
}

interface LexedPart {
  xml: string;
  nodes: TextNode[];
  segments: Segment[];
  virtual: string;
  tags: LexedTag[];
  issues: TemplateIssueDto[];
}

interface NodeEdit {
  nodeIdx: number;
  from: number;
  to: number;
  text: string;
}

// ---------------------------------------------------------------- утилиты XML

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Значение → внутренность <w:t>; переносы строк — настоящими <w:br/> внутри прогона */
function valueToInnerXml(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(escapeXml)
    .join('</w:t><w:br/><w:t xml:space="preserve">');
}

/** Нормализация пути для сличения с реестром: NFC, NBSP→пробел, схлоп пробелов */
function normalizePath(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split('.')
    .map((p) => p.trim())
    .join('.');
}

/** Фрагмент виртуального текста для сообщений об ошибках (сентинелы → ¶) */
function snippet(virtual: string, at: number): string {
  return virtual
    .slice(Math.max(0, at - 10), at + 30)
    .replace(new RegExp(SENTINEL, 'g'), '¶')
    .trim();
}

// ------------------------------------------------------------------- лексер

function collectTextNodes(xml: string): TextNode[] {
  const nodes: TextNode[] = [];
  const re = /<w:t(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/w:t>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const selfClosing = m[1] === undefined;
    nodes.push({
      outerStart: m.index,
      outerEnd: m.index + m[0].length,
      innerStart: selfClosing ? -1 : m.index + m[0].indexOf('>') + 1,
      text: m[1] ?? '',
    });
  }
  return nodes;
}

function lexPart(xml: string, partLabel: string): LexedPart {
  const nodes = collectTextNodes(xml);
  const segments: Segment[] = [];
  let virtual = '';
  for (let i = 0; i < nodes.length; i++) {
    if (i > 0) {
      const between = xml.slice(nodes[i - 1].outerEnd, nodes[i].outerStart);
      if (HARD_BREAK_RE.test(between)) virtual += SENTINEL;
    }
    const vStart = virtual.length;
    virtual += nodes[i].text;
    segments.push({ nodeIdx: i, vStart, vEnd: virtual.length });
  }

  const tags: LexedTag[] = [];
  const issues: TemplateIssueDto[] = [];
  let i = 0;
  while (i < virtual.length) {
    const ch = virtual[i];
    if (ch === '}') {
      issues.push({
        code: 'stray_close',
        message: `«}» без открывающей скобки: …${snippet(virtual, i)}…`,
        part: partLabel,
      });
      i++;
      continue;
    }
    if (ch !== '{') {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < virtual.length && virtual[j] !== '{' && virtual[j] !== '}' && virtual[j] !== SENTINEL) j++;
    if (j >= virtual.length || virtual[j] !== '}') {
      const broken = j < virtual.length && virtual[j] === SENTINEL;
      issues.push({
        code: broken ? 'tag_broken_by_break' : 'unclosed_tag',
        message: broken
          ? `Тег разорван концом абзаца или переносом строки: …${snippet(virtual, i)}… — тег должен целиком стоять в одном абзаце`
          : `Незакрытый тег: …${snippet(virtual, i)}…`,
        part: partLabel,
      });
      i = virtual[j] === '{' ? j : j + 1;
      continue;
    }
    const rawInner = virtual.slice(i + 1, j);
    const raw = `{${rawInner}}`;
    const inner = decodeEntities(rawInner).trim();
    if (!inner) {
      issues.push({ code: 'empty_tag', message: 'Пустой тег {}', tag: raw, part: partLabel });
    } else if (inner.startsWith('#')) {
      tags.push({
        kind: 'repeat_open',
        path: normalizePath(inner.slice(1)),
        formatters: [],
        raw,
        vStart: i,
        vEnd: j + 1,
      });
    } else if (inner.startsWith('/')) {
      tags.push({
        kind: 'repeat_close',
        path: normalizePath(inner.slice(1)),
        formatters: [],
        raw,
        vStart: i,
        vEnd: j + 1,
      });
    } else {
      const pieces = inner.split('|');
      const path = normalizePath(pieces[0]);
      const formatters = pieces.slice(1).map((f) => {
        const [key, ...argParts] = f.split(':');
        const arg = argParts.length ? argParts.join(':').trim() : undefined;
        return { key: key.trim(), ...(arg !== undefined ? { arg } : {}) };
      });
      if (!path) {
        issues.push({ code: 'empty_tag', message: `Тег без имени поля: ${raw}`, tag: raw, part: partLabel });
      } else {
        tags.push({ kind: 'field', path, formatters, raw, vStart: i, vEnd: j + 1 });
      }
    }
    i = j + 1;
  }

  return { xml, nodes, segments, virtual, tags, issues };
}

// -------------------------------------------------------------- применение правок

/** Виртуальный диапазон тега → пофрагментные правки узлов (значение — в первый) */
function tagEdits(part: LexedPart, tag: LexedTag, replacement: string): NodeEdit[] {
  const edits: NodeEdit[] = [];
  let first = true;
  for (const seg of part.segments) {
    if (seg.vEnd <= tag.vStart || seg.vStart >= tag.vEnd) continue;
    const from = Math.max(tag.vStart, seg.vStart) - seg.vStart;
    const to = Math.min(tag.vEnd, seg.vEnd) - seg.vStart;
    edits.push({ nodeIdx: seg.nodeIdx, from, to, text: first ? replacement : '' });
    first = false;
  }
  return edits;
}

/** Применить правки: узлы пересобираются, XML сшивается с конца */
function applyEdits(part: LexedPart, edits: NodeEdit[]): string {
  if (!edits.length) return part.xml;
  const byNode = new Map<number, NodeEdit[]>();
  for (const e of edits) {
    if (!byNode.has(e.nodeIdx)) byNode.set(e.nodeIdx, []);
    byNode.get(e.nodeIdx)!.push(e);
  }
  let xml = part.xml;
  const nodeIdxs = [...byNode.keys()].sort((a, b) => b - a);
  for (const idx of nodeIdxs) {
    const node = part.nodes[idx];
    let inner = node.text;
    const list = byNode.get(idx)!.sort((a, b) => b.from - a.from);
    for (const e of list) inner = inner.slice(0, e.from) + e.text + inner.slice(e.to);
    const rebuilt = `<w:t xml:space="preserve">${inner}</w:t>`;
    xml = xml.slice(0, node.outerStart) + rebuilt + xml.slice(node.outerEnd);
  }
  return xml;
}

// ------------------------------------------------------------------ значения

function lookupPath(obj: unknown, parts: string[]): unknown {
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

type ResolveFn = (path: string) => unknown;

function makeResolver(values: TemplateValues): ResolveFn {
  return (path) => lookupPath(values, path.split('.'));
}

/** Скоуп элемента повтора: сначала поля элемента и {№}, затем общий скоуп */
function makeItemResolver(item: unknown, index: number, parent: ResolveFn): ResolveFn {
  return (path) => {
    if (path === TEMPLATE_INDEX_TAG) return index + 1;
    const own = lookupPath(item, path.split('.'));
    if (own !== undefined && own !== null) return own;
    return parent(path);
  };
}

// ------------------------------------------------------------------ повторы

interface RowInterval {
  start: number;
  end: number;
}

/** Интервалы строк таблицы <w:tr>…</w:tr> (правильно вложены при вложенных таблицах) */
function trIntervals(xml: string): RowInterval[] {
  const out: RowInterval[] = [];
  const stack: number[] = [];
  const re = /<w:tr[\s>]|<\/w:tr>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[0] === '</w:tr>') {
      const start = stack.pop();
      if (start !== undefined) out.push({ start, end: m.index + m[0].length });
    } else {
      stack.push(m.index);
    }
  }
  return out;
}

/** Самая внутренняя строка таблицы, содержащая смещение (или null вне таблиц) */
function enclosingRow(rows: RowInterval[], offset: number): RowInterval | null {
  let best: RowInterval | null = null;
  for (const r of rows) {
    if (offset < r.start || offset >= r.end) continue;
    if (!best || r.start > best.start) best = r;
  }
  return best;
}

/** Абсолютное смещение виртуальной позиции тега в XML части */
function absOffset(part: LexedPart, vPos: number): number {
  for (const seg of part.segments) {
    if (vPos >= seg.vStart && vPos < seg.vEnd) {
      return part.nodes[seg.nodeIdx].innerStart + (vPos - seg.vStart);
    }
  }
  // Позиция на самой границе (vEnd последнего сегмента) — конец последнего узла
  const last = part.segments[part.segments.length - 1];
  return part.nodes[last.nodeIdx].innerStart + (vPos - last.vStart);
}

// ------------------------------------------------------------------- драйвер

interface SubstituteOutcome {
  xml: string;
  replaced: number;
  missing: string[];
  issues: TemplateIssueDto[];
}

/**
 * Подстановка полей на готовом (без повторов) XML. blankRepeatMarkers — режим
 * фрагмента строки: маркеры повтора затираются, а не считаются ошибкой.
 */
function substituteFields(
  xml: string,
  partLabel: string,
  resolve: ResolveFn,
  blankRepeatMarkers: boolean,
): SubstituteOutcome {
  const part = lexPart(xml, partLabel);
  const edits: NodeEdit[] = [];
  const missing: string[] = [];
  const issues: TemplateIssueDto[] = [...part.issues];
  let replaced = 0;

  for (const tag of part.tags) {
    if (tag.kind !== 'field') {
      if (blankRepeatMarkers) {
        edits.push(...tagEdits(part, tag, ''));
      }
      // Вне фрагмента маркеры к этому моменту либо вырезаны вместе со строками,
      // либо уже сосчитаны ошибками парности — молча пропускаем.
      continue;
    }
    const value = resolve(tag.path);
    if (value === undefined || value === null) {
      missing.push(tag.path);
      continue; // strict бросит списком ниже; в мягком режиме тег остаётся видимым
    }
    let rendered: string;
    try {
      rendered = applyFormatterChain(value, tag.formatters, tag.path);
    } catch (e) {
      if (e instanceof TemplateFormatError) {
        missing.push(e.message);
        continue;
      }
      throw e;
    }
    if (rendered.length > TEMPLATE_LIMITS.maxValueLength) {
      missing.push(`«${tag.path}»: значение длиннее ${TEMPLATE_LIMITS.maxValueLength} символов`);
      continue;
    }
    edits.push(...tagEdits(part, tag, valueToInnerXml(rendered)));
    replaced++;
  }

  return { xml: applyEdits(part, edits), replaced, missing, issues };
}

class DocxRenderDriver implements TemplateRenderDriver {
  readonly format = 'docx' as const;
  readonly mimes = [DOCX_MIME] as const;

  private unzipParts(template: Buffer): {
    entries: Record<string, Uint8Array>;
    parts: { name: string; label: string; xml: string }[];
    issues: TemplateIssueDto[];
  } {
    const issues: TemplateIssueDto[] = [];
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(new Uint8Array(template));
    } catch {
      return {
        entries: {},
        parts: [],
        issues: [{ code: 'bad_structure', message: 'Файл не читается как .docx (повреждённый ZIP)' }],
      };
    }
    if (!entries['word/document.xml']) {
      return {
        entries,
        parts: [],
        issues: [{ code: 'bad_structure', message: 'В файле нет word/document.xml — это не документ Word' }],
      };
    }
    const decoder = new TextDecoder('utf-8');
    const parts = Object.keys(entries)
      .filter((name) => PART_RE.test(name))
      .sort()
      .map((name) => ({
        name,
        label: name.replace(/^word\//, '').replace(/\.xml$/, ''),
        xml: decoder.decode(entries[name]),
      }));
    return { entries, parts, issues };
  }

  extractTags(template: Buffer): TemplateExtractResult {
    const { parts, issues } = this.unzipParts(template);
    const tags: TemplateTagDto[] = [];
    const allIssues = [...issues];
    for (const p of parts) {
      const lexed = lexPart(p.xml, p.label);
      allIssues.push(...lexed.issues);
      this.pairRepeats(lexed, p.label, allIssues);
      for (const t of lexed.tags) {
        tags.push({ kind: t.kind, path: t.path, formatters: t.formatters, raw: t.raw, part: p.label });
      }
    }
    return { tags, issues: allIssues };
  }

  /** Парность повторов + привязка к строкам таблицы; пары — наружу для рендера */
  private pairRepeats(
    part: LexedPart,
    partLabel: string,
    issues: TemplateIssueDto[],
  ): { open: LexedTag; close: LexedTag; row: RowInterval }[] {
    const markers = part.tags.filter((t) => t.kind !== 'field');
    if (!markers.length) return [];
    const rows = trIntervals(part.xml);
    const pairs: { open: LexedTag; close: LexedTag; row: RowInterval }[] = [];
    let open: LexedTag | null = null;
    for (const t of markers) {
      if (t.kind === 'repeat_open') {
        if (open) {
          issues.push({
            code: 'repeat_nested',
            message: `Повтор ${t.raw} начат до закрытия ${open.raw} — вложенные повторы не поддерживаются`,
            tag: t.raw,
            part: partLabel,
          });
          continue;
        }
        open = t;
        continue;
      }
      if (!open) {
        issues.push({
          code: 'repeat_without_open',
          message: `${t.raw} без открывающего {#…}`,
          tag: t.raw,
          part: partLabel,
        });
        continue;
      }
      if (t.path && t.path !== open.path) {
        issues.push({
          code: 'repeat_without_open',
          message: `${t.raw} не совпадает с открывающим {#${open.path}}`,
          tag: t.raw,
          part: partLabel,
        });
        open = null;
        continue;
      }
      const openRow = enclosingRow(rows, absOffset(part, open.vStart));
      const closeRow = enclosingRow(rows, absOffset(part, t.vStart));
      if (!openRow) {
        issues.push({
          code: 'repeat_outside_table',
          message: `Повтор {#${open.path}} должен стоять в строке таблицы («Повторять строку»)`,
          tag: open.raw,
          part: partLabel,
        });
      } else if (!closeRow || closeRow.start !== openRow.start) {
        issues.push({
          code: 'repeat_cross_row',
          message: `{#${open.path}} и ${t.raw} должны стоять в ОДНОЙ строке таблицы`,
          tag: open.raw,
          part: partLabel,
        });
      } else if (pairs.some((p) => p.row.start === openRow.start)) {
        issues.push({
          code: 'bad_structure',
          message: `В одной строке таблицы два повтора — оставьте один ({#${open.path}})`,
          tag: open.raw,
          part: partLabel,
        });
      } else {
        pairs.push({ open, close: t, row: openRow });
      }
      open = null;
    }
    if (open) {
      issues.push({
        code: 'repeat_unclosed',
        message: `Повтор {#${open.path}} не закрыт — добавьте {/${open.path}} в ту же строку таблицы`,
        tag: open.raw,
        part: partLabel,
      });
    }
    return pairs;
  }

  render(template: Buffer, values: TemplateValues, opts?: TemplateRenderOptions): TemplateRenderResult {
    const strict = opts?.strict !== false;
    if (template.length > TEMPLATE_LIMITS.maxTemplateBytes) {
      throw new TemplateCompileError([
        { code: 'bad_structure', message: 'Шаблон больше допустимого размера' },
      ]);
    }
    const { entries, parts, issues: zipIssues } = this.unzipParts(template);
    if (zipIssues.length) throw new TemplateCompileError(zipIssues);

    // Проход 1 — структура: битые теги и парность повторов по ВСЕМ частям сразу,
    // чтобы автор шаблона получил полный список, а не по одной ошибке за заход.
    const structural: TemplateIssueDto[] = [];
    const lexedParts = parts.map((p) => {
      const lexed = lexPart(p.xml, p.label);
      structural.push(...lexed.issues);
      return { ...p, lexed, pairs: [] as { open: LexedTag; close: LexedTag; row: RowInterval }[] };
    });
    for (const p of lexedParts) p.pairs = this.pairRepeats(p.lexed, p.label, structural);
    if (structural.length) throw new TemplateCompileError(structural);

    const resolveGlobal = makeResolver(values);
    const missing: string[] = [];
    let replaced = 0;
    const encoder = new TextEncoder();

    for (const p of lexedParts) {
      let xml = p.xml;

      // Проход 2 — повторы: клонируем строки таблиц (сшивка с конца, смещения целы)
      const splices: { start: number; end: number; text: string }[] = [];
      for (const pair of p.pairs) {
        const collection = resolveGlobal(pair.open.path);
        if (collection === undefined || collection === null) {
          missing.push(pair.open.path);
          continue;
        }
        if (!Array.isArray(collection)) {
          missing.push(`«${pair.open.path}»: ожидался список строк`);
          continue;
        }
        if (collection.length > TEMPLATE_LIMITS.maxRepeatItems) {
          missing.push(`«${pair.open.path}»: больше ${TEMPLATE_LIMITS.maxRepeatItems} строк`);
          continue;
        }
        const rowXml = xml.slice(pair.row.start, pair.row.end);
        const renderedRows: string[] = [];
        for (let idx = 0; idx < collection.length; idx++) {
          const itemResolve = makeItemResolver(collection[idx], idx, resolveGlobal);
          const sub = substituteFields(rowXml, p.label, itemResolve, true);
          // Структурных ошибок внутри строки быть не может — часть уже проверена целиком
          missing.push(...sub.missing.map((path) => `${pair.open.path}[${idx + 1}].${path}`));
          replaced += sub.replaced;
          renderedRows.push(sub.xml);
        }
        splices.push({ start: pair.row.start, end: pair.row.end, text: renderedRows.join('') });
      }
      splices.sort((a, b) => b.start - a.start);
      for (const s of splices) xml = xml.slice(0, s.start) + s.text + xml.slice(s.end);

      // Проход 3 — обычные поля (оставшиеся маркеры сорванных повторов затираются:
      // их отсутствие данных уже сосчитано выше)
      const out = substituteFields(xml, p.label, resolveGlobal, true);
      missing.push(...out.missing);
      replaced += out.replaced;
      entries[p.name] = encoder.encode(out.xml);
    }

    if (strict && missing.length) {
      throw new TemplateDataError([...new Set(missing)]);
    }

    return { bytes: Buffer.from(zipSync(entries, { level: 6 })), replaced };
  }
}

export const docxRenderDriver: TemplateRenderDriver = new DocxRenderDriver();
export { DOCX_MIME };
