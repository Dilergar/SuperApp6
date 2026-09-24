'use client';

// Факт по смене: вышел / опоздал N мин / не вышел + фактическое время.
// Смысл несёт ФОРМА: исход — сегментированный выбор, действие — кнопка.
//
// НОЧНАЯ СМЕНА. Моменты собираются в поясе ОБЪЕКТА и от даты НАЧАЛА смены:
// у смены 22:00–06:00 «до 06:00» — это следующие сутки. Раньше оба момента
// вешались на один день, и конец оказывался на 16 часов РАНЬШЕ начала (сервер
// такой факт теперь отвергает — 400 «Фактическое окончание раньше начала»).

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import { ATTENDANCE_OUTCOMES, visibleOr, type Hidden, type Masked, type ShiftDto } from '@superapp/shared';
import { Button, Input, Modal, SegmentedControl, Textarea } from '@/components/ui';

import { localToIso, timeIn } from '@/lib/objects-time';
import { dmy } from '@/lib/dates';
import { shiftsApi } from '../objects-api';

import { toastApiError } from '@/lib/api-errors';
/** «09:05» → минуты от полуночи; неразборчивое — null */
function minutesOf(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Следующие сутки календарной даты (арифметика на строке, без пояса браузера) */
function addDays(dateIso: string, n: number): string {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function AttendanceModal({
  workspaceId,
  shift,
  timeZone,
  open,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  shift: ShiftDto;
  /** Пояс ОБЪЕКТА: время смены и факт живут в нём, а не в поясе браузера */
  timeZone: string;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const t = useTranslations('objects');
  const tc = useTranslations('common');
  // Отмечает факт тот, кто его видит (ведущий график); маркер движка — как «не отмечено»
  const att = shift.attendance;
  const seen = <T,>(v: T | Masked | Hidden | undefined): T | null => (v === undefined ? null : visibleOr(v, null));
  const [outcome, setOutcome] = useState<string>(seen(att?.outcome) ?? 'worked');
  const [lateMin, setLateMin] = useState(String(seen(att?.lateMin) ?? 0));
  const [startAt, setStartAt] = useState(() => {
    const at = seen(att?.actualStartAt);
    return at ? timeIn(at, timeZone) : timeIn(shift.startsAt, timeZone);
  });
  const [endAt, setEndAt] = useState(() => {
    const at = seen(att?.actualEndAt);
    return at ? timeIn(at, timeZone) : timeIn(shift.endsAt, timeZone);
  });
  const [note, setNote] = useState<string>(seen(att?.note) ?? '');

  const startMin = minutesOf(startAt);
  const endMin = minutesOf(endAt);
  const overnight = startMin !== null && endMin !== null && endMin < startMin;

  const save = useMutation({
    mutationFn: async () => {
      const late = Number(lateMin) || 0;
      let actualStartAt: string | null = null;
      let actualEndAt: string | null = null;

      if (outcome !== 'absent') {
        if (startMin === null) throw new Error(t('attendance.startFormat'));
        if (endMin === null) throw new Error(t('attendance.endFormat'));
        actualStartAt = localToIso(shift.localDate, startAt, timeZone);
        // Конец РАНЬШЕ начала = смена перевалила за полночь → следующие сутки.
        actualEndAt = localToIso(endMin < startMin ? addDays(shift.localDate, 1) : shift.localDate, endAt, timeZone);
      }

      return shiftsApi.markAttendance(workspaceId, shift.id, {
        outcome,
        lateMin: outcome === 'late' ? late : 0,
        actualStartAt,
        actualEndAt,
        note: note.trim() || null,
      });
    },
    onSuccess: () => {
      onSaved?.();
      onClose();
    },
    onError: (e) => toastApiError(e),
  });

  return (
    <Modal open={open} onClose={onClose} title={t('attendance.title', { date: dmy(shift.localDate) })}>
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        <SegmentedControl
          value={outcome}
          onChange={setOutcome}
          items={ATTENDANCE_OUTCOMES.map((o) => ({ key: o.value, label: t(`attendanceOutcome.${o.value}`) }))}
        />
        {outcome === 'late' && (
          <Input
            label={t('attendance.lateMin')}
            inputMode="numeric"
            value={lateMin}
            onChange={(e) => setLateMin(e.target.value)}
          />
        )}
        {outcome !== 'absent' && (
          <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-3)' }}>
            <Input
              label={t('attendance.actualFrom')}
              placeholder="09:00"
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
            />
            <Input
              label={t('attendance.actualTo')}
              placeholder="18:00"
              value={endAt}
              hint={overnight ? t('attendance.overnightHint') : undefined}
              onChange={(e) => setEndAt(e.target.value)}
            />
          </div>
        )}
        <Textarea label={t('attendance.comment')} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>
            {tc('actions.cancel')}
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {tc('actions.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
