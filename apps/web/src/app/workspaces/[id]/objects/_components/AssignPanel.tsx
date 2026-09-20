'use client';

// Назначение человека на штатную единицу: кто, с какой даты, доля ставки и
// фактическая ставка (предзаполнена плановой). Ставка пишется той же транзакцией,
// что и назначение — «назначили, а платить забыли» быть не должно.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RATE_TYPES, type StaffingRowDto } from '@superapp/shared';
import { Button, DatePicker, Input, Modal, Select } from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';

import { dateToIso, isoToDate, todayIn } from '@/lib/objects-time';
import { objectStaffingKey } from '@/lib/queries';
import { staffingApi } from '../objects-api';

import { toastApiError } from '@/lib/api-errors';
/** Типы ставок, которые предлагаются человеку (`revenue_share` зарезервирован). */
const RATE_VALUES = RATE_TYPES.filter((r) => !('reserved' in r && r.reserved)).map((r) => r.value);

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
  const t = useTranslations('objects');
  const tc = useTranslations('common');
  const rateOptions = RATE_VALUES.map((value) => ({ value, label: t(`rateType.${value}`) }));
  const [user, setUser] = useState<{ type: 'user'; id: string }[]>([]);
  const [startsOn, setStartsOn] = useState<string | undefined>(todayIn(timeZone));
  const [rateShare, setRateShare] = useState('1');
  const [rateType, setRateType] = useState(row.plannedRate?.rateType ?? 'monthly');
  const [amount, setAmount] = useState(tiynToTenge(row.plannedRate?.amount));

  const save = useMutation({
    mutationFn: async () => {
      const tiyn = tengeToTiyn(amount);
      if (amount.trim() && tiyn === null) throw new Error(t('staffing.rateIsNumber'));
      const share = Number(rateShare.replace(',', '.'));
      if (!Number.isFinite(share) || share <= 0) throw new Error(t('staffing.shareIsNumber'));
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
    onError: (e) => toastApiError(e),
  });

  return (
    <Modal open={open} onClose={onClose} title={t('staffing.assignTo', { name: row.positionName })}>
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        <div>
          <span className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-2)', fontWeight: 600 }}>
            {t('attendance.who')}
          </span>
          {/* Тип user КОНТЕКСТНЫЙ: пикер предлагает только своих — сервер чужого отвергнет */}
          <EntitySelector
            types={['user']}
            context={{ workspaceId }}
            value={user}
            onChange={(next) => setUser(next.slice(-1) as { type: 'user'; id: string }[])}
            placeholder={t('staffing.personPlaceholder')}
          />
        </div>
        <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
          <DatePicker label={t('staffing.fromDate')} value={isoToDate(startsOn)} onChange={(d) => setStartsOn(dateToIso(d))} />
          <Input
            label={t('staffing.rateShare')}
            inputMode="decimal"
            value={rateShare}
            onChange={(e) => setRateShare(e.target.value)}
            hint={t('staffing.rateShareHint')}
          />
        </div>
        <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
          <Select label={t('staffing.rateType')} value={rateType} onChange={setRateType} options={rateOptions} />
          <Input
            label={t('staffing.rate')}
            placeholder="250 000"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            hint={row.plannedRate ? t('staffing.rateFromPlanned') : undefined}
          />
        </div>
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>
            {tc('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!user[0]?.id}
            onClick={() => save.mutate()}
          >
            {t('staffing.assign')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
