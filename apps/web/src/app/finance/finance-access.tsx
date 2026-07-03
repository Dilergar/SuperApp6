'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FinShareRole, FinSharedBookDto } from '@superapp/shared';
import { api } from '@/lib/api';
import { financeSharesKey, fetchFinanceShares } from '@/lib/queries';
import { EntitySelector } from '@/components/EntitySelector';
import { PersonChip } from '../circles/PersonCard';
import { GroupChip } from '../circles/EntityChip';

const errText = (e: unknown): string =>
  (e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Что-то пошло не так';

/** Переключатель «чью книгу смотрю»: моя + те, которыми со мной поделились. */
export function BookSwitcher({
  activeBookId,
  sharedBooks,
  onSwitch,
}: {
  activeBookId: string | null;
  sharedBooks: FinSharedBookDto[];
  onSwitch: (bookId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  if (sharedBooks.length === 0) return null;
  const active = sharedBooks.find((b) => b.bookId === activeBookId);

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="ghost-border"
        style={{ background: 'var(--surface-container-lowest)', cursor: 'pointer', padding: '0.35rem 0.9rem', fontSize: '0.85rem', fontFamily: 'var(--font-display)', fontWeight: 600 }}
      >
        📒 {active ? `Книга: ${active.ownerName}` : 'Моя книга'} ▾
      </button>
      {open && (
        <div
          className="card-elevated"
          style={{ position: 'absolute', top: 'calc(100% + 0.4rem)', left: 0, minWidth: '16rem', zIndex: 60, background: 'var(--surface-container-low)', padding: '0.4rem', borderRadius: 'var(--radius-md)' }}
        >
          <button
            onClick={() => { onSwitch(null); setOpen(false); }}
            style={{ display: 'block', width: '100%', textAlign: 'left', background: !activeBookId ? 'var(--secondary-container)' : 'none', border: 'none', cursor: 'pointer', padding: '0.5rem 0.6rem', borderRadius: 'var(--radius-sm)', fontWeight: 600 }}
          >
            📒 Моя книга
          </button>
          {sharedBooks.map((b) => (
            <button
              key={b.bookId}
              onClick={() => { onSwitch(b.bookId); setOpen(false); }}
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', textAlign: 'left', background: activeBookId === b.bookId ? 'var(--secondary-container)' : 'none', border: 'none', cursor: 'pointer', padding: '0.4rem 0.6rem', borderRadius: 'var(--radius-sm)' }}
            >
              <PersonChip size="S" userId={b.ownerUserId} firstName={b.ownerName} avatar={b.ownerAvatar} />
              <span className="label-sm">{b.myRole === 'editor' ? 'ведёте вместе' : 'смотрите'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Модалка «Доступ к книге» — только для владельца. */
export function AccessModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: shares = [] } = useQuery({ queryKey: financeSharesKey(), queryFn: () => fetchFinanceShares() });
  const [role, setRole] = useState<FinShareRole>('editor');
  const [busy, setBusy] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: financeSharesKey() });

  const add = async (principal: { type: string; id: string }) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.post('/finance/shares', { principalType: principal.type, principalId: principal.id, role });
      refresh();
    } catch (e) {
      alert(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (principalType: string, principalId: string) => {
    try {
      await api.delete(`/finance/shares/${principalType}/${principalId}`);
      refresh();
    } catch (e) {
      alert(errText(e));
    }
  };
  const changeRole = async (principalType: string, principalId: string, newRole: FinShareRole) => {
    try {
      await api.post('/finance/shares', { principalType, principalId, role: newRole });
      refresh();
    } catch (e) {
      alert(errText(e));
    }
  };

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(56,57,45,0.35)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 110, padding: '1rem' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card-elevated"
        style={{ background: 'var(--surface-container-low)', padding: 'var(--spacing-6)', maxWidth: 480, width: '100%', maxHeight: '86vh', overflowY: 'auto', borderRadius: 'var(--radius-md)', transform: 'rotate(-0.3deg)' }}
      >
        <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-1)' }}>
          <h3 className="title-md">Доступ к моим финансам</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', opacity: 0.5 }}>×</button>
        </div>
        <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)' }}>
          «Смотрит» — видит всё; «ведёт вместе» — записывает и правит. Разрыв связи в Окружении отзывает доступ сам.
        </p>

        <div className="flex items-center" style={{ gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-3)' }}>
          <span className="label-sm">Роль для новых:</span>
          {([['editor', 'ведёт вместе'], ['viewer', 'смотрит']] as Array<[FinShareRole, string]>).map(([r, label]) => (
            <button
              key={r}
              onClick={() => setRole(r)}
              style={{ border: 'none', cursor: 'pointer', padding: '0.2rem 0.8rem', borderRadius: 'var(--radius-sketch)', fontSize: '0.78rem', fontWeight: 600, background: role === r ? 'var(--primary-container)' : 'var(--surface-container)' }}
            >
              {label}
            </button>
          ))}
        </div>

        <EntitySelector value={[]} onChange={(next) => next[0] && add(next[0])} types={['user', 'circle']} multi={false} placeholder="Человек или Группа…" />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)', marginTop: 'var(--spacing-4)' }}>
          {shares.map((s) => (
            <div key={`${s.principalType}:${s.principalId}`} className="flex items-center justify-between" style={{ gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
              {s.principalType === 'user' ? (
                <PersonChip size="S" userId={s.principalId} firstName={s.name ?? 'Пользователь'} avatar={s.avatar} />
              ) : (
                <GroupChip size="S" name={s.name ?? 'Группа'} />
              )}
              <span className="flex items-center" style={{ gap: 'var(--spacing-2)' }}>
                <select
                  className="input-sketch"
                  value={s.role}
                  onChange={(e) => changeRole(s.principalType, s.principalId, e.target.value as FinShareRole)}
                  style={{ fontSize: '0.8rem', width: 'auto' }}
                >
                  <option value="editor">ведёт вместе</option>
                  <option value="viewer">смотрит</option>
                </select>
                <button onClick={() => remove(s.principalType, s.principalId)} title="Отозвать" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontWeight: 700 }}>×</button>
              </span>
            </div>
          ))}
          {shares.length === 0 && <p className="label-md">Пока никому не открыто.</p>}
        </div>
      </div>
    </div>
  );
}
