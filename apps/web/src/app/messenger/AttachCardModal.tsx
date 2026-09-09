'use client';

import { CloseChip, Glyph, ModalShell } from '@/components/ui';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Formatters } from '@superapp/i18n/format';
import { useFormatters } from '@/lib/format';
import type {
  CalendarRangeResponse,
  Listing,
  OffsetPage,
  RichCardRefType,
  ShopOverviewDto,
  Task,
} from '@superapp/shared';
import { apiGet } from '@/lib/api';
import { shareRichCard } from '@/lib/messenger-api';
import { errMsg } from './ShareCardModal';

// ============================================================
// Attach-card modal (flow A) — the composer paperclip 📎. Browse MY
// entities by service tab (Задачи / Календарь / Магазин); clicking one
// posts its live card into the CURRENTLY OPEN chat via POST /rich-cards/share.
// The card then arrives over socket — no manual cache poke needed.
// ============================================================

type TabKey = 'tasks' | 'calendar' | 'shop';

const TABS: { key: TabKey; labelKey: string }[] = [
  { key: 'tasks', labelKey: 'attachCard.tasks' },
  { key: 'calendar', labelKey: 'attachCard.calendar' },
  { key: 'shop', labelKey: 'attachCard.shop' },
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

/** Значок карточки — разбор значения делает кит (`Glyph`). */
const CardGlyph = ({ icon }: { icon: string }) => <Glyph value={icon} size={20} />;

export function AttachCardModal({
  chatId,
  onClose,
  onShared,
}: {
  chatId: string;
  onClose: () => void;
  onShared?: () => void;
}) {
  const t = useTranslations('messenger');
  const [tab, setTab] = useState<TabKey>('tasks');

  return (
    <ModalShell onClose={onClose} zIndex={100}>
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
          <h3 className="title-md">{t('attachCard.title')}</h3>
          <CloseChip onClick={onClose} />
        </div>
        <p className="label-sm" style={{ opacity: 0.7, marginBottom: 'var(--spacing-4)' }}>
          {t('attachCard.subtitle')}
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
          {TABS.map((entry) => (
            <button
              key={entry.key}
              onClick={() => setTab(entry.key)}
              style={{
                flex: 1,
                padding: '0.45rem 0.8rem',
                fontSize: '0.82rem',
                fontWeight: 600,
                border: 'none',
                cursor: 'pointer',
                borderRadius: 'var(--radius-sm)',
                background: tab === entry.key ? 'var(--surface)' : 'none',
                color: tab === entry.key ? 'var(--on-surface)' : 'var(--on-surface-variant)',
                boxShadow: tab === entry.key ? 'var(--shadow-card)' : 'none',
                transition: 'background 0.15s ease',
              }}
            >
              {t(entry.labelKey)}
            </button>
          ))}
        </div>

        {/* Each tab keeps its own list state; mount one at a time so it lazy-loads on open. */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <EntityList key={tab} tab={tab} chatId={chatId} onShared={onShared} />
        </div>
      </div>
    </ModalShell>
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
  const t = useTranslations('messenger');
  const tc = useTranslations('common');
  // Дата события в подзаголовке — форматтерами языка и региона: своя строка
  // `toLocaleDateString('ru-RU')` зашивала бы и язык, и страну навсегда.
  const fmt = useFormatters();
  const [items, setItems] = useState<PickItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const [shared, setShared] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    setItems(null);
    setLoadError(null);
    loadEntities(tab, fmt)
      .then((rows) => active && setItems(rows))
      .catch((e) => active && setLoadError(errMsg(e, t('attachCard.loadFailed'))));
    return () => {
      active = false;
    };
  }, [tab, fmt, t]);

  const share = async (item: PickItem) => {
    if (sharing) return;
    setSharing(item.key);
    setShareError(null);
    try {
      await shareRichCard(chatId, item.refType, item.refId);
      setShared((s) => new Set(s).add(item.key));
      onShared?.();
    } catch (e) {
      setShareError(errMsg(e, t('card.actionFailed')));
    } finally {
      setSharing(null);
    }
  };

  if (items === null && !loadError) {
    return <p className="label-sm" style={{ opacity: 0.7, padding: 'var(--spacing-3)' }}>{tc('state.loading')}</p>;
  }
  if (loadError) {
    return <p className="label-sm" style={{ color: 'var(--danger)', padding: 'var(--spacing-3)' }}>{loadError}</p>;
  }
  if (items && items.length === 0) {
    return (
      <p className="label-sm" style={{ opacity: 0.7, padding: 'var(--spacing-3)' }}>
        {tab === 'tasks' ? t('attachCard.emptyTasks') : tab === 'calendar' ? t('attachCard.emptyCalendar') : t('attachCard.emptyShop')}
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
              <CardGlyph icon={item.icon} />
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
                  {t('attachCard.sent')}
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

async function loadEntities(tab: TabKey, fmt: Formatters): Promise<PickItem[]> {
  if (tab === 'tasks') return loadTasks();
  if (tab === 'calendar') return loadEvents(fmt);
  return loadListings();
}

/** Сколько задач показывать в пикере скрепки: у страницы задач свой список с поиском. */
const TASK_PICK_LIMIT = 100;

async function loadTasks(): Promise<PickItem[]> {
  // Раньше limit не передавался вовсе: приезжала дефолтная первая страница из 20 задач,
  // а `meta` игнорировалась — у человека с 60 задачами скрепка молча показывала треть.
  const page = await apiGet<OffsetPage<Task>>('/tasks', { params: { limit: String(TASK_PICK_LIMIT) } });
  return page.items.map((t) => ({
    key: t.id,
    icon: 'checkCircle',
    title: t.title,
    refType: 'task' as const,
    refId: t.id,
  }));
}

async function loadEvents(fmt: Formatters): Promise<PickItem[]> {
  // GET /calendar/events?from&to&layers=events → { items: CalendarItem[] }.
  // Window: now → +60 days. Keep only events I own/organize (no overlay ownerName),
  // dedupe recurring occurrences by their event id.
  const from = new Date();
  const to = new Date(Date.now() + 60 * 86_400_000);
  const range = await apiGet<CalendarRangeResponse>('/calendar/events', {
    params: { from: from.toISOString(), to: to.toISOString(), layers: 'events' },
  });
  const seen = new Set<string>();
  const out: PickItem[] = [];
  // Сужение по kind — вместо локального типа, который гадал `eventId ?? id` и
  // `start ?? startTime`: поля `id`/`startTime` у события НЕ СУЩЕСТВУЕТ, обе ветки
  // были мёртвыми и держались на совпадении.
  for (const it of range.items) {
    if (it.kind !== 'event') continue;
    if (it.ownerName) continue; // overlay (someone else's calendar) — not mine to share
    if (seen.has(it.eventId)) continue;
    seen.add(it.eventId);
    out.push({
      key: it.eventId,
      icon: 'calendar',
      title: it.title,
      subtitle: fmtWhen(it.start, fmt),
      refType: 'event' as const,
      refId: it.eventId,
    });
  }
  return out;
}

async function loadListings(): Promise<PickItem[]> {
  // У shared `Showcase` поля `listings` нет и не было никогда — прежняя ветка
  // «Prefer inlined listings» не срабатывала ни разу, а тип обещал её как рабочую.
  const shop = await apiGet<ShopOverviewDto>('/shop');
  const out: PickItem[] = [];
  const seen = new Set<string>();
  for (const sc of shop.showcases) {
    let listings: Listing[];
    try {
      listings = await apiGet<Listing[]>(`/shop/showcases/${sc.id}/listings`);
    } catch {
      listings = [];
    }
    for (const l of listings) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      out.push({
        key: l.id,
        icon: l.icon ?? (l.crowdfunding ? 'target' : 'gift'),
        title: l.title,
        refType: l.crowdfunding ? ('crowdfunding' as const) : ('listing' as const),
        refId: l.id,
      });
    }
  }
  return out;
}

function fmtWhen(iso: string, fmt: Formatters): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return fmt.dateTime(d, 'dayMonth');
}
