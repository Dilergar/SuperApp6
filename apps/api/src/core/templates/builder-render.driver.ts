import type {
  BuilderBlock,
  BuilderDoc,
  BuilderInline,
  BuilderListItemBlock,
  TemplateIssueDto,
} from '@superapp/shared';
import { applyFormatterChain, TemplateFormatError, isKnownFormatter } from './template-formatters';
import { TemplateDataError } from './template.types';
import type { TemplateValues } from './template.types';

/**
 * Второй драйвер core/templates: блочный документ (BuilderDoc) → печатный HTML.
 *
 * HTML один и тот же для превью в вебе и для PDF: страницу печатает Chromium
 * (контейнер Gotenberg), поэтому «что видишь — то и подпишут» держится на том,
 * что рендер ровно один. Синтаксис данных общий с docx-драйвером: путь чипа =
 * тег «Группа.Поле», форматтеры — те же (дата/прописью/число).
 *
 * Контракт честности как у docx-пути: strict — недостающее поле означает отказ
 * СПИСКОМ (TemplateDataError); мягкий режим (черновики, превью) рисует на месте
 * значения видимую метку ‹Группа.Поле› — слово «undefined» в документе
 * невозможно ни в одном режиме.
 */

export interface BuilderRenderAssets {
  /** Лого организации для шапки реквизитов — data:URI (Chromium в контейнере наружу не ходит) */
  logoDataUri?: string | null;
}

export interface BuilderRenderOptions {
  strict?: boolean;
  assets?: BuilderRenderAssets;
  title?: string;
}

export interface BuilderHtmlResult {
  /** Полная страница (doctype+css) — её печатает Chromium и её же показывает превью */
  html: string;
  missing: string[];
  replaced: number;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Печатные стили А4. Поля ГОСТ-подобные: левое 20 (переплёт), правое 10, верх/низ 20 */
const PRINT_CSS = `
  @page { size: A4; margin: 20mm 10mm 20mm 20mm; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'PT Serif', 'Liberation Serif', 'Times New Roman', serif;
    font-size: 12pt; line-height: 1.5; color: #000;
    hyphens: auto; -webkit-hyphens: auto;
  }
  p { margin: 0; text-align: justify; text-indent: 12.5mm; }
  p.a-center { text-align: center; text-indent: 0; }
  p.a-right { text-align: right; text-indent: 0; }
  p.a-left { text-align: left; }
  h1, h2, h3 { margin: 4mm 0 2mm; line-height: 1.3; }
  h1 { font-size: 14pt; text-align: center; }
  h2 { font-size: 13pt; }
  h3 { font-size: 12pt; }
  h1.a-left, h2.a-left, h3.a-left { text-align: left; }
  h1.a-right, h2.a-right, h3.a-right { text-align: right; }
  h1.a-center, h2.a-center, h3.a-center { text-align: center; }
  ul, ol { margin: 1mm 0; padding-left: 12.5mm; }
  li { text-align: justify; }
  table.grid { width: 100%; border-collapse: collapse; margin: 2mm 0; }
  table.grid td, table.grid th { border: 0.5pt solid #000; padding: 1.5mm 2mm; vertical-align: top; text-align: left; font-weight: normal; }
  table.grid th { font-weight: bold; }
  table.grid thead { display: table-header-group; }
  .requisites { text-align: center; border-bottom: 1pt solid #000; padding-bottom: 3mm; margin-bottom: 5mm; }
  .requisites .r-logo { max-height: 18mm; margin-bottom: 2mm; }
  .requisites .r-name { font-size: 13pt; font-weight: bold; }
  .requisites .r-line { font-size: 10pt; }
  .doc-meta { margin: 3mm 0; text-indent: 0; }
  table.sig { width: 100%; border-collapse: collapse; margin: 6mm 0 0; }
  table.sig td { padding: 0 2mm 0 0; vertical-align: bottom; }
  .sig-role { width: 38%; }
  .sig-line { width: 34%; border-bottom: 0.5pt solid #000; }
  .sig-name { width: 28%; text-align: right; white-space: nowrap; }
  .sig-stamp { font-size: 10pt; }
  .page-break { break-after: page; page-break-after: always; height: 0; }
  .chip-missing { color: #7a736a; background: #f2efe7; border-radius: 2px; padding: 0 1mm; }
`;

interface RenderCtx {
  values: TemplateValues;
  strict: boolean;
  assets: BuilderRenderAssets;
  missing: string[];
  replaced: number;
}

/** Значение по пути чипа: «Форма.X» — из полей формы (россыпь), иначе values[Группа][Поле] */
function lookup(ctx: RenderCtx, path: string): unknown {
  const dot = path.indexOf('.');
  const group = path.slice(0, dot);
  const field = path.slice(dot + 1);
  if (group === 'Форма') {
    const flat = ctx.values[field];
    if (flat !== undefined) return flat;
    const grouped = ctx.values['Форма'];
    return grouped && typeof grouped === 'object' ? (grouped as Record<string, unknown>)[field] : undefined;
  }
  const bag = ctx.values[group];
  if (!bag || typeof bag !== 'object') return undefined;
  return (bag as Record<string, unknown>)[field];
}

function parseFormat(format?: string): { key: string; arg?: string }[] {
  if (!format) return [];
  const colon = format.indexOf(':');
  const key = colon < 0 ? format : format.slice(0, colon);
  const arg = colon < 0 ? undefined : format.slice(colon + 1);
  if (!isKnownFormatter(key, arg)) return [];
  return [{ key, arg }];
}

function missingMark(ctx: RenderCtx, path: string, note?: string): string {
  if (!ctx.missing.includes(path)) ctx.missing.push(path);
  return `<span class="chip-missing">‹${esc(path)}${note ? `: ${esc(note)}` : ''}›</span>`;
}

function renderChip(ctx: RenderCtx, props: { path: string; format?: string }): string {
  const value = lookup(ctx, props.path);
  if (value === undefined || value === null) return missingMark(ctx, props.path);
  try {
    const text = applyFormatterChain(value, parseFormat(props.format), props.path);
    ctx.replaced += 1;
    return esc(text);
  } catch (e) {
    if (e instanceof TemplateFormatError) {
      if (ctx.strict) throw e;
      return missingMark(ctx, props.path, 'неверный формат');
    }
    throw e;
  }
}

function renderInline(ctx: RenderCtx, items: BuilderInline[]): string {
  const out: string[] = [];
  for (const item of items) {
    if (item.type === 'chip') {
      out.push(renderChip(ctx, item.props));
      continue;
    }
    let html = esc(item.text);
    const st = item.styles ?? {};
    if (st.underline) html = `<u>${html}</u>`;
    if (st.italic) html = `<em>${html}</em>`;
    if (st.bold) html = `<strong>${html}</strong>`;
    out.push(html);
  }
  return out.join('');
}

const alignClass = (align?: string): string => (align && align !== 'justify' ? ` class="a-${align}"` : '');

function renderListItems(ctx: RenderCtx, items: BuilderListItemBlock[]): string {
  const out: string[] = [];
  for (const item of items) {
    const children = item.children?.length
      ? renderList(ctx, item.children[0].type, item.children)
      : '';
    out.push(`<li>${renderInline(ctx, item.content)}${children}</li>`);
  }
  return out.join('');
}

function renderList(ctx: RenderCtx, type: string, items: BuilderListItemBlock[]): string {
  const tag = type === 'numberedListItem' ? 'ol' : 'ul';
  return `<${tag}>${renderListItems(ctx, items)}</${tag}>`;
}

/** Шапка-бланк из значений группы «Организация» — витрина: null-поля просто пропускаются */
function renderRequisites(ctx: RenderCtx, props?: { showLogo?: boolean }): string {
  const org = (ctx.values['Организация'] ?? {}) as Record<string, unknown>;
  const val = (k: string): string | null => {
    const v = org[k];
    return typeof v === 'string' && v.trim() ? esc(v.trim()) : null;
  };
  const name = val('Юрнаименование') ?? val('Название');
  const lines: string[] = [];
  if (props?.showLogo !== false && ctx.assets.logoDataUri) {
    lines.push(`<img class="r-logo" src="${ctx.assets.logoDataUri}" alt="" />`);
  }
  lines.push(`<div class="r-name">${name ?? missingMark(ctx, 'Организация.Юрнаименование')}</div>`);
  const bin = val('БИН');
  const addr = val('Юрадрес');
  const line2 = [bin ? `БИН ${bin}` : null, addr].filter(Boolean).join(' · ');
  if (line2) lines.push(`<div class="r-line">${line2}</div>`);
  const bank = [val('Банк'), val('БИК') ? `БИК ${val('БИК')}` : null, val('ИИК') ? `ИИК ${val('ИИК')}` : null]
    .filter(Boolean)
    .join(' · ');
  if (bank) lines.push(`<div class="r-line">${bank}</div>`);
  return `<div class="requisites">${lines.join('')}</div>`;
}

function renderDocMeta(ctx: RenderCtx, props?: { align?: string }): string {
  const docBag = (ctx.values['Документ'] ?? {}) as Record<string, unknown>;
  const number = typeof docBag['Номер'] === 'string' && docBag['Номер'] ? esc(docBag['Номер'] as string) : '_______';
  let date = '«___» ____________ ____ г.';
  const raw = docBag['Дата'];
  if (raw !== undefined && raw !== null && raw !== '') {
    try {
      date = esc(applyFormatterChain(raw, [{ key: 'дата' }], 'Документ.Дата'));
      ctx.replaced += 1;
    } catch {
      /* дата не разобралась — остаётся прочерк-линия, документ не падает */
    }
  }
  const cls = props?.align && props.align !== 'justify' ? ` a-${props.align}` : '';
  return `<p class="doc-meta${cls}">№ ${number} от ${date}</p>`;
}

function renderSignature(
  ctx: RenderCtx,
  props: { role: string; nameSource: string; customName?: string; stamp?: boolean },
): string {
  let name = '';
  if (props.nameSource === 'subject') {
    const v = lookup(ctx, 'Сотрудник.ФИО');
    name = typeof v === 'string' && v ? esc(v) : missingMark(ctx, 'Сотрудник.ФИО');
  } else if (props.nameSource === 'director') {
    const v = lookup(ctx, 'Организация.Директор');
    name = typeof v === 'string' && v ? esc(v) : missingMark(ctx, 'Организация.Директор');
  } else if (props.nameSource === 'custom') {
    name = esc(props.customName ?? '');
  }
  const stamp = props.stamp ? `<div class="sig-stamp">М.П.</div>` : '';
  return (
    `<table class="sig"><tbody><tr>` +
    `<td class="sig-role">${esc(props.role)}${stamp}</td>` +
    `<td class="sig-line"></td>` +
    `<td class="sig-name">${name}</td>` +
    `</tr></tbody></table>`
  );
}

function renderTable(
  ctx: RenderCtx,
  block: { props?: { columnWidths?: number[]; headerRow?: boolean }; rows: { cells: BuilderInline[][] }[] },
): string {
  const cols = Math.max(1, ...block.rows.map((r) => r.cells.length));
  let colgroup = '';
  const widths = block.props?.columnWidths;
  if (widths?.length) {
    const sum = widths.reduce((a, b) => a + b, 0) || 1;
    colgroup =
      '<colgroup>' +
      Array.from({ length: cols }, (_, i) => {
        const w = widths[i];
        return w ? `<col style="width:${((w / sum) * 100).toFixed(2)}%" />` : '<col />';
      }).join('') +
      '</colgroup>';
  }
  const rowHtml = (row: { cells: BuilderInline[][] }, tag: 'td' | 'th'): string => {
    const cells = Array.from({ length: cols }, (_, i) => row.cells[i] ?? []);
    return `<tr>${cells.map((c) => `<${tag}>${renderInline(ctx, c) || '&nbsp;'}</${tag}>`).join('')}</tr>`;
  };
  const header = block.props?.headerRow && block.rows.length > 0 ? block.rows[0] : null;
  const bodyRows = header ? block.rows.slice(1) : block.rows;
  const thead = header ? `<thead>${rowHtml(header, 'th')}</thead>` : '';
  return `<table class="grid">${colgroup}${thead}<tbody>${bodyRows.map((r) => rowHtml(r, 'td')).join('')}</tbody></table>`;
}

function renderBlock(ctx: RenderCtx, block: BuilderBlock): string {
  switch (block.type) {
    case 'paragraph': {
      const inner = renderInline(ctx, block.content);
      // Пустой абзац — честная пустая строка (вертикальный отступ, как в Word)
      return `<p${alignClass(block.props?.align)}>${inner || '&nbsp;'}</p>`;
    }
    case 'heading': {
      const tag = `h${block.props.level}`;
      return `<${tag}${alignClass(block.props.align)}>${renderInline(ctx, block.content)}</${tag}>`;
    }
    case 'bulletListItem':
    case 'numberedListItem':
      // Одиночный элемент списка (группировку подряд идущих делает renderBlocks)
      return renderList(ctx, block.type, [block]);
    case 'table':
      return renderTable(ctx, block);
    case 'requisites':
      return renderRequisites(ctx, block.props);
    case 'docMeta':
      return renderDocMeta(ctx, block.props);
    case 'signature':
      return renderSignature(ctx, block.props);
    case 'pageBreak':
      return `<div class="page-break"></div>`;
    default:
      return '';
  }
}

/** Подряд идущие элементы списка одного типа склеиваются в один ul/ol */
function renderBlocks(ctx: RenderCtx, blocks: BuilderBlock[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.type === 'bulletListItem' || block.type === 'numberedListItem') {
      const run: BuilderListItemBlock[] = [];
      while (i < blocks.length && blocks[i].type === block.type) {
        run.push(blocks[i] as BuilderListItemBlock);
        i += 1;
      }
      out.push(renderList(ctx, block.type, run));
      continue;
    }
    out.push(renderBlock(ctx, block));
    i += 1;
  }
  return out.join('\n');
}

export function renderBuilderHtml(
  doc: BuilderDoc,
  values: TemplateValues,
  opts?: BuilderRenderOptions,
): BuilderHtmlResult {
  const ctx: RenderCtx = {
    values,
    strict: opts?.strict !== false,
    assets: opts?.assets ?? {},
    missing: [],
    replaced: 0,
  };
  const body = renderBlocks(ctx, doc.blocks);
  if (ctx.strict && ctx.missing.length) throw new TemplateDataError(ctx.missing);
  const html =
    `<!doctype html><html lang="ru"><head><meta charset="utf-8" />` +
    `<title>${esc(opts?.title ?? 'Документ')}</title>` +
    `<style>${PRINT_CSS}</style></head><body>${body}</body></html>`;
  return { html, missing: ctx.missing, replaced: ctx.replaced };
}

/**
 * Проверка builder-документа против реестра полей — аналог компилятора docx-пути.
 * Формы у чипов не бывает битой by construction; проверяется только «поле ещё
 * существует в реестре» (могло исчезнуть после смены версии платформы).
 */
export function checkBuilderDoc(
  doc: BuilderDoc,
  isKnownPath: (path: string) => boolean,
  formFieldKeys: string[],
): TemplateIssueDto[] {
  const issues: TemplateIssueDto[] = [];
  const seen = new Set<string>();
  const walkInline = (items: BuilderInline[]): void => {
    for (const item of items) {
      if (item.type !== 'chip' || seen.has(item.props.path)) continue;
      seen.add(item.props.path);
      const { path } = item.props;
      const dot = path.indexOf('.');
      const group = path.slice(0, dot);
      const field = path.slice(dot + 1);
      if (group === 'Форма') {
        if (!formFieldKeys.includes(field)) {
          issues.push({ code: 'unknown_field', message: `Поле «${path}» не объявлено в форме подачи`, tag: path });
        }
      } else if (!isKnownPath(path)) {
        issues.push({ code: 'unknown_field', message: `Поле «${path}» неизвестно реестру данных`, tag: path });
      }
      if (item.props.format) {
        const chain = parseFormat(item.props.format);
        if (!chain.length) {
          issues.push({ code: 'unknown_formatter', message: `«${path}»: неизвестный формат «${item.props.format}»`, tag: path });
        }
      }
    }
  };
  const walkBlocks = (blocks: BuilderBlock[]): void => {
    for (const b of blocks) {
      if ('content' in b && Array.isArray(b.content)) walkInline(b.content);
      if (b.type === 'table') for (const row of b.rows) for (const cell of row.cells) walkInline(cell);
      if ((b.type === 'bulletListItem' || b.type === 'numberedListItem') && b.children?.length) {
        walkBlocks(b.children);
      }
    }
  };
  walkBlocks(doc.blocks);
  return issues;
}
