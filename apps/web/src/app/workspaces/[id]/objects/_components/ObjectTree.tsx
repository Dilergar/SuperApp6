'use client';

// ============================================================
// Дерево объектов: строки с направляющими по уровню, значок вида, чипы состояния.
//
// Сеть — это сотни объектов, поэтому список УМЕЕТ сворачиваться и искаться:
// плоская простыня на 300 точек не читается и не листается. Оба состояния
// локальные — это способ смотреть, а не данные (в URL и на сервер не едут).
//
// Уровень показывает НАПРАВЛЯЮЩАЯ ЛИНИЯ на каждый шаг вложенности, а не отступ:
// отступ приходилось ограничивать (на 375 px шесть уровней по 20 px съедали
// половину строки), и после четвёртого уровня вложенность переставала читаться
// вовсе — этаж и зона выглядели соседями.
//
// Мобилка — тот же список (проваливание внутрь по клику), без второй вёрстки.
// ============================================================

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { OBJECT_KINDS, type ObjectNodeDto } from '@superapp/shared';
import { Button, Chip, EmptyState, Glyph, Icon, SearchField, type IconName } from '@/components/ui';

const KIND_META = new Map(OBJECT_KINDS.map((k) => [k.value, k]));

/** Ширина одной направляющей — она же шаг вложенности. */
const GUIDE_WIDTH = 14;

function haystack(n: ObjectNodeDto): string {
  return [n.name, n.address, KIND_META.get(n.kind)?.label].filter(Boolean).join(' ').toLowerCase();
}

export function ObjectTree({
  workspaceId,
  nodes,
  onAddChild,
}: {
  workspaceId: string;
  nodes: ObjectNodeDto[];
  onAddChild?: (parent: ObjectNodeDto) => void;
}) {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const query = search.trim().toLowerCase();

  /** У кого есть дети — только у них есть каретка сворачивания. */
  const hasChildren = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) if (n.parentId) set.add(n.parentId);
    return set;
  }, [nodes]);

  const visible = useMemo(() => {
    if (query) {
      // Найденный узел показывается ВМЕСТЕ с предками: иначе «Зона выдачи»
      // висит в воздухе и непонятно, в каком она здании. Свёрнутость на время
      // поиска не действует — прятать найденное было бы издевательством.
      const keep = new Set<string>();
      for (const n of nodes) {
        if (!haystack(n).includes(query)) continue;
        keep.add(n.id);
        for (const a of n.ancestorIds) keep.add(a);
      }
      return nodes.filter((n) => keep.has(n.id));
    }
    if (collapsed.size === 0) return nodes;
    return nodes.filter((n) => !n.ancestorIds.some((a) => collapsed.has(a)));
  }, [nodes, query, collapsed]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allCollapsed = hasChildren.size > 0 && collapsed.size >= hasChildren.size;

  return (
    <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
      {(nodes.length > 8 || hasChildren.size > 0) && (
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', alignItems: 'center' }}>
          <SearchField
            placeholder="Название, адрес, вид…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {hasChildren.size > 0 && (
            <Button
              size="sm"
              variant="ghost"
              icon={allCollapsed ? 'caretDown' : 'caretRight'}
              onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(hasChildren))}
            >
              {allCollapsed ? 'Развернуть всё' : 'Свернуть всё'}
            </Button>
          )}
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon="search"
          title="Ничего не нашлось"
          description="Попробуйте другое слово — поиск идёт по названию, адресу и виду объекта."
        />
      ) : (
        <div className="ui-stack" style={{ gap: 'var(--spacing-1)' }}>
          {visible.map((n) => (
            <ObjectRow
              key={n.id}
              workspaceId={workspaceId}
              node={n}
              expandable={hasChildren.has(n.id) && !query}
              collapsed={collapsed.has(n.id)}
              onToggle={() => toggle(n.id)}
              onAddChild={onAddChild}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ObjectRow({
  workspaceId,
  node,
  expandable,
  collapsed,
  onToggle,
  onAddChild,
}: {
  workspaceId: string;
  node: ObjectNodeDto;
  expandable: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onAddChild?: (parent: ObjectNodeDto) => void;
}) {
  const kind = KIND_META.get(node.kind);
  const openable = node.caps.view;
  const inner = (
    <>
      <span
        style={{
          width: 34,
          height: 34,
          flex: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 'var(--radius-md)',
          background: 'var(--surface-container)',
          color: 'var(--on-surface-variant)',
        }}
      >
        {node.glyph ? <Glyph value={node.glyph} size={18} /> : <Icon name={(kind?.icon ?? 'workspace') as IconName} size={18} />}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>{node.name}</span>
          {node.isDefault && <Chip tone="accent">Основной</Chip>}
          {node.archivedAt && <Chip tone="neutral">В архиве</Chip>}
          {!openable && <Chip tone="neutral">Нет доступа</Chip>}
        </span>
        <span className="label-sm" style={{ display: 'block', opacity: 0.7 }}>
          {[
            kind?.label,
            node.address,
            node.headPositionName ? `Управляет: ${node.headPositionName}` : null,
            node.membersCount ? `${node.membersCount} чел.` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
    </>
  );

  return (
    // alignItems: stretch — направляющие тянутся на всю высоту строки, включая
    // случай, когда имя перенеслось на две-три строки на узком экране.
    <div style={{ display: 'flex', alignItems: 'stretch' }}>
      {Array.from({ length: node.depth }, (_, i) => (
        <span
          key={i}
          aria-hidden
          style={{ width: GUIDE_WIDTH, flex: 'none', borderLeft: '1px solid var(--line)' }}
        />
      ))}
      <div
        style={{
          display: 'flex',
          // flex-start, а не center: на 375 px имя переносится на 2–3 строки, и
          // вертикально центрированный значок «уплывал» от первой строки.
          alignItems: 'flex-start',
          gap: 'var(--spacing-2)',
          flex: 1,
          minWidth: 0,
          padding: 'var(--spacing-2) var(--spacing-3)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--outline-variant)',
          background: 'var(--surface)',
          opacity: node.archivedAt ? 0.65 : 1,
        }}
      >
        {expandable ? (
          <button
            type="button"
            aria-label={collapsed ? `Развернуть «${node.name}»` : `Свернуть «${node.name}»`}
            aria-expanded={!collapsed}
            onClick={onToggle}
            style={{
              flex: 'none',
              width: 24,
              height: 34,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--on-surface-variant)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
            }}
          >
            <Icon name={collapsed ? 'caretRight' : 'caretDown'} size={14} />
          </button>
        ) : (
          <span style={{ flex: 'none', width: 24 }} aria-hidden />
        )}
        {openable ? (
          <Link
            href={`/workspaces/${workspaceId}/objects/${node.id}`}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 'var(--spacing-3)',
              flex: 1,
              minWidth: 0,
              color: 'inherit',
              textDecoration: 'none',
            }}
          >
            {inner}
          </Link>
        ) : (
          <span style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--spacing-3)', flex: 1, minWidth: 0 }}>
            {inner}
          </span>
        )}
        {node.caps.manage && onAddChild && (
          <button
            type="button"
            aria-label={`Добавить объект внутри «${node.name}»`}
            onClick={() => onAddChild(node)}
            style={{
              flex: 'none',
              width: 30,
              height: 30,
              borderRadius: 'var(--radius-pill)',
              border: '1px solid var(--outline-variant)',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--on-surface-variant)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="add" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
