'use client';

// Версии фактической (управленческой) ставки человека: история + «новая ставка с даты».
// Официальный оклад отсюда НЕ правится — он живёт в КЭДО и меняется приказом
// `salary_change`: кнопка ведёт на страницу человека, где этот приказ и заводится.

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RATE_TYPES, type StaffRateDto } from '@superapp/shared';
import { Button, Chip, DatePicker, Divider, Input, Modal, Select } from '@/components/ui';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { dmy } from '@/lib/dates';
import { dateToIso, isoToDate, todayIn } from '@/lib/objects-time';
import { assignmentRatesKey } from '@/lib/queries';
import { staffingApi } from '../objects-api';

const RATE_OPTIONS = RATE_TYPES.filter((r) => !('reserved' in r && r.reserved)).map((r) => ({
  value: r.value,
  label: r.label,
}));
const RATE_LABEL = new Map(RATE_TYPES.map((r) => [r.value, r.label]));

function tengeToTiyn(v: string): string | null {
  const clean = v.replace(/\s/g, '').replace(',', '.');
  if (!clean) return null;
  const n = Number(clean);
  if (!Number.isFinite(n) || n < 0) return null;
  return String(Math.round(n * 100));
}

function money(amount: string, currency = 'KZT'): string {
  return `${(Number(amount) / 100).toLocaleString('ru-RU')} ${currency === 'KZT' ? '₸' : currency}`;
}

export function RateHistory({
  workspaceId,
  assignmentId,
  userId,
  userName,
  timeZone,
  showMoney = true,
  assignment,
  open,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  assignmentId: string;
  userId: string;
  userName: string;
  /** Пояс ОБЪЕКТА: «сегодня» до 05:00 по Алматы в UTC — это ещё вчера */
  timeZone: string;
  /**
   * Видит ли зритель деньги. Без права остаётся только период назначения — это
   * ЕДИНСТВЕННОЕ место, где чинится ошибочно закрытое назначение, поэтому окно
   * открывается и без `payrollView`.
   */
  showMoney?: boolean;
  /** Текущие даты и доля ставки назначения (правятся здесь же) */
  assignment?: { startsOn: string | null; endsOn: string | null; rateShare: number } | null;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const [rateType, setRateType] = useState('monthly');
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState<string | undefined>(todayIn(timeZone));
  const [startsOn, setStartsOn] = useState<string | undefined>(assignment?.startsOn ?? undefined);
  const [endsOn, setEndsOn] = useState<string | undefined>(assignment?.endsOn ?? undefined);
  const [share, setShare] = useState(String(assignment?.rateShare ?? 1));

  const { data: rates } = useQuery({
    queryKey: assignmentRatesKey(workspaceId, assignmentId),
    queryFn: () => staffingApi.rates(workspaceId, assignmentId),
    enabled: open,
  });

  // Период и доля ставки — свойства НАЗНАЧЕНИЯ, а не ставки: правятся отдельно.
  // Пустая дата отправляется ЯВНЫМ null (сервер это принимает): иначе снять
  // ошибочно поставленную дату окончания было нечем — «уволенный» оставался
  // уволенным навсегда.
  const savePeriod = useMutation({
    mutationFn: async () =>
      staffingApi.updateAssignment(workspaceId, assignmentId, {
        startsOn: startsOn ?? null,
        endsOn: endsOn ?? null,
        ...(share.trim() ? { rateShare: Number(share.replace(',', '.')) } : {}),
      }),
    onSuccess: () => onSaved?.(),
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const save = useMutation({
    mutationFn: async () => {
      const tiyn = tengeToTiyn(amount);
      if (tiyn === null) throw new Error('Ставка — это число, например 250 000');
      return staffingApi.setActualRate(workspaceId, assignmentId, {
        rateType,
        amount: tiyn,
        effectiveFrom: from,
      });
    },
    onSuccess: () => {
      setAmount('');
      void qc.invalidateQueries({ queryKey: assignmentRatesKey(workspaceId, assignmentId) });
      onSaved?.();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <Modal open={open} onClose={onClose} title={`${showMoney ? 'Ставки' : 'Период работы'} — ${userName}`}>
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {showMoney && (
        <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
          {(rates ?? []).length === 0 ? (
            <span className="label-sm">Ставок пока нет</span>
          ) : (
            (rates as StaffRateDto[]).map((r) => (
              <div
                key={r.id}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}
              >
                <span style={{ fontWeight: 600 }}>{money(r.amount, r.currency)}</span>
                <span className="label-sm">{RATE_LABEL.get(r.rateType) ?? r.rateType}</span>
                <span className="label-sm" style={{ opacity: 0.7 }}>
                  {r.effectiveTo ? `${dmy(r.effectiveFrom)} — ${dmy(r.effectiveTo)}` : `с ${dmy(r.effectiveFrom)}`}
                </span>
                {!r.effectiveTo && <Chip tone="success">Действует</Chip>}
              </div>
            ))
          )}
        </div>
        )}

        {showMoney && <Divider />}

        {showMoney && (
        <div className="grid md:grid-cols-3" style={{ gap: 'var(--spacing-3)', alignItems: 'end' }}>
          <Select label="Тип" value={rateType} onChange={setRateType} options={RATE_OPTIONS} />
          <Input
            label="Сумма"
            placeholder="250 000"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <DatePicker label="С даты" value={isoToDate(from)} onChange={(d) => setFrom(dateToIso(d))} />
        </div>
        )}
        <Divider />

        <div className="grid md:grid-cols-3" style={{ gap: 'var(--spacing-3)', alignItems: 'end' }}>
          <DatePicker label="Работает с" value={isoToDate(startsOn)} onChange={(d) => setStartsOn(dateToIso(d))} />
          <DatePicker
            label="По"
            value={isoToDate(endsOn)}
            hint="Очистите дату, чтобы вернуть человека в работу"
            onChange={(d) => setEndsOn(dateToIso(d))}
          />
          <Input label="Доля ставки" inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button size="sm" variant="outline" loading={savePeriod.isPending} onClick={() => savePeriod.mutate()}>
            Сохранить период
          </Button>
        </div>

        {showMoney && (
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          {/* Официальный оклад меняется ПРИКАЗОМ — отсюда только ссылка в КЭДО */}
          <Link href={`/workspaces/${workspaceId}/members/${userId}`} style={{ textDecoration: 'none' }}>
            <Button variant="ghost" size="sm">
              Изменить официальный оклад
            </Button>
          </Link>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!amount.trim()}
            onClick={() => save.mutate()}
          >
            Новая ставка
          </Button>
        </div>
        )}
      </div>
    </Modal>
  );
}
