'use client';

// Шаблоны смен: «Утро 09–17». Цвет — ДАННЫЕ шаблона (сетка красит чип по нему),
// поэтому здесь честный выбор цвета, а не выдумка палитры в коде.
//
// Шаблон можно ПРАВИТЬ: уже поставленные смены при этом не меняются — экземпляр
// замораживает своё время (objects_shifts.md), правка влияет только на будущие.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ShiftTemplateDto } from '@superapp/shared';
import { Button, Card, Chip, Divider, EmptyState, Input, Modal, useConfirm } from '@/components/ui';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { hoursLabel } from '@/lib/objects-time';
import { shiftTemplatesKey } from '@/lib/queries';
import { fetchShiftTemplates, shiftsApi } from '../objects-api';

const DEFAULT_COLOR = '#588cd3';

function minutesOf(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function ShiftTemplatesPanel({
  workspaceId,
  objectId,
  open,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  objectId: string;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [start, setStart] = useState('09:00');
  const [duration, setDuration] = useState('480');
  const [breakMin, setBreakMin] = useState('60');
  const [color, setColor] = useState(DEFAULT_COLOR);

  const { data: templates } = useQuery({
    queryKey: shiftTemplatesKey(workspaceId, objectId),
    queryFn: () => fetchShiftTemplates(workspaceId, objectId),
    enabled: open,
  });

  const list = (templates as ShiftTemplateDto[] | undefined) ?? [];

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: shiftTemplatesKey(workspaceId, objectId) });
    onSaved?.();
  };

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setStart('09:00');
    setDuration('480');
    setBreakMin('60');
    setColor(DEFAULT_COLOR);
  };

  const startEdit = (t: ShiftTemplateDto) => {
    setEditingId(t.id);
    setName(t.name);
    setStart(hhmm(t.startMin));
    setDuration(String(t.durationMin));
    setBreakMin(String(t.breakMin));
    setColor(t.color ?? DEFAULT_COLOR);
  };

  /** Общая проверка полей формы (создание и правка спорят об одном и том же) */
  const readForm = () => {
    const startMin = minutesOf(start);
    if (startMin === null) throw new Error('Начало — в формате 09:00');
    const durationMin = Number(duration);
    if (!Number.isFinite(durationMin) || durationMin < 15) throw new Error('Длительность — минуты, минимум 15');
    return { name: name.trim(), startMin, durationMin, breakMin: Number(breakMin) || 0, color };
  };

  const create = useMutation({
    mutationFn: async () => shiftsApi.createTemplate(workspaceId, { ...readForm(), branchId: objectId }),
    onSuccess: () => {
      resetForm();
      invalidate();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  // Правка НЕ трогает branchId: общий шаблон организации не должен «приватизироваться»
  // объектом при обычном сохранении формы.
  const update = useMutation({
    mutationFn: async () => shiftsApi.updateTemplate(workspaceId, editingId!, readForm()),
    onSuccess: () => {
      resetForm();
      invalidate();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (tplId: string) => shiftsApi.removeTemplate(workspaceId, tplId),
    onSuccess: () => {
      resetForm();
      invalidate();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const busy = create.isPending || update.isPending;

  return (
    <Modal open={open} onClose={onClose} title="Шаблоны смен">
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
          {list.length === 0 ? (
            <EmptyState
              icon="clock"
              title="Шаблонов пока нет"
              description="Шаблон — это «Утро 09–17»: время и цвет, из которых собираются смены и ротации. Заведите первый в форме ниже."
            />
          ) : (
            list.map((t) => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
                <span
                  aria-hidden
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 3,
                    background: t.color ?? 'var(--outline-variant)',
                    flex: 'none',
                  }}
                />
                <span style={{ fontWeight: 600 }}>{t.name}</span>
                {/* Длительность — точная: 450 минут это «7,5 ч», а не «8 ч» */}
                <span className="label-sm">{`${hhmm(t.startMin)} · ${hoursLabel(t.durationMin)}`}</span>
                {t.branchId === null && (
                  <Chip tone="neutral" title="Общий шаблон организации — правит владелец или админ">
                    общий
                  </Chip>
                )}
                {editingId === t.id && <Chip tone="accent">правим</Chip>}
                {/* Право приходит с сервера полем `canManage`: общий шаблон организации
                    правят только владелец и админ — интерфейс больше не предлагает
                    действие, которое сервер отвергнет. */}
                {t.canManage && (
                  <>
                    <Button size="sm" variant="ghost" icon="edit" onClick={() => startEdit(t)}>
                      Править
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      tone="danger"
                      onClick={() =>
                        confirm(
                          {
                            title: 'Убрать шаблон?',
                            message: `«${t.name}» перестанет предлагаться. Уже поставленные смены не изменятся.`,
                            confirmLabel: 'Убрать',
                          },
                          () => remove.mutateAsync(t.id).then(() => undefined),
                        )
                      }
                    >
                      Убрать
                    </Button>
                  </>
                )}
              </div>
            ))
          )}
        </div>

        <Divider />

        <Card>
          <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-3)' }}>
            <Input label="Название" placeholder="Утро" value={name} onChange={(e) => setName(e.target.value)} />
            <Input label="Начало" placeholder="09:00" value={start} onChange={(e) => setStart(e.target.value)} />
            <Input
              label="Длительность, мин"
              inputMode="numeric"
              value={duration}
              hint={Number(duration) > 0 ? hoursLabel(Number(duration)) : undefined}
              onChange={(e) => setDuration(e.target.value)}
            />
            <Input label="Перерыв, мин" inputMode="numeric" value={breakMin} onChange={(e) => setBreakMin(e.target.value)} />
            <Input label="Цвет" type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </div>
          <div style={{ marginTop: 'var(--spacing-3)', display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
            {editingId && (
              <Button variant="ghost" onClick={resetForm}>
                Отмена правки
              </Button>
            )}
            <Button
              variant="primary"
              loading={busy}
              disabled={!name.trim()}
              onClick={() => (editingId ? update.mutate() : create.mutate())}
            >
              {editingId ? 'Сохранить шаблон' : 'Добавить шаблон'}
            </Button>
          </div>
        </Card>
      </div>
      {confirmUI}
    </Modal>
  );
}
