'use client';

import { Icon } from '@/components/ui';
// ============================================================
// ChronicleFeed — переиспользуемая лента хроники (core/chatter).
// Первый потребитель — «Журнал организации»; позже — секции «История»
// на детальных страницах записей. Презентационный компонент: данные
// (страницы ChatterPageDto) грузит родитель.
//
// МУЛЬТИЯЗЫЧНОСТЬ. Текст записи приходит от API ГОТОВЫМ (`entry.text`) — сервер
// собрал его из структуры в языке запроса. Каталог шаблонов хроники (134 типа)
// на клиент не едет вовсе, а компонент остаётся вставляемым в любой сервис:
// его собственные подписи взяты из `common`, который есть на каждой странице.
// ============================================================

import React, { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  CHATTER_REGISTRY,
  type ChatterActorLite,
  type ChatterChange,
  type ChatterEntryDto,
  type ChatterTypeMeta,
} from '@superapp/shared';
import { PersonAvatar } from '@/app/messenger/messenger-ui';
import { BotAvatar } from '@/components/keys/BotChip';
import { PersonChip } from '@/app/circles/PersonCard';
import { localDayKey } from '@/lib/day-groups';
import { useDayLabel, useFormatters } from '@/lib/format';

const REGISTRY = CHATTER_REGISTRY as Record<string, ChatterTypeMeta>;

export function ChronicleFeed({
  entries,
  actors,
  emptyText,
}: {
  entries: ChatterEntryDto[];
  actors: Record<string, ChatterActorLite>;
  /** Своя формулировка пустоты; не задана — общая из каталога. */
  emptyText?: string;
}) {
  const t = useTranslations('common');
  const dayLabel = useDayLabel();
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
        {emptyText ?? t('chronicle.empty')}
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
            {dayLabel(day)}
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
  dash: string,
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
    // Значения берём СОБРАННЫЕ сервером: снимок записи мог быть в другом языке
    // (слово-ключ) или в другом формате (дата), и чип не нашёлся бы в тексте.
    const from = change.display?.from ?? change.from ?? dash;
    const to = change.display?.to ?? change.to ?? dash;
    const candidates = [`${from} → ${to}`, `«${from}» → «${to}»`];
    for (const c of candidates) {
      const j = rest.indexOf(c);
      if (j >= 0) {
        if (j > 0) nodes.push(<span key={key++}>{rest.slice(0, j)}</span>);
        nodes.push(<DiffChips key={key++} from={from} to={to} />);
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
  const t = useTranslations('common');
  const fmt = useFormatters();
  const meta = REGISTRY[entry.typeKey];
  const dash = t('chronicle.emptyValue');
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

  // `entry.text` уже собран сервером в языке запроса — второй рендер на клиенте
  // означал бы вторую реализацию тех же правил и, рано или поздно, две разные фразы
  // об одном событии (ровно так когда-то разъехались плашка чата и журнал).
  const { nodes, diffInline } = buildSentence(entry.text, { targetUserId, targetName }, change, dash);
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
        {entry.actorId && actor?.kind === 'bot' ? (
          // Актор-бот (core/keys): бот-чип, не карточка человека (правило платформы §7.2)
          <BotAvatar name={actor.firstName} glyph={null} size="sm" />
        ) : entry.actorId ? (
          <PersonAvatar
            userId={entry.actorId}
            name={actor ? `${actor.firstName} ${actor.lastName ?? ''}`.trim() : entry.actorName ?? '?'}
            avatar={actor?.avatar ?? null}
            size="sm"
          />
        ) : (
          <div
            title={t('chronicle.system')}
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
              {t('chronicle.taskContext', { title: taskTitle })}
            </span>
          )}
        </div>
        {showChangeBelow && change && (
          <div style={{ marginTop: 'var(--spacing-1)' }}>
            <DiffChips
              from={change.display?.from ?? change.from ?? dash}
              to={change.display?.to ?? change.to ?? dash}
            />
          </div>
        )}
      </div>
      <span className="label-sm" style={{ flexShrink: 0, opacity: 0.7, marginTop: '0.2rem' }}>
        {fmt.time(entry.createdAt)}
      </span>
    </div>
  );
}

/** Чипы «было → стало»: старое зачёркнуто на приглушённой подложке, новое — на акцентной. */
function DiffChips({ from, to }: { from: string; to: string }) {
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
        {from}
      </span>
      <span aria-hidden style={{ fontSize: '0.8rem' }}><Icon name="arrowRight" size={15} /></span>
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
        {to}
      </span>
    </span>
  );
}
