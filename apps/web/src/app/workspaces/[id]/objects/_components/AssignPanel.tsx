'use client';

// Назначение человека на штатную единицу: кто, с какой даты, доля ставки и
// фактическая ставка (предзаполнена плановой). Ставка пишется той же транзакцией,
// что и назначение — «назначили, а платить забыли» быть не должно.

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RATE_TYPES, type StaffingRowDto } from '@superapp/shared';
import { Button, DatePicker, Input, Modal, Select } from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { dateToIso, isoToDate, todayIn } from '@/lib/objects-time';
import { objectStaffingKey } from '@/lib/queries';
import { staffingApi } from '../objects-api';

const RATE_OPTIONS = RATE_TYPES.filter((r) => !('reserved' in r && r.reserved)).map((r) => ({
  value: r.value,
  label: r.label,
}));

function tengeToTiyn(v: string): string | null {
  const clean = v.replace(/\s/g, '').replace(',', '.');
  if (!clean) return null;
  const n = Number(clean);
  if (!Number.isFinite(n) || n < 0) return null;
  return String(Math.round(n * 100));
}

function tiynToTenge(v: string | null | undefined): string {
  if (!v) return '';
  return String(Number(v) / 100);
}

export function AssignPanel({
  workspaceId,
  objectId,
  row,
  timeZone,
  open,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  objectId: string;
  row: StaffingRowDto;
  /** Пояс ОБЪЕКТА: «сегодня» до 05:00 по Алматы в UTC — это ещё вчера */
  timeZone: string;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const [user, setUser] = useState<{ type: 'user'; id: string }[]>([]);
  const [startsOn, setStartsOn] = useState<string | undefined>(todayIn(timeZone));
  const [rateShare, setRateShare] = useState('1');
  const [rateType, setRateType] = useState(row.plannedRate?.rateType ?? 'monthly');
  const [amount, setAmount] = useState(tiynToTenge(row.plannedRate?.amount));

  const save = useMutation({
    mutationFn: async () => {
      const tiyn = tengeToTiyn(amount);
      if (amount.trim() && tiyn === null) throw new Error('Ставка — это число, например 250 000');
      const share = Number(rateShare.replace(',', '.'));
      if (!Number.isFinite(share) || share <= 0) throw new Error('Доля ставки — число, например 1 или 0,5');
      return staffingApi.assign(workspaceId, objectId, {
        userId: user[0]?.id,
        staffingPositionId: row.staffingPositionId,
        startsOn,
        rateShare: share,
        ...(tiyn ? { rate: { rateType, amount: tiyn } } : {}),
      });
    },
    onSuccess: () => {
      // Префикс ключа штатки (ключ — из lib/queries.ts): назначение датировано и
      // задевает не только открытый период.
      void qc.invalidateQueries({ queryKey: objectStaffingKey(workspaceId, objectId, '').slice(0, -1) });
      onSaved?.();
      onClose();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <Modal open={open} onClose={onClose} title={`Назначить на «${row.positionName}»`}>
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        <div>
          <span className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-2)', fontWeight: 600 }}>
            Кто
          </span>
          {/* Тип user КОНТЕКСТНЫЙ: пикер предлагает только своих — сервер чужого отвергнет */}
          <EntitySelector
            types={['user']}
            context={{ workspaceId }}
            value={user}
            onChange={(next) => setUser(next.slice(-1) as { type: 'user'; id: string }[])}
            placeholder="Выберите сотрудника…"
          />
        </div>
        <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
          <DatePicker label="С даты" value={isoToDate(startsOn)} onChange={(d) => setStartsOn(dateToIso(d))} />
          <Input
            label="Доля ставки"
            inputMode="decimal"
            value={rateShare}
            onChange={(e) => setRateShare(e.target.value)}
            hint="1 — целая ставка, 0,5 — половина"
          />
        </div>
        <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
          <Select label="Тип ставки" value={rateType} onChange={setRateType} options={RATE_OPTIONS} />
          <Input
            label="Ставка"
            placeholder="250 000"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            hint={row.plannedRate ? 'Предзаполнено плановой ставкой позиции' : undefined}
          />
        </div>
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!user[0]?.id}
            onClick={() => save.mutate()}
          >
            Назначить
          </Button>
        </div>
      </div>
    </Modal>
  );
}
