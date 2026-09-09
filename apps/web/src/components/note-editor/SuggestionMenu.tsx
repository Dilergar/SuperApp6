'use client';

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import type { Command } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { NoteSpaceRef } from '@superapp/shared';
import { Icon, type IconName } from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { loadEntities } from '@/lib/entities';
import { fetchWikilinkCandidates } from '@/lib/notes-api';
import { cmd } from './plugins';
import type { SuggestionKind, SuggestionMatch } from './suggestion';

// ============================================================
// Меню подсказок у каретки: люди (ростер организации / личное окружение),
// заметки пространства, теги, блоки по «/». Клавиатуру отдаёт редактор через
// controllerRef (стрелки, Enter, Tab, Esc) — фокус остаётся в тексте.
// ============================================================

export interface SuggestionItem {
  kind: SuggestionKind;
  id: string;
  title: string;
  subtitle?: string | null;
  icon?: IconName;
  /** Человек — рисуется карточкой */
  person?: { firstName: string; lastName: string | null };
  command?: Command;
}

export interface SuggestionController {
  onKeyDown(e: KeyboardEvent): boolean;
}

// Реестр команды «/» называет ДЕЙСТВИЕ ключом каталога; слово ему даёт каталог в
// языке зрителя — по нему же идёт и фильтрация набранного после «/».
const SLASH_ITEMS: Array<Omit<SuggestionItem, 'title'> & { titleKey: string }> = [
  { kind: 'slash', id: 'h1', titleKey: 'editor.heading1', icon: 'headingOne', command: cmd.setBlock('heading1') },
  { kind: 'slash', id: 'h2', titleKey: 'editor.heading2', icon: 'headingTwo', command: cmd.setBlock('heading2') },
  { kind: 'slash', id: 'h3', titleKey: 'editor.heading3', icon: 'headingThree', command: cmd.setBlock('heading3') },
  { kind: 'slash', id: 'bullet', titleKey: 'editor.bullet', icon: 'listBullets', command: cmd.toggleList('bullet') },
  { kind: 'slash', id: 'ordered', titleKey: 'editor.ordered', icon: 'listNumbers', command: cmd.toggleList('ordered') },
  { kind: 'slash', id: 'task', titleKey: 'editor.task', icon: 'tasks', command: cmd.toggleList('task') },
  { kind: 'slash', id: 'quote', titleKey: 'editor.quote', icon: 'quotes', command: cmd.toggleBlockquote },
  { kind: 'slash', id: 'code', titleKey: 'editor.codeBlock', icon: 'code', command: cmd.setBlock('codeBlock') },
  { kind: 'slash', id: 'table', titleKey: 'editor.table', icon: 'table', command: cmd.insertTable(3, 3) },
  { kind: 'slash', id: 'hr', titleKey: 'editor.divider', icon: 'minus', command: cmd.insertHorizontalRule },
  // Картинку вставляет не команда, а файловый пикер (NoteEditor ловит id 'image');
  // команда здесь — заглушка-нет-опа, чтобы пункт не притворялся другим действием.
  { kind: 'slash', id: 'image', titleKey: 'editor.image', icon: 'image', command: () => false },
];

interface Props {
  match: SuggestionMatch;
  view: EditorView | null;
  scope: NoteSpaceRef;
  noteId?: string;
  tags: string[];
  canUpload: boolean;
  onPick: (item: SuggestionItem, match: SuggestionMatch) => void;
  onClose: () => void;
  controllerRef: MutableRefObject<SuggestionController | null>;
}

export function SuggestionMenu({ match, view, scope, noteId, tags, canUpload, onPick, onClose, controllerRef }: Props) {
  const t = useTranslations('notes');
  const [items, setItems] = useState<SuggestionItem[]>([]);
  const [index, setIndex] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const seq = useRef(0);

  // ---- позиция у каретки
  useEffect(() => {
    if (!view) return;
    try {
      const c = view.coordsAtPos(match.from);
      const below = window.innerHeight - c.bottom;
      setPos({ top: below < 240 ? Math.max(8, c.top - 244) : c.bottom + 6, left: Math.min(c.left, window.innerWidth - 300) });
    } catch {
      setPos(null);
    }
  }, [view, match.from, match.to]);

  // ---- кандидаты
  const q = match.query.trim().toLowerCase();
  useEffect(() => {
    const my = ++seq.current;
    const apply = (list: SuggestionItem[]) => {
      if (seq.current !== my) return;
      setItems(list.slice(0, 8));
      setIndex(0);
    };
    if (match.kind === 'slash') {
      apply(
        SLASH_ITEMS.map<SuggestionItem>((it) => ({ ...it, title: t(it.titleKey) })).filter(
          (it) => (it.id !== 'image' || canUpload) && (!q || it.title.toLowerCase().includes(q)),
        ),
      );
      return;
    }
    if (match.kind === 'tag') {
      const list = tags
        .filter((tag) => !q || tag.includes(q))
        .map<SuggestionItem>((tag) => ({ kind: 'tag', id: tag, title: `#${tag}`, icon: 'hash' }));
      if (q && !tags.includes(q)) list.unshift({ kind: 'tag', id: q, title: `#${q}`, subtitle: t('editor.newTag'), icon: 'hash' });
      apply(list);
      return;
    }
    if (match.kind === 'mention') {
      loadEntities('user', scope.workspaceId ? { workspaceId: scope.workspaceId } : undefined)
        .then((opts) =>
          apply(
            opts
              .filter((o) => !q || o.title.toLowerCase().includes(q))
              .map<SuggestionItem>((o) => ({
                kind: 'mention',
                id: o.id,
                title: o.title,
                subtitle: o.role ?? null,
                person: { firstName: o.firstName ?? o.title, lastName: o.lastName ?? null },
              })),
          ),
        )
        .catch(() => apply([]));
      return;
    }
    if (match.kind === 'wikilink') {
      const t = setTimeout(() => {
        fetchWikilinkCandidates(scope, match.query.trim(), noteId)
          .then((rows) => apply(rows.map<SuggestionItem>((r) => ({ kind: 'wikilink', id: r.id, title: r.title, subtitle: r.folderName, icon: 'brackets' }))))
          .catch(() => apply([]));
      }, 150);
      return () => clearTimeout(t);
    }
  }, [match.kind, match.query, q, scope, noteId, tags, canUpload]);

  // ---- клавиатура от редактора
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const indexRef = useRef(index);
  indexRef.current = index;
  useEffect(() => {
    controllerRef.current = {
      onKeyDown(e) {
        const list = itemsRef.current;
        if (e.key === 'Escape') {
          onClose();
          return true;
        }
        if (!list.length) return false;
        if (e.key === 'ArrowDown') {
          setIndex((i) => (i + 1) % list.length);
          return true;
        }
        if (e.key === 'ArrowUp') {
          setIndex((i) => (i - 1 + list.length) % list.length);
          return true;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          onPick(list[indexRef.current], match);
          return true;
        }
        return false;
      },
    };
    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef, match, onClose, onPick]);

  const empty = useMemo(() => {
    if (items.length) return null;
    if (match.kind === 'mention') return t('editor.nobodyFound');
    if (match.kind === 'wikilink') return q ? t('editor.notesNotFound') : t('editor.wikilinkHint');
    return null;
  }, [items.length, match.kind, q, t]);

  if (!pos || (!items.length && !empty)) return null;
  return createPortal(
    <div className="ne-suggest card-elevated" style={{ top: pos.top, left: pos.left }} role="listbox" aria-label={t('editor.suggestAria')}>
      {items.map((it, i) => (
        <button
          key={`${it.kind}:${it.id}`}
          type="button"
          role="option"
          aria-selected={i === index}
          className="ne-suggest-item"
          data-active={i === index}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(it, match)}
          onMouseEnter={() => setIndex(i)}
        >
          {it.person ? (
            <PersonChip size="S" userId={it.id} firstName={it.person.firstName} lastName={it.person.lastName} role={it.subtitle ?? null} />
          ) : (
            <>
              {it.icon && <Icon name={it.icon} size={16} />}
              <span className="ne-suggest-title">{it.title}</span>
              {it.subtitle && <span className="ne-suggest-sub label-sm">{it.subtitle}</span>}
            </>
          )}
        </button>
      ))}
      {empty && <div className="ne-suggest-empty label-sm">{empty}</div>}
    </div>,
    document.body,
  );
}
