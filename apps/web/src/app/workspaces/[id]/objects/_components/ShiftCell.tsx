'use client';

// Ячейка сетки смен: чипы смен за день + перетаскивание.
//
// Drag сделан на НАТИВНОМ HTML5-dnd (как в календаре): payload держим в модульной
// переменной, потому что dataTransfer теряет объекты. У мыши это перетаскивание,
// у клавиатуры и тапа — путь «выбрать смену → Переместить…» на самом чипе.
//
// ВРЕМЯ РИСУЕТСЯ В ПОЯСЕ ОБЪЕКТА (`timeIn`), а не браузера: сетка объекта в Актау,
// открытая из Алматы, обязана показывать время объекта — по нему люди выходят.

import { useState } from 'react';
import type { ShiftDto } from '@superapp/shared';
import { Button, Chip } from '@/components/ui';
import { timeIn, tint, todayIn } from '@/lib/objects-time';

/**
 * Что тащим: смена И СТРОКА, из которой её взяли. Без строки перенос на другого
 * человека в ТОТ ЖЕ день выглядел бы «ничего не изменилось» и молча терялся.
 */
let dragged: { shift: ShiftDto; rowKey: string } | null = null;

export function ShiftCell({
  date,
  rowKey,
  shifts,
  timeZone,
  canManage,
  canMark,
  onCreate,
  onOpenAttendance,
  onTake,
  onDropShift,
  onRequestMove,
  onCancel,
}: {
  date: string;
  /** Идентификатор строки сетки (человек или «Открытые») */
  rowKey: string;
  shifts: ShiftDto[];
  /** Пояс ОБЪЕКТА — в нём считается «сегодня» и рисуется время смены */
  timeZone: string;
  canManage: boolean;
  canMark: boolean;
  onCreate: () => void;
  onOpenAttendance: (shift: ShiftDto) => void;
  onTake: (shiftId: string) => void;
  onDropShift: (shift: ShiftDto) => void;
  /** Путь без мыши: открыть окно выбора «кому и на какой день» */
  onRequestMove: (shift: ShiftDto) => void;
  onCancel: (shift: ShiftDto) => void;
}) {
  const [over, setOver] = useState(false);
  const today = todayIn(timeZone);

  return (
    <div
      onDragOver={
        canManage
          ? (e) => {
              e.preventDefault();
              setOver(true);
            }
          : undefined
      }
      onDragLeave={() => setOver(false)}
      onDrop={
        canManage
          ? (e) => {
              e.preventDefault();
              setOver(false);
              // Перенос состоялся, если сменился ДЕНЬ ИЛИ СТРОКА (человек).
              if (dragged && (dragged.shift.localDate !== date || dragged.rowKey !== rowKey)) {
                onDropShift(dragged.shift);
              }
              dragged = null;
            }
          : undefined
      }
      style={{
        minHeight: 56,
        padding: 'var(--spacing-2)',
        borderRadius: 'var(--radius-md)',
        border: `1px dashed ${over ? 'var(--primary)' : 'var(--outline-variant)'}`,
        background: over ? 'var(--surface-container)' : 'transparent',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.25rem',
      }}
    >
      {shifts.map((s) => (
        <ShiftChip
          key={s.id}
          shift={s}
          rowKey={rowKey}
          timeZone={timeZone}
          canManage={canManage}
          canMark={canMark}
          past={s.localDate <= today}
          onOpenAttendance={onOpenAttendance}
          onTake={onTake}
          onRequestMove={onRequestMove}
          onCancel={onCancel}
        />
      ))}
      {canManage && (
        <Button size="sm" variant="ghost" icon="add" aria-label={`Добавить смену ${date}`} onClick={onCreate}>
          смена
        </Button>
      )}
    </div>
  );
}

function ShiftChip({
  shift,
  rowKey,
  timeZone,
  canManage,
  canMark,
  past,
  onOpenAttendance,
  onTake,
  onRequestMove,
  onCancel,
}: {
  shift: ShiftDto;
  rowKey: string;
  timeZone: string;
  canManage: boolean;
  canMark: boolean;
  past: boolean;
  onOpenAttendance: (shift: ShiftDto) => void;
  onTake: (shiftId: string) => void;
  onRequestMove: (shift: ShiftDto) => void;
  onCancel: (shift: ShiftDto) => void;
}) {
  const time = `${timeIn(shift.startsAt, timeZone)}–${timeIn(shift.endsAt, timeZone)}`;
  const cancelled = shift.status === 'cancelled';
  const draft = shift.status === 'draft';

  return (
    <div
      draggable={canManage && !cancelled}
      onDragStart={(e) => {
        dragged = { shift, rowKey };
        try {
          e.dataTransfer.setData('text/plain', shift.id);
          e.dataTransfer.effectAllowed = 'move';
        } catch {
          /* payload всё равно в модульной переменной */
        }
      }}
      onDragEnd={() => {
        dragged = null;
      }}
      style={{
        padding: '0.25rem 0.5rem',
        borderRadius: 'var(--radius-sm)',
        border: `1px solid ${shift.color ?? 'var(--outline-variant)'}`,
        // Прозрачность цвета-ДАННЫХ — только через tint(): `${color}22` ломал CSS
        // на любом нехекс-значении (var(--…), 'red'), и чип оставался без фона.
        background: tint(shift.color),
        opacity: cancelled ? 0.5 : 1,
        cursor: canManage && !cancelled ? 'grab' : 'default',
        fontSize: '0.72rem',
        lineHeight: 1.35,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>{time}</span>
        {draft && <Chip tone="neutral">черновик</Chip>}
        {cancelled && <Chip tone="danger">отменена</Chip>}
        {shift.attendance && (
          <Chip tone={shift.attendance.outcome === 'absent' ? 'danger' : shift.attendance.outcome === 'late' ? 'warning' : 'success'}>
            {shift.attendance.outcome === 'absent'
              ? 'не вышел'
              : shift.attendance.outcome === 'late'
                ? `+${shift.attendance.lateMin} мин`
                : 'вышел'}
          </Chip>
        )}
      </div>
      <div style={{ opacity: 0.75 }}>{shift.templateName ?? shift.positionName}</div>
      <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginTop: '0.15rem' }}>
        {shift.canTake && (
          <Button size="sm" variant="primary" onClick={() => onTake(shift.id)}>
            Возьму
          </Button>
        )}
        {canMark && past && !cancelled && shift.userId && (
          <Button size="sm" variant="ghost" onClick={() => onOpenAttendance(shift)}>
            {shift.attendance ? 'Правка факта' : 'Отметить'}
          </Button>
        )}
        {/* Путь без мыши: на телефоне виден ОДИН день, тащить некуда, а с клавиатуры
            нативный dnd недоступен вовсе. */}
        {canManage && !cancelled && (
          <Button size="sm" variant="ghost" icon="drag" onClick={() => onRequestMove(shift)}>
            Переместить…
          </Button>
        )}
        {canManage && !cancelled && (
          <Button size="sm" variant="ghost" tone="danger" onClick={() => onCancel(shift)}>
            Отменить
          </Button>
        )}
      </div>
    </div>
  );
}
