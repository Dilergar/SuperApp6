'use client';

import { CloseChip, Input, ModalShell, useConfirm } from '@/components/ui';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useFormatters } from '@/lib/format';
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

/** Момент отправки в правилах региона и словах языка зрителя. */
function useWhen(): (iso: string) => string {
  const f = useFormatters();
  return (iso: string) => (Number.isNaN(new Date(iso).getTime()) ? '' : f.dateTime(iso, 'dayMonthLong'));
}

export function ScheduledPanel({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const t = useTranslations('messenger');
  const tc = useTranslations('common');
  const fmtWhen = useWhen();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: scheduledKey(chatId),
    queryFn: () => listScheduled(chatId),
  });
  const pending = (data ?? []).filter((s) => s.status === 'pending');

  const refresh = () => queryClient.invalidateQueries({ queryKey: scheduledKey(chatId) });

  return (
    <ModalShell onClose={onClose} zIndex={110}>
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
          <h3 className="title-md">{t('scheduled.title')}</h3>
          <CloseChip onClick={onClose} />
        </div>
        <p className="label-sm" style={{ opacity: 0.7, marginBottom: 'var(--spacing-4)' }}>
          {t('scheduled.subtitle')}
        </p>

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {isLoading && <p className="label-sm" style={{ opacity: 0.7 }}>{tc('state.loading')}</p>}
          {!isLoading && pending.length === 0 && (
            <p className="label-sm" style={{ opacity: 0.7, padding: 'var(--spacing-3)', textAlign: 'center' }}>
              {t('scheduled.empty')}
            </p>
          )}
          {pending.map((item) => (
            <ScheduledRow key={item.id} item={item} onChanged={refresh} />
          ))}
        </div>

        <div style={{ marginTop: 'var(--spacing-4)', textAlign: 'right' }}>
          <button onClick={onClose} className="btn-ghost-inline">
            {tc('actions.close')}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ScheduledRow({ item, onChanged }: { item: ScheduledMessageItem; onChanged: () => void }) {
  const t = useTranslations('messenger');
  const tc = useTranslations('common');
  const fmtWhen = useWhen();
  const [editing, setEditing] = useState(false);
  const [when, setWhen] = useState(toLocalInput(new Date(item.sendAt)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, confirmUI] = useConfirm();

  const minWhen = toLocalInput(new Date(Date.now() + 60_000));

  const saveTime = async () => {
    const sendAt = localToIso(when);
    if (!sendAt) {
      setErr(t('scheduled.pickTime'));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await updateScheduled(item.id, { sendAt });
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(errMsg(e, t('scheduled.timeFailed')));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    confirm(
      { title: t('scheduled.cancelConfirm.title'), message: t('scheduled.cancelConfirm.message'), confirmLabel: t('scheduled.cancelConfirm.label'), danger: true },
      cancelNow,
    );
  };

  const cancelNow = async () => {
    setBusy(true);
    setErr(null);
    try {
      await cancelScheduled(item.id);
      onChanged();
    } catch (e) {
      setErr(errMsg(e, t('scheduled.cancelFailed')));
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
          <Input
            aria-label={t('scheduled.whenAria')}
            type="datetime-local"
            value={when}
            min={minWhen}
            onChange={(e) => setWhen(e.target.value)}
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
              className="btn-ghost-inline"
              style={{ fontSize: '0.78rem', padding: '0.35rem 0.8rem' }}
            >
              {tc('actions.cancel')}
            </button>
            <button
              onClick={saveTime}
              disabled={busy}
              className="btn-success"
              style={{ fontSize: '0.78rem', padding: '0.35rem 0.8rem', opacity: busy ? 0.5 : 1 }}
            >
              {busy ? '…' : tc('actions.save')}
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
              className="btn-ghost-inline"
              style={{ fontSize: '0.74rem', padding: '0.3rem 0.7rem' }}
            >
              {t('scheduled.changeTime')}
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
              {t('scheduled.cancel')}
            </button>
          </div>
        </div>
      )}
      {!editing && err && <p style={{ color: 'var(--danger)', fontSize: '0.78rem' }}>{err}</p>}
      {confirmUI}
    </div>
  );
}
