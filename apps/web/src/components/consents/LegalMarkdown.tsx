import { Fragment, type ReactNode } from 'react';

// ============================================================
// Рендер юридического текста (markdown из core/consents) в React-элементы.
//
// Свой маленький разбор, а не библиотека и не `dangerouslySetInnerHTML`: текст приходит
// из базы, и единственный безопасный способ его показать — не превращать в HTML вовсе.
// Поддержано ровно то, чем написаны документы: заголовки `#`/`##`/`###`, абзацы,
// маркированные списки `- `, таблицы `| a | b |`, **жирный**. HTML-комментарии и любые
// теги выводятся как обычный текст (React экранирует их сам).
// ============================================================

type Block =
  | { kind: 'h'; level: 1 | 2 | 3; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] };

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

const isDivider = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

function parse(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: 'h', level: h[1]!.length as 1 | 2 | 3, text: h[2]!.trim() });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*]\s+/, '').trim());
        i++;
      }
      i--;
      blocks.push({ kind: 'ul', items });
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && isDivider(lines[i + 1]!)) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        rows.push(cells(lines[i]!));
        i++;
      }
      i--;
      blocks.push({ kind: 'table', head, rows });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

/** `**жирный**` → <strong>; всё остальное — текст. */
function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
  );
}

export function LegalMarkdown({ source, className }: { source: string; className?: string }) {
  const blocks = parse(source);
  return (
    <div className={className ? `legal-md ${className}` : 'legal-md'}>
      {blocks.map((b, i) => {
        if (b.kind === 'h') {
          if (b.level === 1) return <h2 key={i} className="legal-md-h1">{inline(b.text)}</h2>;
          if (b.level === 2) return <h3 key={i} className="legal-md-h2">{inline(b.text)}</h3>;
          return <h4 key={i} className="legal-md-h3">{inline(b.text)}</h4>;
        }
        if (b.kind === 'ul') {
          return (
            <ul key={i}>
              {b.items.map((item, j) => <li key={j}>{inline(item)}</li>)}
            </ul>
          );
        }
        if (b.kind === 'table') {
          return (
            <div key={i} className="legal-md-table-wrap">
              <table>
                <thead>
                  <tr>{b.head.map((c, j) => <th key={j} scope="col">{inline(c)}</th>)}</tr>
                </thead>
                <tbody>
                  {b.rows.map((row, r) => (
                    <tr key={r}>{row.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return <p key={i}>{inline(b.text)}</p>;
      })}
    </div>
  );
}
