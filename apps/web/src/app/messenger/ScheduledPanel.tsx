'use client';

import { useState } from 'react';
import type { ScheduledMessageItem } from '@superapp/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listScheduled, updateScheduled, cancelScheduled } from '@/lib/messenger-api';
import { errMsg } from './ShareCardModal';
import { toLocalInput, localToIso } from './QuickActionModals';

// ============================================================
// Phase 7 — "Запланировано" panel. Lists the viewer's pending scheduled
// messages in a chat with per-row «Изменить время» (inline datetime editor)
// and «Отменить». Shares the react-query key ['scheduled', chatId] with the
// header clock button so both stay in sync after any change.
// ============================================================

export const scheduledKey = (chatId: string) => ['scheduled', chatId] as const;

/** Pending count for the header clock badge (0 when none / loading). */
export function usePendingScheduledCount(chatId: string | null, enabled: boolean): number {
  const q = useQuery({
    queryKey: chatId ? scheduledKey(chatId) : ['scheduled', 'none'],
    queryFn: () => listScheduled(chatId as string),
    enabled: enabled && !!chatId,
  });
  return (q.data ?? []).filter((s) => s.status === 'pending').length;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ScheduledPanel({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: scheduledKey(chatId),
    queryFn: () => listScheduled(chatId),
  });
  const pending = (data ?? []).filter((s) => s.status === 'pending');

  const refresh = () => queryClient.invalidateQueries({ queryKey: scheduledKey(chatId) });

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
        zIndex: 110,
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
          <h3 className="title-md">Запланировано</h3>
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
          Ваши сообщения, ожидающие автоматической отправки.
        </p>

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {isLoading && <p className="label-sm" style={{ opacity: 0.7 }}>Загрузка…</p>}
          {!isLoading && pending.length === 0 && (
            <p className="label-sm" style={{ opacity: 0.7, padding: 'var(--spacing-3)', textAlign: 'center' }}>
              Запланированных сообщений нет.
            </p>
          )}
          {pending.map((item) => (
            <ScheduledRow key={item.id} item={item} onChanged={refresh} />
          ))}
        </div>

        <div style={{ marginTop: 'var(--spacing-4)', textAlign: 'right' }}>
          <button onClick={onClose} className="btn-secondary" style={{ fontSize: '0.85rem' }}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}

function ScheduledRow({ item, onChanged }: { item: ScheduledMessageItem; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [when, setWhen] = useState(toLocalInput(new Date(item.sendAt)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const minWhen = toLocalInput(new Date(Date.now() + 60_000));

  const saveTime = async () => {
    const sendAt = localToIso(when);
    if (!sendAt) {
      setErr('Выберите время.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await updateScheduled(item.id, { sendAt });
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(errMsg(e, 'Не удалось изменить время'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!confirm('Отменить это сообщение?')) return;
    setBusy(true);
    setErr(null);
    try {
      await cancelScheduled(item.id);
      onChanged();
    } catch (e) {
      setErr(errMsg(e, 'Не удалось отменить'));
      setBusy(false);
    }
  };

  return (
    <div
      className="card"
      style={{
        padding: 'var(--spacing-3)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--spacing-2)',
      }}
    >
      <div style={{ fontSize: '0.88rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {item.content}
      </div>

      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
          <input
            type="datetime-local"
            value={when}
            min={minWhen}
            onChange={(e) => setWhen(e.target.value)}
            className="input-sketch"
            style={{ fontSize: '0.85rem', fontFamily: 'var(--font-body)' }}
          />
          {err && <p style={{ color: 'var(--danger)', fontSize: '0.78rem' }}>{err}</p>}
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', justifyContent: 'flex-end' }}>
            <button
              onClick={() => {
                setEditing(false);
                setErr(null);
                setWhen(toLocalInput(new Date(item.sendAt)));
              }}
              className="btn-secondary"
              style={{ fontSize: '0.78rem', padding: '0.35rem 0.8rem' }}
            >
              Отмена
            </button>
            <button
              onClick={saveTime}
              disabled={busy}
              className="btn-primary"
              style={{ fontSize: '0.78rem', padding: '0.35rem 0.8rem', opacity: busy ? 0.5 : 1 }}
            >
              {busy ? '…' : 'Сохранить'}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-2)' }}>
          <span
            className="label-sm"
            style={{ fontSize: '0.74rem', color: 'var(--secondary)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
          >
            ⏰ {fmtWhen(item.sendAt)}
          </span>
          <div style={{ display: 'flex', gap: 'var(--spacing-2)' }}>
            <button
              onClick={() => setEditing(true)}
              disabled={busy}
              className="btn-secondary"
              style={{ fontSize: '0.74rem', padding: '0.3rem 0.7rem' }}
            >
              Изменить время
            </button>
            <button
              onClick={cancel}
              disabled={busy}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: '0.74rem',
                fontWeight: 600,
                color: 'var(--danger)',
                padding: '0.3rem 0.5rem',
                opacity: busy ? 0.5 : 1,
              }}
            >
              Отменить
            </button>
          </div>
        </div>
      )}
      {!editing && err && <p style={{ color: 'var(--danger)', fontSize: '0.78rem' }}>{err}</p>}
    </div>
  );
}
