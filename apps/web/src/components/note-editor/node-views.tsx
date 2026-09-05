'use client';

import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView, NodeViewConstructor } from 'prosemirror-view';
import { Chip } from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { useFileUrl } from '@/lib/hooks/useFileUrl';

// ============================================================
// React-виды узлов поверх ProseMirror — СВОЙ мини-хост на порталах (без сторонних
// обёрток): NodeView создаёт DOM-контейнер и регистрирует React-элемент в реестре,
// редактор рисует реестр порталами. Правило платформы соблюдено: человек в тексте —
// PersonChip, не голый текст.
// ============================================================

export interface PortalEntry {
  key: string;
  container: HTMLElement;
  element: ReactElement;
}

export class PortalRegistry {
  private items = new Map<string, PortalEntry>();
  private listeners = new Set<() => void>();
  private seq = 0;

  nextKey(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  set(key: string, container: HTMLElement, element: ReactElement): void {
    this.items.set(key, { key, container, element });
    this.emit();
  }

  delete(key: string): void {
    if (this.items.delete(key)) this.emit();
  }

  list(): PortalEntry[] {
    return [...this.items.values()];
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/** Порталы реестра — рендерится внутри NoteEditor */
export function NodeViewPortals({ registry }: { registry: PortalRegistry }) {
  const [, force] = useState(0);
  useEffect(() => registry.subscribe(() => force((n) => n + 1)), [registry]);
  return <>{registry.list().map((p) => createPortal(p.element, p.container, p.key))}</>;
}

type Renderer = (node: PMNode, ctx: { view: EditorView; getPos: () => number | undefined }) => ReactElement;

/** Атомарный (без contentDOM) React-узел: инлайн или блок */
function reactAtom(registry: PortalRegistry, tag: 'span' | 'div', className: string, render: Renderer): NodeViewConstructor {
  return (node, view, getPos) => {
    const dom = document.createElement(tag);
    dom.className = className;
    dom.contentEditable = 'false';
    const key = registry.nextKey(node.type.name);
    const ctx = { view, getPos };
    registry.set(key, dom, render(node, ctx));
    const nv: NodeView = {
      dom,
      update(updated) {
        if (updated.type !== node.type) return false;
        registry.set(key, dom, render(updated, ctx));
        return true;
      },
      selectNode() {
        dom.classList.add('ne-selected');
      },
      deselectNode() {
        dom.classList.remove('ne-selected');
      },
      stopEvent(e) {
        // клики по чипу/картинке не должны переставлять каретку внутрь атома
        return e.type === 'mousedown' || e.type === 'click';
      },
      ignoreMutation: () => true,
      destroy() {
        registry.delete(key);
      },
    };
    return nv;
  };
}

// ---------------------------------------------------------------- компоненты

function MentionChip({ name, userId }: { name: string; userId: string }) {
  const [firstName, ...rest] = name.trim().split(/\s+/);
  return (
    <span className="ne-mention-chip" data-mention-id={userId} title={`@${name}`}>
      <PersonChip size="S" userId={userId} firstName={firstName || name} lastName={rest.join(' ') || null} />
    </span>
  );
}

function WikilinkChip({ noteId, title, onOpen }: { noteId: string; title: string; onOpen?: (noteId: string) => void }) {
  const router = useRouter();
  return (
    <Chip
      size="sm"
      tone="accent"
      icon="brackets"
      onClick={() => (onOpen ? onOpen(noteId) : router.push(`/notes/${noteId}`))}
    >
      {title || 'Заметка'}
    </Chip>
  );
}

function TagChip({ name, onClick }: { name: string; onClick?: (name: string) => void }) {
  return (
    <Chip size="sm" icon="hash" onClick={onClick ? () => onClick(name) : undefined}>
      {name}
    </Chip>
  );
}

function ImageBlock({
  fileId,
  alt,
  width,
  onResize,
  readOnly,
}: {
  fileId: string;
  alt: string | null;
  width: number | null;
  onResize: (width: number) => void;
  readOnly: boolean;
}) {
  // Один вариант, а не два: раньше рядом запрашивался оригинал и показывался ИМЕННО он —
  // 'medium' работал вхолостую, а в тексте висели полноразмерные файлы.
  const { url, isLoading } = useFileUrl(fileId, 'medium');
  const startX = useRef(0);
  const startW = useRef(0);
  const [liveW, setLiveW] = useState<number | null>(null);
  const figRef = useRef<HTMLElement | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (readOnly) return;
    e.preventDefault();
    startX.current = e.clientX;
    startW.current = figRef.current?.getBoundingClientRect().width ?? width ?? 320;
    const move = (ev: PointerEvent) => setLiveW(Math.max(80, Math.min(1400, Math.round(startW.current + (ev.clientX - startX.current)))));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const w = Math.max(80, Math.min(1400, Math.round(startW.current + (ev.clientX - startX.current))));
      setLiveW(null);
      onResize(w);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const shownW = liveW ?? width ?? undefined;
  return (
    <figure ref={figRef} className="ne-image" style={shownW ? { width: shownW } : undefined}>
      {url ? (
        <img src={url} alt={alt ?? ''} draggable={false} />
      ) : (
        <div className={`ne-image-ph${isLoading ? ' ne-image-ph--loading' : ''}`} aria-label="Изображение загружается" />
      )}
      {!readOnly && <span className="ne-image-handle" onPointerDown={onPointerDown} aria-hidden />}
      {alt ? <figcaption className="label-sm">{alt}</figcaption> : null}
    </figure>
  );
}

// ---------------------------------------------------------------- фабрика видов

export interface NodeViewOptions {
  readOnly: boolean;
  onWikilinkOpen?: (noteId: string) => void;
  onTagClick?: (name: string) => void;
}

export function buildNodeViews(registry: PortalRegistry, opts: NodeViewOptions): Record<string, NodeViewConstructor> {
  return {
    mention: reactAtom(registry, 'span', 'ne-atom ne-atom-inline', (node) => (
      <MentionChip name={node.attrs.name as string} userId={node.attrs.userId as string} />
    )),
    wikilink: reactAtom(registry, 'span', 'ne-atom ne-atom-inline', (node) => (
      <WikilinkChip noteId={node.attrs.noteId as string} title={node.attrs.title as string} onOpen={opts.onWikilinkOpen} />
    )),
    tag: reactAtom(registry, 'span', 'ne-atom ne-atom-inline', (node) => <TagChip name={node.attrs.name as string} onClick={opts.onTagClick} />),
    image: reactAtom(registry, 'div', 'ne-atom ne-atom-block', (node, { view, getPos }) => (
      <ImageBlock
        fileId={node.attrs.fileId as string}
        alt={(node.attrs.alt as string | null) ?? null}
        width={(node.attrs.width as number | null) ?? null}
        readOnly={opts.readOnly}
        onResize={(w) => {
          const pos = getPos();
          if (pos === undefined) return;
          view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, width: w }));
        }}
      />
    )),
    // Чекбокс задачи — чистый DOM (без React): клик по нему меняет атрибут, а не каретку
    taskItem: (node, view, getPos) => {
      const dom = document.createElement('li');
      dom.setAttribute('data-task-item', '');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'ne-task-box';
      box.contentEditable = 'false';
      box.setAttribute('aria-label', 'Выполнено');
      box.checked = !!node.attrs.checked;
      box.disabled = opts.readOnly;
      const content = document.createElement('div');
      content.className = 'ne-task-content';
      dom.append(box, content);
      const sync = (n: PMNode) => {
        box.checked = !!n.attrs.checked;
        dom.setAttribute('data-checked', String(!!n.attrs.checked));
      };
      sync(node);
      box.addEventListener('mousedown', (e) => e.preventDefault());
      box.addEventListener('click', (e) => {
        e.preventDefault();
        const pos = getPos();
        if (pos === undefined || opts.readOnly) return;
        const current = view.state.doc.nodeAt(pos);
        if (!current) return;
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, checked: !current.attrs.checked }));
      });
      return {
        dom,
        contentDOM: content,
        update(updated) {
          if (updated.type !== node.type) return false;
          sync(updated);
          return true;
        },
        stopEvent: (e) => e.target === box,
        ignoreMutation: (m) => m.target === box || (m.type === 'attributes' && m.target === dom),
      };
    },
  };
}
