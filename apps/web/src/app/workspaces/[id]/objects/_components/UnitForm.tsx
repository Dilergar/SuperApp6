'use client';

// Штатная единица: должность × объект + «по штату N» + плановая ставка.
// Должности можно завести на лету — существующей ручкой справочника «Сотрудники».

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { OBJECT_LIMITS, RATE_TYPES, type StaffRateDto } from '@superapp/shared';
import { Button, Input, Modal, Select } from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { objectStaffingKey } from '@/lib/queries';
import { staffingApi } from '../objects-api';

const RATE_OPTIONS = RATE_TYPES.filter((r) => !('reserved' in r && r.reserved)).map((r) => ({
  value: r.value,
  label: r.label,
}));

/** «250 000» → тиыны строкой; пусто → null */
function tengeToTiyn(v: string): string | null {
  const clean = v.replace(/\s/g, '').replace(',', '.');
  if (!clean) return null;
  const n = Number(clean);
  if (!Number.isFinite(n) || n < 0) return null;
  return String(Math.round(n * 100));
}

export function UnitForm({
  workspaceId,
  objectId,
  open,
  onClose,
  onSaved,
  /** Правка существующей единицы: должность уже выбрана и не меняется */
  unit,
}: {
  workspaceId: string;
  objectId: string;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  unit?: { staffingPositionId: string; positionName: string; headcount: number; plannedRate?: StaffRateDto | null } | null;
}) {
  const qc = useQueryClient();
  const editing = !!unit;
  const [position, setPosition] = useState<{ type: 'position'; id: string }[]>([]);
  const [headcount, setHeadcount] = useState(String(unit?.headcount ?? 1));
  const [rateType, setRateType] = useState(unit?.plannedRate?.rateType ?? 'monthly');
  const [amount, setAmount] = useState(
    unit?.plannedRate ? String(Number(unit.plannedRate.amount) / 100) : '',
  );

  const save = useMutation({
    mutationFn: async () => {
      const tiyn = tengeToTiyn(amount);
      if (amount.trim() && tiyn === null) throw new Error('Ставка — это число, например 250 000');
      if (editing) {
        // Правка единицы и НОВАЯ ВЕРСИЯ плановой ставки — разные операции:
        // ставка версионируется по датам, а не перезаписывается.
        await staffingApi.updateUnit(workspaceId, unit!.staffingPositionId, {
          headcount: Math.max(0, Number(headcount) || 0),
        });
        const changed = tiyn && tiyn !== (unit!.plannedRate?.amount ?? null);
        if (changed) {
          await staffingApi.setPlannedRate(workspaceId, unit!.staffingPositionId, { rateType, amount: tiyn! });
        }
        return;
      }
      await staffingApi.createUnit(workspaceId, objectId, {
        positionId: position[0]?.id,
        headcount: Math.max(0, Number(headcount) || 1),
        ...(tiyn ? { plannedRate: { rateType, amount: tiyn } } : {}),
      });
    },
    onSuccess: () => {
      // Префикс ключа штатки (ключ — из lib/queries.ts): плановая ставка
      // версионируется по датам и видна не только в открытом периоде.
      void qc.invalidateQueries({ queryKey: objectStaffingKey(workspaceId, objectId, '').slice(0, -1) });
      onSaved?.();
      onClose();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <Modal open={open} onClose={onClose} title={editing ? `Позиция «${unit!.positionName}»` : 'Позиция в штате'}>
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {!editing && (
          <div>
            <span className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-2)', fontWeight: 600 }}>
              Должность
            </span>
            <EntitySelector
              types={['position']}
              context={{ workspaceId }}
              value={position}
              onChange={(next) => setPosition(next.slice(-1) as { type: 'position'; id: string }[])}
              placeholder="Выберите должность…"
            />
          </div>
        )}
        <Input
          label="По штату"
          type="number"
          min={0}
          max={OBJECT_LIMITS.maxHeadcount}
          value={headcount}
          onChange={(e) => setHeadcount(e.target.value)}
          hint="Сколько ставок предусмотрено — вакансии считаются в план затрат"
        />
        <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
          <Select label="Тип ставки" value={rateType} onChange={setRateType} options={RATE_OPTIONS} />
          <Input
            label="Плановая ставка"
            placeholder="250 000"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            hint="Необязательно; подставится новому человеку"
          />
        </div>
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!editing && !position[0]?.id}
            onClick={() => save.mutate()}
          >
            {editing ? 'Сохранить' : 'Добавить'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
