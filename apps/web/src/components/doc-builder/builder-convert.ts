// ============================================================
// Конвертер: наш BuilderDoc (форма провода, shared) ↔ блоки BlockNote.
//
// Провод и БД знают ТОЛЬКО BuilderDoc — редактор сменная деталь (как драйверы
// docx/STT/хранилища). Конвертер тонкий и живёт на клиенте; всё, чего наш
// печатный формат не поддерживает (цвет текста, ссылки, чек-листы), молча
// отбрасывается здесь — в документ на печать оно не попадает by design.
// ============================================================

import type {
  BuilderBlock,
  BuilderDoc,
  BuilderInline,
  BuilderListItemBlock,
  BuilderTextStyles,
} from '@superapp/shared';
import { DOC_BUILDER_VERSION } from '@superapp/shared';

/* Блоки редактора ходят через unknown-разбор: их форма — деталь библиотеки */
type BnInline = Record<string, unknown>;
type BnBlock = Record<string, unknown>;

const ALIGNS = new Set(['left', 'center', 'right', 'justify']);

// ---------- BuilderDoc → BlockNote ----------

function inlineToBn(items: BuilderInline[]): BnInline[] {
  return items.map((item) => {
    if (item.type === 'chip') {
      return {
        type: 'chip',
        props: {
          path: item.props.path,
          format: item.props.format ?? '',
          label: item.props.label ?? '',
        },
      };
    }
    const styles: Record<string, boolean> = {};
    if (item.styles?.bold) styles.bold = true;
    if (item.styles?.italic) styles.italic = true;
    if (item.styles?.underline) styles.underline = true;
    return { type: 'text', text: item.text, styles };
  });
}

function listItemToBn(item: BuilderListItemBlock): BnBlock {
  return {
    id: item.id,
    type: item.type,
    content: inlineToBn(item.content),
    children: (item.children ?? []).map(listItemToBn),
  };
}

export function builderDocToBn(doc: BuilderDoc): BnBlock[] {
  const out: BnBlock[] = [];
  for (const b of doc.blocks) {
    switch (b.type) {
      case 'paragraph':
        out.push({
          id: b.id,
          type: 'paragraph',
          // Печатный дефолт — по ширине; в BlockNote это явный textAlignment
          props: { textAlignment: b.props?.align ?? 'justify' },
          content: inlineToBn(b.content),
        });
        break;
      case 'heading':
        out.push({
          id: b.id,
          type: 'heading',
          props: { level: b.props.level, textAlignment: b.props.align ?? 'center' },
          content: inlineToBn(b.content),
        });
        break;
      case 'bulletListItem':
      case 'numberedListItem':
        out.push(listItemToBn(b));
        break;
      case 'table':
        out.push({
          id: b.id,
          type: 'table',
          content: {
            type: 'tableContent',
            ...(b.props?.columnWidths ? { columnWidths: b.props.columnWidths } : {}),
            ...(b.props?.headerRow ? { headerRows: 1 } : {}),
            rows: b.rows.map((r) => ({ cells: r.cells.map((c) => inlineToBn(c)) })),
          },
        });
        break;
      case 'requisites':
        out.push({ id: b.id, type: 'requisites', props: { showLogo: b.props?.showLogo !== false } });
        break;
      case 'docMeta':
        out.push({ id: b.id, type: 'docMeta', props: { align: b.props?.align ?? 'left' } });
        break;
      case 'signature':
        out.push({
          id: b.id,
          type: 'signature',
          props: {
            role: b.props.role,
            nameSource: b.props.nameSource,
            customName: b.props.customName ?? '',
            stamp: b.props.stamp ?? false,
          },
        });
        break;
      case 'pageBreak':
        out.push({ id: b.id, type: 'pageBreak', props: {} });
        break;
    }
  }
  if (out.length === 0) out.push({ type: 'paragraph', content: [] });
  return out;
}

// ---------- BlockNote → BuilderDoc ----------

function styleOf(raw: unknown): BuilderTextStyles | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  const out: BuilderTextStyles = {};
  if (s.bold === true) out.bold = true;
  if (s.italic === true) out.italic = true;
  if (s.underline === true) out.underline = true;
  return Object.keys(out).length ? out : undefined;
}

function inlineFromBn(raw: unknown): BuilderInline[] {
  if (!Array.isArray(raw)) return [];
  const out: BuilderInline[] = [];
  for (const item of raw as BnInline[]) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'chip') {
      const props = (item.props ?? {}) as Record<string, unknown>;
      const path = String(props.path ?? '');
      if (!path.includes('.')) continue;
      out.push({
        type: 'chip',
        props: {
          path,
          ...(props.format ? { format: String(props.format) } : {}),
          ...(props.label ? { label: String(props.label) } : {}),
        },
      });
      continue;
    }
    if (item.type === 'text') {
      const text = String(item.text ?? '');
      const styles = styleOf(item.styles);
      out.push({ type: 'text', text, ...(styles ? { styles } : {}) });
      continue;
    }
    // Ссылки и прочие инлайны: печатаем их текстовое содержимое, если оно есть
    if (Array.isArray(item.content)) out.push(...inlineFromBn(item.content));
  }
  return out;
}

function alignFrom(props: unknown, fallback: 'justify' | 'center' | 'left'): 'left' | 'center' | 'right' | 'justify' | undefined {
  const raw = props && typeof props === 'object' ? (props as Record<string, unknown>).textAlignment : undefined;
  const align = typeof raw === 'string' && ALIGNS.has(raw) ? (raw as 'left' | 'center' | 'right' | 'justify') : fallback;
  // Дефолт формата в проводе не хранится
  return align === fallback ? undefined : align;
}

function cellInlines(cell: unknown): BuilderInline[] {
  // Клетка бывает массивом инлайнов (легаси) или {type:'tableCell', content:[...]}
  if (Array.isArray(cell)) return inlineFromBn(cell);
  if (cell && typeof cell === 'object' && Array.isArray((cell as BnBlock).content)) {
    return inlineFromBn((cell as BnBlock).content);
  }
  return [];
}

function listItemFromBn(raw: BnBlock, depth: number): BuilderListItemBlock | null {
  const type = raw.type === 'numberedListItem' ? 'numberedListItem' : raw.type === 'bulletListItem' ? 'bulletListItem' : null;
  if (!type) return null;
  const children =
    depth < 3 && Array.isArray(raw.children)
      ? ((raw.children as BnBlock[]).map((c) => listItemFromBn(c, depth + 1)).filter(Boolean) as BuilderListItemBlock[])
      : [];
  return {
    id: String(raw.id ?? cryptoId()),
    type,
    content: inlineFromBn(raw.content),
    ...(children.length ? { children } : {}),
  };
}

function cryptoId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function bnToBuilderBlocks(blocks: unknown): BuilderBlock[] {
  if (!Array.isArray(blocks)) return [];
  const out: BuilderBlock[] = [];
  for (const raw of blocks as BnBlock[]) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id ?? cryptoId());
    const props = (raw.props ?? {}) as Record<string, unknown>;
    switch (raw.type) {
      case 'paragraph': {
        const align = alignFrom(raw.props, 'justify');
        out.push({ id, type: 'paragraph', ...(align ? { props: { align } } : {}), content: inlineFromBn(raw.content) });
        break;
      }
      case 'heading': {
        const level = props.level === 2 ? 2 : props.level === 3 ? 3 : 1;
        const align = alignFrom(raw.props, 'center');
        out.push({ id, type: 'heading', props: { level, ...(align ? { align } : {}) }, content: inlineFromBn(raw.content) });
        break;
      }
      case 'bulletListItem':
      case 'numberedListItem': {
        const item = listItemFromBn(raw, 1);
        if (item) out.push(item);
        break;
      }
      case 'table': {
        const content = (raw.content ?? {}) as Record<string, unknown>;
        const rowsRaw = Array.isArray(content.rows) ? (content.rows as BnBlock[]) : [];
        const rows = rowsRaw
          .map((r) => ({ cells: (Array.isArray(r.cells) ? (r.cells as unknown[]) : []).map(cellInlines) }))
          .filter((r) => r.cells.length > 0);
        if (!rows.length) break;
        const widths = Array.isArray(content.columnWidths)
          ? (content.columnWidths as unknown[]).map((w) => (typeof w === 'number' && w > 0 ? w : 1))
          : undefined;
        const headerRows = typeof content.headerRows === 'number' ? content.headerRows : 0;
        out.push({
          id,
          type: 'table',
          ...(widths?.some((w) => w !== 1) || headerRows > 0
            ? { props: { ...(widths?.some((w) => w !== 1) ? { columnWidths: widths } : {}), ...(headerRows > 0 ? { headerRow: true } : {}) } }
            : {}),
          rows,
        });
        break;
      }
      case 'requisites':
        out.push({ id, type: 'requisites', ...(props.showLogo === false ? { props: { showLogo: false } } : {}) });
        break;
      case 'docMeta': {
        const raw2 = typeof props.align === 'string' && ALIGNS.has(props.align) ? (props.align as 'left' | 'center' | 'right' | 'justify') : 'left';
        out.push({ id, type: 'docMeta', ...(raw2 !== 'left' ? { props: { align: raw2 } } : {}) });
        break;
      }
      case 'signature': {
        const nameSource = ['subject', 'director', 'counterparty', 'custom', 'none'].includes(String(props.nameSource))
          ? (String(props.nameSource) as 'subject' | 'director' | 'counterparty' | 'custom' | 'none')
          : 'none';
        out.push({
          id,
          type: 'signature',
          props: {
            role: String(props.role ?? 'Подпись'),
            nameSource,
            ...(props.customName ? { customName: String(props.customName) } : {}),
            ...(props.stamp === true ? { stamp: true } : {}),
          },
        });
        break;
      }
      case 'pageBreak':
        out.push({ id, type: 'pageBreak' });
        break;
      default:
        break;
    }
  }
  return out;
}

export function bnToBuilderDoc(blocks: unknown, page?: BuilderDoc['page']): BuilderDoc {
  return { version: DOC_BUILDER_VERSION, ...(page ? { page } : {}), blocks: bnToBuilderBlocks(blocks) };
}
