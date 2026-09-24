'use client';

// ============================================================
// Исключения по людям для ОДНОГО личного поля: «Всегда показывать» / «Никогда не
// показывать». Конфликт «и там, и там» запрещён на вводе: человек из одного списка не
// предлагается в другом (пикер не предлагает того, что сервер отвергнет — сервер всё равно
// проверяет). «Никогда» сильнее «Всегда» и Групп.
// ============================================================

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Modal } from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import { loadEntities, type EntityOption } from '@/lib/entities';

export function ExceptionsModal({
  open,
  onClose,
  fieldLabel,
  always,
  never,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  fieldLabel: string;
  always: string[];
  never: string[];
  onSave: (always: string[], never: string[]) => void;
}) {
  const t = useTranslations('visibility');
  const tc = useTranslations('common');
  const [a, setA] = useState<string[]>(always);
  const [n, setN] = useState<string[]>(never);
  const [people, setPeople] = useState<EntityOption[]>([]);

  // Открытие окна — снова от подтверждённого состояния (отмена не оставляет следов)
  useEffect(() => {
    if (!open) return;
    setA(always);
    setN(never);
    let alive = true;
    loadEntities('user')
      .then((rows) => { if (alive) setPeople(rows); })
      .catch(() => {});
    return () => { alive = false; };
  }, [open, always, never]);

  const without = (ids: string[]) => people.filter((p) => !ids.includes(p.id));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('personal.exceptionsTitle', { field: fieldLabel })}
      subtitle={t('personal.neverWins')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{tc('actions.cancel')}</Button>
          <Button variant="primary" tone="success" onClick={() => onSave(a, n)}>{tc('actions.save')}</Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
        <div>
          <div className="label-sm" style={{ fontWeight: 600, marginBottom: 'var(--spacing-2)' }}>{t('personal.always')}</div>
          <EntitySelector
            types={['user']}
            options={without(n)}
            value={a.map((id) => ({ type: 'user', id }))}
            onChange={(next) => setA(next.map((p) => p.id))}
          />
        </div>
        <div>
          <div className="label-sm" style={{ fontWeight: 600, marginBottom: 'var(--spacing-2)' }}>{t('personal.never')}</div>
          <EntitySelector
            types={['user']}
            options={without(a)}
            value={n.map((id) => ({ type: 'user', id }))}
            onChange={(next) => setN(next.map((p) => p.id))}
          />
        </div>
      </div>
    </Modal>
  );
}
