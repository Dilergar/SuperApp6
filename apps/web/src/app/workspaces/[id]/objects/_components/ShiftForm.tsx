'use client';

// Постановка смены: штатная единица, шаблон (или своё время), человек.
// Пикер человека предлагает ТОЛЬКО назначенных на выбранную единицу — сервер
// чужого всё равно отвергнет, а пикер не должен предлагать то, что не пройдёт.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ShiftTemplateDto, StaffingTableDto } from '@superapp/shared';
import { Alert, Button, Checkbox, Input, Modal, Select } from '@/components/ui';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { hoursLabel } from '@/lib/objects-time';
import { objectStaffingKey, shiftTemplatesKey } from '@/lib/queries';
import { fetchShiftTemplates, fetchStaffing, shiftsApi } from '../objects-api';

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

export function ShiftForm({
  workspaceId,
  objectId,
  open,
  localDate,
  userId,
  canManage,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  objectId: string;
  open: boolean;
  localDate: string;
  /** Строка сетки: конкретный человек или «Открытые» (null) */
  userId: string | null;
  /** `branch.manage` зрителя: без него обход правил объекта сервер отвергнет */
  canManage: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const period = localDate.slice(0, 7);
  const { data: staffing } = useQuery({
    queryKey: objectStaffingKey(workspaceId, objectId, period),
    queryFn: () => fetchStaffing(workspaceId, objectId, period),
    enabled: open,
  });
  const { data: templates } = useQuery({
    queryKey: shiftTemplatesKey(workspaceId, objectId),
    queryFn: () => fetchShiftTemplates(workspaceId, objectId),
    enabled: open,
  });

  const [unitId, setUnitId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [start, setStart] = useState('09:00');
  const [duration, setDuration] = useState('480');
  const [breakMin, setBreakMin] = useState('0');
  const [force, setForce] = useState(false);

  const units = useMemo(() => {
    const rows = (staffing as StaffingTableDto | undefined)?.rows ?? [];
    const byUnit = new Map<string, { id: string; label: string; assignmentId: string | null }>();
    for (const r of rows) {
      const mine = userId ? r.assignment?.userId === userId : true;
      if (!mine) continue;
      if (!byUnit.has(r.staffingPositionId)) {
        byUnit.set(r.staffingPositionId, {
          id: r.staffingPositionId,
          label: r.positionName,
          assignmentId: userId ? (r.assignment?.id ?? null) : null,
        });
      }
    }
    return [...byUnit.values()];
  }, [staffing, userId]);

  // Позиций нет — форма нерабочая ПО СУЩЕСТВУ: ставить смену не на что. Показываем
  // причину и дорогу к ней, а не вечно выключенную кнопку «Поставить».
  const noUnits = !!staffing && units.length === 0;

  useEffect(() => {
    if (!unitId && units.length) setUnitId(units[0].id);
  }, [units, unitId]);

  // Выбор шаблона подставляет его время — но экземпляр смены хранит своё,
  // и последующая правка шаблона на уже поставленную смену не влияет.
  useEffect(() => {
    const tpl = (templates as ShiftTemplateDto[] | undefined)?.find((t) => t.id === templateId);
    if (!tpl) return;
    setStart(hhmm(tpl.startMin));
    setDuration(String(tpl.durationMin));
    setBreakMin(String(tpl.breakMin));
  }, [templateId, templates]);

  const save = useMutation({
    mutationFn: async () => {
      const startMin = minutesOf(start);
      if (startMin === null) throw new Error('Время начала — в формате 09:00');
      const durationMin = Number(duration);
      if (!Number.isFinite(durationMin) || durationMin < 15) throw new Error('Длительность — минуты, минимум 15');
      const unit = units.find((u) => u.id === unitId);
      return shiftsApi.create(workspaceId, objectId, {
        localDate,
        startMin,
        durationMin,
        breakMin: Number(breakMin) || 0,
        staffingPositionId: unitId,
        assignmentId: unit?.assignmentId ?? null,
        templateId: templateId || null,
        ...(force ? { force: true } : {}),
      });
    },
    onSuccess: () => {
      onSaved?.();
      onClose();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const durationMin = Number(duration);
  const durationHint = Number.isFinite(durationMin) && durationMin > 0 ? hoursLabel(durationMin) : undefined;

  return (
    <Modal open={open} onClose={onClose} title={`Смена ${localDate}`}>
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {noUnits ? (
          <>
            <Alert
              tone="warning"
              title="Ставить смену не на что"
              action={
                <Button size="sm" variant="outline" href={`/workspaces/${workspaceId}/objects/${objectId}/staffing`}>
                  Штатное расписание
                </Button>
              }
            >
              {userId
                ? 'У этого человека нет действующей штатной единицы в объекте. Сначала назначьте его на позицию в штатном расписании.'
                : 'Сначала добавьте позицию в штатное расписание объекта.'}
            </Alert>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={onClose}>
                Закрыть
              </Button>
            </div>
          </>
        ) : (
          <>
            <Select
              label="Позиция"
              value={unitId}
              onChange={setUnitId}
              options={units.map((u) => ({ value: u.id, label: u.label }))}
            />
            <Select
              label="Шаблон смены"
              value={templateId}
              onChange={setTemplateId}
              options={[
                { value: '', label: 'Своё время' },
                ...((templates as ShiftTemplateDto[] | undefined) ?? []).map((t) => ({
                  value: t.id,
                  label: `${t.name} · ${hhmm(t.startMin)}`,
                })),
              ]}
            />
            <div className="grid md:grid-cols-3" style={{ gap: 'var(--spacing-3)' }}>
              <Input label="Начало" placeholder="09:00" value={start} onChange={(e) => setStart(e.target.value)} />
              <Input
                label="Длительность, мин"
                inputMode="numeric"
                value={duration}
                hint={durationHint}
                onChange={(e) => setDuration(e.target.value)}
              />
              <Input label="Перерыв, мин" inputMode="numeric" value={breakMin} onChange={(e) => setBreakMin(e.target.value)} />
            </div>
            {/* Обход правил объекта разрешён ТОЛЬКО с branch.manage (сервер иначе
                отвергает) — интерфейс не показывает того, что не пройдёт. */}
            {canManage && (
              <Checkbox
                checked={force}
                onChange={setForce}
                label="Поставить в обход правил объекта (отдых, длина смены)"
              />
            )}
            <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={onClose}>
                Отмена
              </Button>
              <Button variant="primary" loading={save.isPending} disabled={!unitId} onClick={() => save.mutate()}>
                Поставить
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
