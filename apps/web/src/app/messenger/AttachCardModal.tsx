'use client';

import { useEffect, useState } from 'react';
import type { RichCardRefType } from '@superapp/shared';
import { api } from '@/lib/api';
import { shareRichCard } from '@/lib/messenger-api';
import { errMsg } from './ShareCardModal';

// ============================================================
// Attach-card modal (flow A) — the composer paperclip 📎. Browse MY
// entities by service tab (Задачи / Календарь / Магазин); clicking one
// posts its live card into the CURRENTLY OPEN chat via POST /rich-cards/share.
// The card then arrives over socket — no manual cache poke needed.
// ============================================================

type TabKey = 'tasks' | 'calendar' | 'shop';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'tasks', label: 'Задачи' },
  { key: 'calendar', label: 'Календарь' },
  { key: 'shop', label: 'Магазин' },
];

/** A pickable entity row: what to render + how to share it. */
interface PickItem {
  key: string; // unique row key (entity id is reused, but be defensive)
  icon: string;
  title: string;
  subtitle?: string;
  refType: RichCardRefType;
  refId: string;
}

export function AttachCardModal({
  chatId,
  onClose,
  onShared,
}: {
  chatId: string;
  onClose: () => void;
  onShared?: () => void;
}) {
  const [tab, setTab] = useState<TabKey>('tasks');

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(56,57,45,0.35)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: '1rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card-elevated"
        style={{
          background: 'var(--surface-container-low)',
          padding: 'var(--spacing-6)',
          maxWidth: 460,
          width: '100%',
          maxHeight: '82vh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 'var(--radius-md)',
          transform: 'rotate(-0.3deg)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            marginBottom: 'var(--spacing-1)',
          }}
        >
          <h3 className="title-md">Отправить карточку</h3>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '1.2rem',
              color: 'var(--on-surface-variant)',
              opacity: 0.5,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        <p className="label-sm" style={{ opacity: 0.7, marginBottom: 'var(--spacing-4)' }}>
          Выберите свою задачу, событие или товар — карточка появится в этом чате.
        </p>

        {/* Service tabs */}
        <div
          style={{
            display: 'flex',
            gap: 'var(--spacing-1)',
            padding: '0.25rem',
            marginBottom: 'var(--spacing-4)',
            background: 'var(--surface-container)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                flex: 1,
                padding: '0.45rem 0.8rem',
                fontSize: '0.82rem',
                fontWeight: 600,
                border: 'none',
                cursor: 'pointer',
                borderRadius: 'var(--radius-sm)',
                background: tab === t.key ? 'var(--surface)' : 'none',
                color: tab === t.key ? 'var(--on-surface)' : 'var(--on-surface-variant)',
                boxShadow: tab === t.key ? '0 2px 10px rgba(56, 57, 45, 0.08)' : 'none',
                transition: 'background 0.15s ease',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Each tab keeps its own list state; mount one at a time so it lazy-loads on open. */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <EntityList key={tab} tab={tab} chatId={chatId} onShared={onShared} />
        </div>
      </div>
    </div>
  );
}

function EntityList({
  tab,
  chatId,
  onShared,
}: {
  tab: TabKey;
  chatId: string;
  onShared?: () => void;
}) {
  const [items, setItems] = useState<PickItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const [shared, setShared] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    setItems(null);
    setLoadError(null);
    loadEntities(tab)
      .then((rows) => active && setItems(rows))
      .catch((e) => active && setLoadError(errMsg(e, 'Не удалось загрузить')));
    return () => {
      active = false;
    };
  }, [tab]);

  const share = async (item: PickItem) => {
    if (sharing) return;
    setSharing(item.key);
    setShareError(null);
    try {
      await shareRichCard(chatId, item.refType, item.refId);
      setShared((s) => new Set(s).add(item.key));
      onShared?.();
    } catch (e) {
      setShareError(errMsg(e));
    } finally {
      setSharing(null);
    }
  };

  if (items === null && !loadError) {
    return <p className="label-sm" style={{ opacity: 0.7, padding: 'var(--spacing-3)' }}>Загрузка…</p>;
  }
  if (loadError) {
    return <p className="label-sm" style={{ color: 'var(--danger)', padding: 'var(--spacing-3)' }}>{loadError}</p>;
  }
  if (items && items.length === 0) {
    return (
      <p className="label-sm" style={{ opacity: 0.7, padding: 'var(--spacing-3)' }}>
        {tab === 'tasks' ? 'Задач пока нет.' : tab === 'calendar' ? 'Предстоящих событий нет.' : 'Товаров пока нет.'}
      </p>
    );
  }

  return (
    <>
      {shareError && (
        <p style={{ color: 'var(--danger)', fontSize: '0.8rem', marginBottom: 'var(--spacing-2)' }}>{shareError}</p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
        {(items ?? []).map((item) => {
          const done = shared.has(item.key);
          return (
            <button
              key={item.key}
              onClick={() => share(item)}
              disabled={!!sharing || done}
              className="card"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--spacing-3)',
                padding: '0.45rem 0.7rem',
                textAlign: 'left',
                cursor: done ? 'default' : 'pointer',
                opacity: sharing && sharing !== item.key ? 0.5 : 1,
              }}
            >
              <span style={{ fontSize: '1.3rem', flexShrink: 0, lineHeight: 1 }}>{item.icon}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    display: 'block',
                    fontSize: '0.88rem',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {item.title}
                </span>
                {item.subtitle && (
                  <span className="label-sm" style={{ fontSize: '0.7rem', opacity: 0.6 }}>{item.subtitle}</span>
                )}
              </span>
              {done ? (
                <span className="label-sm" style={{ fontSize: '0.72rem', color: 'var(--secondary)', flexShrink: 0 }}>
                  Отправлено ✓
                </span>
              ) : sharing === item.key ? (
                <span className="label-sm" style={{ fontSize: '0.72rem', opacity: 0.6, flexShrink: 0 }}>…</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </>
  );
}

// ============================================================
// Per-tab loaders. Each maps a service's "my entities" list into PickItems.
// ============================================================

async function loadEntities(tab: TabKey): Promise<PickItem[]> {
  if (tab === 'tasks') return loadTasks();
  if (tab === 'calendar') return loadEvents();
  return loadListings();
}

interface TaskRow {
  id: string;
  title: string;
  status?: string;
}
async function loadTasks(): Promise<PickItem[]> {
  // GET /tasks → { success, data: TaskRow[] } (same shape used by /tasks page).
  const res = await api.get('/tasks');
  const rows: TaskRow[] = res.data.data ?? [];
  return rows.map((t) => ({
    key: t.id,
    icon: '✅',
    title: t.title,
    refType: 'task' as const,
    refId: t.id,
  }));
}

interface CalendarItemRow {
  kind: 'event' | 'task';
  id: string;
  eventId?: string;
  title: string;
  start?: string;
  startTime?: string;
  ownerName?: string | null;
}
async function loadEvents(): Promise<PickItem[]> {
  // GET /calendar/events?from&to&layers=events → { items: CalendarItem[] }.
  // Window: now → +60 days. Keep only events I own/organize (no overlay ownerName),
  // dedupe recurring occurrences by their event id.
  const from = new Date();
  const to = new Date(Date.now() + 60 * 86_400_000);
  const res = await api.get('/calendar/events', {
    params: { from: from.toISOString(), to: to.toISOString(), layers: 'events' },
  });
  const items: CalendarItemRow[] = res.data.data?.items ?? [];
  const seen = new Set<string>();
  const out: PickItem[] = [];
  for (const it of items) {
    if (it.kind !== 'event') continue;
    if (it.ownerName) continue; // overlay (someone else's calendar) — not mine to share
    const id = it.eventId ?? it.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const when = it.start ?? it.startTime;
    out.push({
      key: id,
      icon: '📅',
      title: it.title,
      subtitle: when ? fmtWhen(when) : undefined,
      refType: 'event' as const,
      refId: id,
    });
  }
  return out;
}

interface ShowcaseRow {
  listings?: ListingRow[];
}
interface ListingRow {
  id: string;
  title: string;
  icon?: string | null;
  crowdfunding?: boolean;
}
async function loadListings(): Promise<PickItem[]> {
  // GET /shop → { shop, showcases: Showcase[] }. Showcase listings may be omitted in
  // the summary; fetch per-showcase listings to be safe.
  const res = await api.get('/shop');
  const showcases: (ShowcaseRow & { id?: string })[] = res.data.data?.showcases ?? [];
  const out: PickItem[] = [];
  const seen = new Set<string>();
  // Prefer inlined listings; otherwise fetch each showcase's listings.
  for (const sc of showcases) {
    let listings = sc.listings;
    if (!listings && sc.id) {
      try {
        const r = await api.get(`/shop/showcases/${sc.id}/listings`);
        listings = r.data.data ?? [];
      } catch {
        listings = [];
      }
    }
    for (const l of listings ?? []) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      out.push({
        key: l.id,
        icon: l.icon ?? (l.crowdfunding ? '🎯' : '🎁'),
        title: l.title,
        refType: l.crowdfunding ? ('crowdfunding' as const) : ('listing' as const),
        refId: l.id,
      });
    }
  }
  return out;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
