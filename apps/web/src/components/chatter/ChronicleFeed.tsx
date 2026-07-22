'use client';

// ============================================================
// ChronicleFeed — переиспользуемая лента хроники (core/chatter).
// Первый потребитель — «Журнал организации»; позже — секции «История»
// на детальных страницах записей. Презентационный компонент: данные
// (страницы ChatterPageDto) грузит родитель.
// ============================================================

import React, { useMemo } from 'react';
import {
  CHATTER_REGISTRY,
  renderChatterText,
  type ChatterActorLite,
  type ChatterChange,
  type ChatterEntryDto,
  type ChatterTypeMeta,
} from '@superapp/shared';
import { PersonAvatar } from '@/app/messenger/messenger-ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { localDayKey, formatDayLabel } from '@/lib/day-groups';

const REGISTRY = CHATTER_REGISTRY as Record<string, ChatterTypeMeta>;

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function ChronicleFeed({
  entries,
  actors,
  emptyText = 'Пока пусто — события появятся здесь',
}: {
  entries: ChatterEntryDto[];
  actors: Record<string, ChatterActorLite>;
  emptyText?: string;
}) {
  // Группировка по ЛОКАЛЬНОЙ дате зрителя (не по UTC-срезу createdAt) — иначе ночные
  // события уезжали в чужой день и давали две секции «Сегодня» подряд.
  const groups = useMemo(() => {
    const byDay = new Map<string, ChatterEntryDto[]>();
    for (const e of entries) {
      const key = localDayKey(e.createdAt);
      const list = byDay.get(key) ?? [];
      list.push(e);
      byDay.set(key, list);
    }
    return [...byDay.entries()];
  }, [entries]);

  if (entries.length === 0) {
    return (
      <p className="label-md" style={{ padding: 'var(--spacing-4) var(--spacing-2)' }}>
        {emptyText}
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-6)' }}>
      {groups.map(([day, list]) => (
        <div key={day}>
          <div
            className="label-md"
            style={{
              fontWeight: 700,
              marginBottom: 'var(--spacing-3)',
              paddingLeft: 'var(--spacing-2)',
            }}
          >
            {formatDayLabel(day)}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
            {list.map((e) => (
              <ChronicleRow key={e.id} entry={e} actor={e.actorId ? actors[e.actorId] : undefined} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Собирает предложение хроники в узлы: сегменты текста + PersonChip ЦЕЛЕВОГО человека
 * (Принцип 2 — человек только через карточку, ради видимости платных скинов) + чипы
 * «было → стало». Сначала подставляем чип цели по её имени, затем в остатке — дифф
 * (пробуем «сырой» и обёрнутый в «» вариант: task.title_changed заворачивает значения).
 */
function buildSentence(
  text: string,
  target: { targetUserId: string | null; targetName: string | null },
  change: ChatterChange | null,
): { nodes: React.ReactNode[]; diffInline: boolean } {
  const nodes: React.ReactNode[] = [];
  let rest = text;
  let key = 0;

  if (target.targetUserId && target.targetName && rest.includes(target.targetName)) {
    const i = rest.indexOf(target.targetName);
    if (i > 0) nodes.push(<span key={key++}>{rest.slice(0, i)}</span>);
    nodes.push(
      <PersonChip key={key++} size="S" userId={target.targetUserId} firstName={target.targetName} />,
    );
    rest = rest.slice(i + target.targetName.length);
  }

  let diffInline = false;
  if (change) {
    const candidates = [
      `${change.from ?? '—'} → ${change.to ?? '—'}`,
      `«${change.from ?? '—'}» → «${change.to ?? '—'}»`,
    ];
    for (const c of candidates) {
      const j = rest.indexOf(c);
      if (j >= 0) {
        if (j > 0) nodes.push(<span key={key++}>{rest.slice(0, j)}</span>);
        nodes.push(<DiffChips key={key++} from={change.from} to={change.to} />);
        rest = rest.slice(j + c.length);
        diffInline = true;
        break;
      }
    }
  }

  if (rest) nodes.push(<span key={key++}>{rest}</span>);
  return { nodes, diffInline };
}

function ChronicleRow({
  entry,
  actor,
}: {
  entry: ChatterEntryDto;
  actor?: ChatterActorLite;
}) {
  const meta = REGISTRY[entry.typeKey];
  const text = renderChatterText(entry.typeKey, entry);
  const change = entry.changes?.[0] ?? null;
  const targetUserId =
    typeof entry.payload?.targetUserId === 'string' ? entry.payload.targetUserId : null;
  const targetName =
    typeof entry.payload?.targetName === 'string' ? entry.payload.targetName : null;
  // Контекст записи для сводного журнала: у task-событий текст плашки не несёт
  // название задачи (в чате оно и не нужно) — показываем суффиксом.
  const taskTitle =
    entry.refType === 'task' && typeof entry.payload?.taskTitle === 'string'
      ? (entry.payload.taskTitle as string)
      : null;

  const { nodes, diffInline } = buildSentence(text, { targetUserId, targetName }, change);
  const showChangeBelow = !!change && !diffInline;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--spacing-3)',
        padding: 'var(--spacing-3) var(--spacing-4)',
        borderRadius: 'var(--radius-sketch)',
        background: 'var(--surface-container-lowest)',
      }}
    >
      <span style={{ fontSize: '1.05rem', lineHeight: '1.6rem', flexShrink: 0 }} aria-hidden>
        {meta?.icon ?? '•'}
      </span>
      <div style={{ flexShrink: 0, marginTop: '0.1rem' }}>
        {entry.actorId ? (
          <PersonAvatar
            userId={entry.actorId}
            name={actor ? `${actor.firstName} ${actor.lastName ?? ''}`.trim() : entry.actorName ?? '?'}
            avatar={actor?.avatar ?? null}
            size="sm"
          />
        ) : (
          <div
            title="Система"
            style={{
              width: '1.8rem',
              height: '1.8rem',
              borderRadius: '50%',
              background: 'var(--surface-container)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.85rem',
            }}
          >
            ⚙️
          </div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: '0.92rem',
            lineHeight: 1.6,
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '0.3rem',
          }}
        >
          {nodes}
          {taskTitle && (
            <span className="label-md" style={{ fontSize: '0.85rem' }}>
              · Задача «{taskTitle}»
            </span>
          )}
        </div>
        {showChangeBelow && change && (
          <div style={{ marginTop: 'var(--spacing-1)' }}>
            <DiffChips from={change.from} to={change.to} />
          </div>
        )}
      </div>
      <span className="label-sm" style={{ flexShrink: 0, opacity: 0.7, marginTop: '0.2rem' }}>
        {timeLabel(entry.createdAt)}
      </span>
    </div>
  );
}

/** Чипы «было → стало»: старое зачёркнуто на приглушённой подложке, новое — на акцентной. */
function DiffChips({ from, to }: { from: string | null; to: string | null }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', margin: '0 0.15rem' }}>
      <span
        className="label-sm"
        style={{
          background: 'var(--surface-container)',
          padding: '0.05rem 0.5rem',
          borderRadius: 'var(--radius-sketch)',
          textDecoration: 'line-through',
          opacity: 0.75,
          whiteSpace: 'nowrap',
        }}
      >
        {from ?? '—'}
      </span>
      <span aria-hidden style={{ fontSize: '0.8rem' }}>→</span>
      <span
        className="label-sm"
        style={{
          background: 'var(--secondary-container)',
          padding: '0.05rem 0.5rem',
          borderRadius: 'var(--radius-sketch)',
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        {to ?? '—'}
      </span>
    </span>
  );
}
