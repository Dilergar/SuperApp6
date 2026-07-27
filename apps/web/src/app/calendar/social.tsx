'use client';

import { useState, useEffect, useCallback } from 'react';
import { api, apiErrorMessage } from '@/lib/api';
import { EntitySelector } from '@/components/EntitySelector';
import { PersonChip } from '../circles/PersonCard';
import {
  Alert, Button, Chip, EmptyState, Field, IconButton, Input, Modal,
} from '@/components/ui';
import {
  CALENDAR_ACCESS_LEVEL_META,
  SMART_MATCH_DURATIONS,
  type Contact,
  type CalendarShare,
  type SharedCalendarSource,
  type SmartMatchSlot,
} from '@superapp/shared';

// ============================================================
// Доступ к моему календарю (персональный, поверх доступа по Группам)
// ============================================================

export function SharePanel({ contacts, onClose }: { contacts: Contact[]; onClose: (changed: boolean) => void }) {
  const [shares, setShares] = useState<CalendarShare[]>([]);
  const [changed, setChanged] = useState(false);
  const [pickId, setPickId] = useState<string>('');
  const [level, setLevel] = useState<'busy' | 'detailed'>('busy');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setShares((await api.get('/calendar/shares')).data.data); } catch { /* тихо: панель откроется пустой */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!pickId) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/calendar/shares', { sharedWithUserId: pickId, accessLevel: level });
      setChanged(true);
      setPickId('');
      await load();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (uid: string) => {
    setBusy(true);
    try {
      await api.delete(`/calendar/shares/${uid}`);
      setChanged(true);
      await load();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const available = contacts.filter((c) => !shares.some((s) => s.sharedWithUserId === c.them.id));

  return (
    <Modal
      open
      onClose={() => onClose(changed)}
      title="Доступ к моему календарю"
      subtitle="По умолчанию календарь приватный. Здесь — персональный доступ; по Группам — в настройках Группы на «Моё окружение»"
      size="md"
      footer={<Button variant="ghost" onClick={() => onClose(changed)}>Готово</Button>}
    >
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError('')}>{error}</Alert>}

        <Field label="Открыть человеку">
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <EntitySelector
                types={['user']}
                multi={false}
                options={available.map((c) => ({ type: 'user', id: c.them.id, title: `${c.them.firstName} ${c.them.lastName ?? ''}`.trim(), firstName: c.them.firstName, lastName: c.them.lastName, role: c.myRole }))}
                value={pickId ? [{ type: 'user', id: pickId }] : []}
                onChange={(p) => setPickId(p[0]?.id ?? '')}
                placeholder="Выберите человека…"
              />
            </div>
            <div style={{ display: 'flex', gap: '0.25rem' }}>
              {(['busy', 'detailed'] as const).map((l) => (
                <Chip key={l} size="sm" tone="accent" selected={level === l} onClick={() => setLevel(l)}>
                  {CALENDAR_ACCESS_LEVEL_META[l].label}
                </Chip>
              ))}
            </div>
            <Button variant="primary" size="sm" icon="check" disabled={!pickId} loading={busy} onClick={add}>
              Дать доступ
            </Button>
          </div>
        </Field>

        {shares.length === 0 ? (
          <EmptyState icon="lock" title="Пока никому не открыт" description="Выберите человека выше — он увидит занятость или детали." />
        ) : (
          <div style={{ display: 'grid', gap: '0.375rem' }}>
            {shares.map((s) => (
              <div
                key={s.sharedWithUserId}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-3)',
                  border: '1px solid var(--divider)', borderRadius: 'var(--radius-md)', padding: '0.4375rem 0.625rem',
                }}
              >
                <PersonChip size="M" userId={s.sharedWithUserId} firstName={s.firstName} lastName={s.lastName ?? null} />
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Chip size="sm" tone={s.accessLevel === 'detailed' ? 'accent' : 'neutral'}>
                    {CALENDAR_ACCESS_LEVEL_META[s.accessLevel].label}
                  </Chip>
                  <IconButton icon="close" label="Закрыть доступ" size={28} onClick={() => remove(s.sharedWithUserId)} />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ============================================================
// Smart Match — общее свободное время с теми, кто открыл календарь
// ============================================================

export function SmartMatchDialog({
  sources, onClose, onPick,
}: {
  sources: SharedCalendarSource[];
  onClose: () => void;
  onPick: (start: string, userIds: string[]) => void;
}) {
  const [sel, setSel] = useState<string[]>([]);
  const [duration, setDuration] = useState(60);
  const [days, setDays] = useState(7);
  const [fromHour, setFromHour] = useState(9);
  const [toHour, setToHour] = useState(21);
  const [slots, setSlots] = useState<SmartMatchSlot[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const search = async () => {
    if (!sel.length) { setError('Выберите хотя бы одного человека'); return; }
    setBusy(true); setError('');
    const now = new Date();
    const from = new Date(now.getTime() + 5 * 60_000); // a few minutes ahead
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 23, 59);
    // локальные рабочие часы → минуты от полуночи UTC (в КЗ нет перехода на летнее время)
    const ref = new Date(now.getFullYear(), now.getMonth(), now.getDate(), fromHour, 0);
    const ref2 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), toHour, 0);
    const dayStartMin = ref.getUTCHours() * 60 + ref.getUTCMinutes();
    const dayEndMin = ref2.getUTCHours() * 60 + ref2.getUTCMinutes();
    try {
      const { data } = await api.post('/calendar/smart-match', {
        userIds: sel, durationMin: duration, from: from.toISOString(), to: to.toISOString(),
        dayStartMin, dayEndMin: dayEndMin > dayStartMin ? dayEndMin : dayStartMin + 720,
      });
      setSlots(data.data.slots);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally { setBusy(false); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Подобрать общее время"
      subtitle="Среди тех, кто открыл вам календарь. Чужая занятость не раскрывается — только свободные окна"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Закрыть</Button>
          {sources.length > 0 && (
            <Button variant="primary" icon="search" loading={busy} onClick={search}>Найти окна</Button>
          )}
        </>
      }
    >
      {sources.length === 0 ? (
        <EmptyState
          icon="people"
          title="Некого подбирать"
          description="Пока никто не открыл вам свой календарь — попросите доступ или откройте свой первым."
        />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
          {error && <Alert tone="danger" onClose={() => setError('')}>{error}</Alert>}

          <Field label="С кем">
            <EntitySelector
              types={['user']}
              multi
              options={sources.map((s) => ({ type: 'user', id: s.userId, title: `${s.firstName} ${s.lastName ?? ''}`.trim(), firstName: s.firstName, lastName: s.lastName }))}
              value={sel.map((id) => ({ type: 'user', id }))}
              onChange={(p) => setSel(p.map((x) => x.id))}
              placeholder="Выберите людей…"
            />
          </Field>

          <div style={{ display: 'flex', gap: 'var(--spacing-6)', flexWrap: 'wrap' }}>
            <Field label="Длительность">
              <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                {SMART_MATCH_DURATIONS.map((d) => (
                  <Chip key={d.min} size="sm" tone="accent" selected={duration === d.min} onClick={() => setDuration(d.min)}>
                    {d.label}
                  </Chip>
                ))}
              </div>
            </Field>
            <Field label="Период">
              <div style={{ display: 'flex', gap: '0.25rem' }}>
                {[7, 14, 30].map((d) => (
                  <Chip key={d} size="sm" tone="accent" selected={days === d} onClick={() => setDays(d)}>
                    {d} дн.
                  </Chip>
                ))}
              </div>
            </Field>
          </div>

          <Field label="Рабочие часы">
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <div style={{ width: 80 }}>
                <Input
                  type="number"
                  min={0}
                  max={23}
                  value={fromHour}
                  onChange={(e) => setFromHour(Math.min(23, Math.max(0, +e.target.value)))}
                  aria-label="С какого часа"
                />
              </div>
              <span className="label-sm">—</span>
              <div style={{ width: 80 }}>
                <Input
                  type="number"
                  min={1}
                  max={24}
                  value={toHour}
                  onChange={(e) => setToHour(Math.min(24, Math.max(1, +e.target.value)))}
                  aria-label="До какого часа"
                />
              </div>
            </div>
          </Field>

          {slots && (
            slots.length === 0 ? (
              <Alert tone="neutral" icon="info">Свободных окон не нашлось — попробуйте другой период или часы.</Alert>
            ) : (
              <Field label="Свободные окна">
                <div style={{ display: 'grid', gap: '0.25rem' }}>
                  {slots.slice(0, 20).map((s) => (
                    <button
                      key={s.start}
                      type="button"
                      onClick={() => onPick(s.start, sel)}
                      style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        border: '1px solid var(--divider)', background: 'transparent',
                        borderRadius: 'var(--radius-md)', padding: '0.5rem 0.625rem',
                        cursor: 'pointer', textAlign: 'left', color: 'var(--on-surface)',
                      }}
                    >
                      <span className="title-sm">{slotLabel(s.start)}</span>
                      <span className="label-sm" style={{ color: 'var(--primary-dim)' }}>выбрать</span>
                    </button>
                  ))}
                </div>
              </Field>
            )
          )}
        </div>
      )}
    </Modal>
  );
}

function slotLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
