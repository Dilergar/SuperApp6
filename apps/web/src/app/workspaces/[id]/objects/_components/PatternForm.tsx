'use client';

// Ротация (2/2, 5/2, произвольный цикл): цикл собирается КЛИКАМИ по дням —
// каждый день переключается между шаблонами и «выходным». Якорная дата задаёт
// фазу: с неё цикл начинается.
//
// Даты по умолчанию — «сегодня» В ПОЯСЕ ОБЪЕКТА: UTC-дата ночью отставала на
// сутки, и ротация начиналась вчера.

import { useMemo, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ShiftPatternDto, ShiftTemplateDto, StaffingTableDto } from '@superapp/shared';
import { Alert, Button, Chip, DatePicker, Divider, Input, Modal, Select, useConfirm } from '@/components/ui';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { dmy } from '@/lib/dates';
import { dateToIso, isoToDate, monthIn, tint, todayIn } from '@/lib/objects-time';
import { objectShiftsKey, objectStaffingKey, shiftPatternsKey, shiftTemplatesKey } from '@/lib/queries';
import { fetchShiftTemplates, fetchStaffing, shiftsApi } from '../objects-api';

export function PatternForm({
  workspaceId,
  objectId,
  timeZone,
  open,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  objectId: string;
  /** Пояс ОБЪЕКТА — в нём считаются «сегодня» и текущий период */
  timeZone: string;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();
  const today = todayIn(timeZone);
  const period = monthIn(timeZone);

  const { data: templates } = useQuery({
    queryKey: shiftTemplatesKey(workspaceId, objectId),
    queryFn: () => fetchShiftTemplates(workspaceId, objectId),
    enabled: open,
  });
  const { data: staffing } = useQuery({
    queryKey: objectStaffingKey(workspaceId, objectId, period),
    queryFn: () => fetchStaffing(workspaceId, objectId, period),
    enabled: open,
  });
  const { data: patterns } = useQuery({
    queryKey: shiftPatternsKey(workspaceId, objectId),
    queryFn: () => shiftsApi.patterns(workspaceId, objectId),
    enabled: open,
  });

  const tplList = (templates as ShiftTemplateDto[] | undefined) ?? [];
  const targets = useMemo(() => {
    const rows = (staffing as StaffingTableDto | undefined)?.rows ?? [];
    const out: { value: string; label: string }[] = [];
    for (const r of rows) {
      if (r.assignment) out.push({ value: `a:${r.assignment.id}`, label: `${r.assignment.userName} · ${r.positionName}` });
    }
    const units = new Map<string, string>();
    for (const r of rows) if (!units.has(r.staffingPositionId)) units.set(r.staffingPositionId, r.positionName);
    for (const [unitId, label] of units) out.push({ value: `u:${unitId}`, label: `Открытые слоты · ${label}` });
    return out;
  }, [staffing]);

  const [name, setName] = useState('2/2');
  const [target, setTarget] = useState('');
  const [cycleLen, setCycleLen] = useState(4);
  const [cycle, setCycle] = useState<(string | null)[]>([null, null, null, null]);
  const [anchor, setAnchor] = useState<string | undefined>(today);
  const [activeFrom, setActiveFrom] = useState<string | undefined>(today);

  const setLen = (n: number) => {
    setCycleLen(n);
    setCycle((prev) => Array.from({ length: n }, (_, i) => prev[i] ?? null));
  };

  /** Клик по дню: следующий шаблон в списке → … → выходной → первый */
  const toggleDay = (i: number) => {
    setCycle((prev) => {
      const next = [...prev];
      const cur = next[i];
      const idx = cur ? tplList.findIndex((t) => t.id === cur) : -1;
      next[i] = idx + 1 >= tplList.length ? null : tplList[idx + 1].id;
      return next;
    });
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error('Выберите, для кого ротация');
      if (cycle.every((c) => !c)) throw new Error('В цикле нет ни одной смены');
      const [kind, id] = target.split(':');
      return shiftsApi.createPattern(workspaceId, objectId, {
        name: name.trim(),
        ...(kind === 'a' ? { assignmentId: id } : { staffingPositionId: id }),
        anchorDate: anchor,
        cycle,
        activeFrom,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: shiftPatternsKey(workspaceId, objectId) });
      onSaved?.();
      onClose();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  // Догенерация: ротация порождает смены на горизонт, и после сдвига горизонта
  // (или ручной чистки) их нужно дособрать. Идемпотентно — повтор безопасен.
  const generate = useMutation({
    mutationFn: (patId: string) => shiftsApi.generate(workspaceId, patId),
    onSuccess: () => {
      // Префикс ключа сетки (ключ — из lib/queries.ts): ротация сеет смены на
      // недели вперёд, инвалидировать одну видимую неделю недостаточно.
      void qc.invalidateQueries({ queryKey: objectShiftsKey(workspaceId, objectId, '', '').slice(0, -2) });
      onSaved?.();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (patId: string) => shiftsApi.removePattern(workspaceId, patId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: shiftPatternsKey(workspaceId, objectId) });
      onSaved?.();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <Modal open={open} onClose={onClose} title="Ротация смен" size="lg">
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
          {((patterns as ShiftPatternDto[] | undefined) ?? []).length === 0 ? (
            <span className="label-sm">Ротаций пока нет</span>
          ) : (
            ((patterns as ShiftPatternDto[]) ?? []).map((p) => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600 }}>{p.name}</span>
                <Chip tone="neutral">{`цикл ${p.cycle.length} дн.`}</Chip>
                <span className="label-sm" style={{ opacity: 0.7 }}>{`с ${dmy(p.activeFrom)}`}</span>
                <Button size="sm" variant="ghost" loading={generate.isPending} onClick={() => generate.mutate(p.id)}>
                  Догенерировать
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  tone="danger"
                  onClick={() =>
                    confirm(
                      {
                        title: 'Убрать ротацию?',
                        message: 'Будущие ЧЕРНОВИКИ снимутся; опубликованные смены останутся.',
                        confirmLabel: 'Убрать',
                      },
                      () => remove.mutateAsync(p.id).then(() => undefined),
                    )
                  }
                >
                  Убрать
                </Button>
              </div>
            ))
          )}
        </div>

        <Divider />

        {/* Цикл собирается ИЗ ШАБЛОНОВ: без них форма нерабочая по существу —
            говорим причину, а не показываем вечно выключенную кнопку. */}
        {tplList.length === 0 && (
          <Alert tone="warning" title="Сначала нужен шаблон смены">
            Ротация переключает дни между шаблонами и выходным. Заведите хотя бы один шаблон в разделе «Шаблоны».
          </Alert>
        )}

        <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-3)' }}>
          <Input label="Название" placeholder="2/2" value={name} onChange={(e) => setName(e.target.value)} />
          <Select label="Для кого" value={target} onChange={setTarget} options={[{ value: '', label: 'Выберите…' }, ...targets]} />
          <DatePicker label="Якорная дата (начало цикла)" value={isoToDate(anchor)} onChange={(d) => setAnchor(dateToIso(d))} />
          <DatePicker label="Действует с" value={isoToDate(activeFrom)} onChange={(d) => setActiveFrom(dateToIso(d))} />
        </div>

        <div>
          <span className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-2)', fontWeight: 600 }}>
            Цикл — кликните по дню, чтобы выбрать смену или выходной
          </span>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: 'var(--spacing-3)' }}>
            {[2, 3, 4, 5, 7, 14].map((n) => (
              <Button key={n} size="sm" variant={cycleLen === n ? 'primary' : 'ghost'} onClick={() => setLen(n)}>
                {`${n} дн.`}
              </Button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {cycle.map((c, i) => {
              const tpl = tplList.find((t) => t.id === c);
              // Цвет-ДАННЫЕ шаблона подаётся подменой тон-переменных кита (DESIGN.md),
              // а не своей вёрсткой: форма, радиус и поведение остаются системными.
              const toneStyle: CSSProperties = tpl
                ? ({ minWidth: 88, '--tone-bg': tint(tpl.color), '--tone-border': tpl.color ?? 'var(--outline-variant)' } as CSSProperties)
                : { minWidth: 88 };
              return (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                  <span className="meta" style={{ textAlign: 'center' }}>{`день ${i + 1}`}</span>
                  <Button
                    size="sm"
                    variant={tpl ? 'matte' : 'outline'}
                    style={toneStyle}
                    aria-label={`День ${i + 1}: ${tpl ? tpl.name : 'выходной'}. Нажмите, чтобы сменить`}
                    onClick={() => toggleDay(i)}
                  >
                    {tpl ? tpl.name : 'выходной'}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!target || tplList.length === 0} onClick={() => save.mutate()}>
            Создать ротацию
          </Button>
        </div>
      </div>
      {confirmUI}
    </Modal>
  );
}
