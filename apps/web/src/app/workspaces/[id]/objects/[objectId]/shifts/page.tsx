'use client';

// ============================================================
// График смен объекта: строки — люди объекта + «Открытые», столбцы — 7 дней.
// Черновик виден только тем, кто ведёт график (сервер их и не отдаёт иначе).
// Перенос смены — нативные pointer-события; альтернативный путь без мыши —
// «выбрать смену → Переместить…» (клавиатура и тап).
// Мобилка — один день: сетка 7×N на 375 px нечитаема.
//
// ВСЕ ДАТЫ — В ПОЯСЕ ОБЪЕКТА. `new Date().toISOString()` даёт UTC, а Казахстан
// UTC+5: каждую ночь с 00:00 до 05:00 раздел открывался на ПРОШЛОЙ неделе.
// ============================================================

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ShiftDto } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  LoadingBlock,
  Modal,
  SegmentedControl,
  Select,
  useConfirm,
} from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { apiErrorMessage } from '@/lib/api';
import { toast, toastError } from '@/lib/toast';
import { dmy } from '@/lib/dates';
import { FALLBACK_TZ, minutesIn, todayIn } from '@/lib/objects-time';
import { objectKey, objectShiftsKey, shiftTemplatesKey } from '@/lib/queries';
import { fetchObject, fetchShiftBoard, shiftsApi } from '../../objects-api';
import { ShiftCell } from '../../_components/ShiftCell';
import { ShiftForm } from '../../_components/ShiftForm';
import { AttendanceModal } from '../../_components/AttendanceModal';
import { ShiftTemplatesPanel } from '../../_components/ShiftTemplatesPanel';
import { PatternForm } from '../../_components/PatternForm';
import { UnplannedAttendanceModal } from '../../_components/UnplannedAttendanceModal';

const DAY_LABEL = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const OPEN_ROW = '__open__';

/** Строка сетки: человек объекта или «Открытые смены». */
interface BoardRow {
  key: string;
  userId: string | null;
  /** Действующее назначение — цель переноса смены (у «Открытых» его нет) */
  assignmentId: string | null;
  name: string;
}

// Календарная арифметика ведётся на СТРОКАХ `YYYY-MM-DD` через полуночь UTC:
// объект Date с локальными частями браузера снова протащил бы сюда чужой пояс.
function addDaysIso(dateIso: string, n: number): string {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Понедельник недели, содержащей дату */
function weekStartIso(dateIso: string): string {
  return addDaysIso(dateIso, -((new Date(`${dateIso}T00:00:00.000Z`).getUTCDay() + 6) % 7));
}

function dowIso(dateIso: string): number {
  return new Date(`${dateIso}T00:00:00.000Z`).getUTCDay();
}

function dayNumIso(dateIso: string): number {
  return Number(dateIso.slice(8, 10));
}

function dayLabelIso(dateIso: string): string {
  return `${DAY_LABEL[dowIso(dateIso)]} ${dayNumIso(dateIso)}`;
}

export default function ShiftsPage() {
  const { isReady } = useRequireAuth();
  const isMobile = useIsMobile();
  const { id, objectId } = useParams<{ id: string; objectId: string }>();
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();

  // Пояс объекта нужен ДО сетки (от него зависит «сегодня», а значит и период
  // запроса). Карточку уже загрузил layout — это попадание в кэш, не запрос.
  const { data: object } = useQuery({
    queryKey: objectKey(id, objectId),
    queryFn: () => fetchObject(id, objectId),
    enabled: isReady && !!objectId,
  });
  const timeZone = object?.timeZone ?? FALLBACK_TZ;

  // null = «текущая неделя»: якорь пересчитается, как только приедет пояс объекта.
  const [anchor, setAnchor] = useState<string | null>(null);
  const [mobileDay, setMobileDay] = useState(0);
  const [creating, setCreating] = useState<{ date: string; userId: string | null } | null>(null);
  const [attendanceFor, setAttendanceFor] = useState<ShiftDto | null>(null);
  const [movingShift, setMovingShift] = useState<ShiftDto | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showPattern, setShowPattern] = useState(false);
  const [unplanned, setUnplanned] = useState(false);

  const weekStart = anchor ?? weekStartIso(todayIn(timeZone));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysIso(weekStart, i)), [weekStart]);
  const from = days[0];
  const to = days[6];

  const { data: board, isPending } = useQuery({
    queryKey: objectShiftsKey(id, objectId, from, to),
    queryFn: () => fetchShiftBoard(id, objectId, from, to),
    enabled: isReady && !!objectId && !!object,
  });

  // Префикс ключа сетки: перенос и ротация трогают соседние недели, поэтому
  // инвалидируется ВЕСЬ раздел смен объекта. Ключ — из lib/queries.ts, литерала нет.
  const shiftsPrefix = objectShiftsKey(id, objectId, '', '').slice(0, -2);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: shiftsPrefix });
    void qc.invalidateQueries({ queryKey: shiftTemplatesKey(id, objectId) });
  };

  const publish = useMutation({
    mutationFn: () => shiftsApi.publish(id, objectId, from, to),
    onSuccess: (res) => {
      invalidate();
      // Ручка публикует ПАЧКОЙ: если черновиков больше одной пачки, остаток
      // остаётся черновиком — молчать об этом нельзя, график выглядел бы полным.
      if (res.hasMore) {
        toast(`Опубликовано ${res.published} смен — это не вся неделя. Нажмите «Опубликовать неделю» ещё раз.`);
      }
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const take = useMutation({
    mutationFn: (shiftId: string) => shiftsApi.take(id, shiftId),
    onSuccess: invalidate,
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const move = useMutation({
    mutationFn: (args: { shift: ShiftDto; date: string; assignmentId: string | null }) => {
      // Назначение цели берётся из СТРОКИ сетки (board.people[].assignmentId).
      // Раньше его искали среди загруженных смен — и человек без смен в этой
      // неделе молча оставался прежним владельцем смены.
      const minutes = minutesIn(args.shift.startsAt, timeZone);
      const duration = Math.round(
        (new Date(args.shift.endsAt).getTime() - new Date(args.shift.startsAt).getTime()) / 60_000,
      );
      return shiftsApi.update(id, args.shift.id, {
        localDate: args.date,
        startMin: minutes,
        durationMin: duration,
        version: args.shift.version,
        assignmentId: args.assignmentId,
      });
    },
    onSuccess: () => {
      invalidate();
      setMovingShift(null);
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const cancelShift = useMutation({
    mutationFn: (shiftId: string) => shiftsApi.cancel(id, shiftId),
    onSuccess: invalidate,
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const caps = board?.caps;
  const rows: BoardRow[] = [
    ...(board?.people ?? []).map((p) => ({
      key: p.userId,
      userId: p.userId as string | null,
      assignmentId: p.assignmentId as string | null,
      name: p.userName,
    })),
    { key: OPEN_ROW, userId: null, assignmentId: null, name: 'Открытые смены' },
  ];
  const visibleDays = isMobile ? [days[Math.min(mobileDay, days.length - 1)]] : days;

  const shiftsAt = (userId: string | null, date: string) =>
    (board?.shifts ?? []).filter((s) => s.localDate === date && (s.userId ?? null) === userId);

  if (!isReady) return null;

  // Панель управления: на 375 px пять кнопок в `actions` съедали заголовок —
  // там она едет ПОД шапку отдельной переносимой строкой.
  const controls = (
    <>
      <Button size="sm" variant="ghost" icon="arrowLeft" aria-label="Предыдущая неделя" onClick={() => setAnchor(addDaysIso(weekStart, -7))} />
      <Button size="sm" variant="ghost" onClick={() => setAnchor(weekStartIso(todayIn(timeZone)))}>
        Сегодня
      </Button>
      <Button size="sm" variant="ghost" icon="arrowRight" aria-label="Следующая неделя" onClick={() => setAnchor(addDaysIso(weekStart, 7))} />
      {caps?.attendanceMark && (
        <Button size="sm" variant="ghost" onClick={() => setUnplanned(true)}>
          Внеплановый выход
        </Button>
      )}
      {caps?.scheduleManage && (
        <>
          <Button size="sm" variant="ghost" onClick={() => setShowTemplates(true)}>
            Шаблоны
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowPattern(true)}>
            Ротация
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={publish.isPending}
            disabled={!board?.hasDrafts}
            onClick={() => publish.mutate()}
          >
            Опубликовать неделю
          </Button>
        </>
      )}
    </>
  );

  return (
    <>
      <Card>
        <CardHeader
          title="График смен"
          subtitle={board ? `${dmy(from)} — ${dmy(to)} · пояс объекта ${board.timeZone}` : undefined}
          actions={isMobile ? undefined : controls}
        />
        {isMobile && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: 'var(--spacing-4)' }}>
            {controls}
          </div>
        )}

        {isMobile && (
          <div style={{ marginBottom: 'var(--spacing-4)' }}>
            <SegmentedControl
              value={String(mobileDay)}
              onChange={(k) => setMobileDay(Number(k))}
              items={days.map((d, i) => ({ key: String(i), label: dayLabelIso(d) }))}
            />
          </div>
        )}

        {isPending ? (
          <LoadingBlock />
        ) : (board?.people.length ?? 0) === 0 && (board?.shifts.length ?? 0) === 0 ? (
          <EmptyState
            icon="calendarCheck"
            title="Смен пока нет"
            description={
              caps?.scheduleManage
                ? 'Заведите шаблон смены и поставьте первую — или задайте ротацию 2/2, и смены появятся сами.'
                : 'Когда управляющий опубликует график, он появится здесь и в вашем календаре.'
            }
            action={
              caps?.scheduleManage ? (
                <Button variant="primary" onClick={() => setShowTemplates(true)}>
                  Шаблоны смен
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `minmax(150px, 200px) repeat(${visibleDays.length}, minmax(120px, 1fr))`,
                gap: 'var(--spacing-2)',
                minWidth: isMobile ? undefined : 900,
              }}
            >
              <div />
              {visibleDays.map((d) => (
                <div key={d} className="label-sm" style={{ fontWeight: 600, textAlign: 'center' }}>
                  {dayLabelIso(d)}
                </div>
              ))}

              {rows.map((row) => (
                <ShiftRow
                  key={row.key}
                  row={row}
                  days={visibleDays}
                  timeZone={timeZone}
                  caps={caps}
                  shiftsAt={shiftsAt}
                  onCreate={(date) => setCreating({ date, userId: row.userId })}
                  onOpenAttendance={setAttendanceFor}
                  onTake={(shiftId) => take.mutate(shiftId)}
                  onMove={(shift, date) => move.mutate({ shift, date, assignmentId: row.assignmentId })}
                  onRequestMove={setMovingShift}
                  onCancel={(shift) =>
                    confirm(
                      {
                        title: 'Отменить смену?',
                        message: `${dmy(shift.localDate)} · ${shift.positionName}. Отменённая смена остаётся в истории.`,
                        confirmLabel: 'Отменить смену',
                        danger: true,
                      },
                      () => cancelShift.mutateAsync(shift.id).then(() => undefined),
                    )
                  }
                />
              ))}
            </div>
          </div>
        )}

        {board && (
          <div style={{ marginTop: 'var(--spacing-4)', display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
            <Chip tone={board.hasDrafts ? 'warning' : 'success'}>
              {board.hasDrafts ? 'Есть черновики' : 'Всё опубликовано'}
            </Chip>
            <span className="label-sm" style={{ opacity: 0.7 }}>
              {`Смен за неделю: ${board.shifts.length}`}
            </span>
          </div>
        )}
      </Card>

      {creating && (
        <ShiftForm
          workspaceId={id}
          objectId={objectId}
          open
          localDate={creating.date}
          userId={creating.userId}
          canManage={!!caps?.manage}
          onClose={() => setCreating(null)}
          onSaved={invalidate}
        />
      )}
      {attendanceFor && (
        <AttendanceModal
          workspaceId={id}
          shift={attendanceFor}
          timeZone={timeZone}
          open
          onClose={() => setAttendanceFor(null)}
          onSaved={invalidate}
        />
      )}
      {movingShift && (
        <MoveShiftModal
          key={movingShift.id}
          shift={movingShift}
          rows={rows}
          days={days}
          busy={move.isPending}
          open
          onClose={() => setMovingShift(null)}
          onMove={(date, assignmentId) => move.mutate({ shift: movingShift, date, assignmentId })}
        />
      )}
      {showTemplates && (
        <ShiftTemplatesPanel
          workspaceId={id}
          objectId={objectId}
          open
          onClose={() => setShowTemplates(false)}
          onSaved={invalidate}
        />
      )}
      {unplanned && (
        <UnplannedAttendanceModal
          workspaceId={id}
          objectId={objectId}
          people={board?.people ?? []}
          timeZone={timeZone}
          open
          onClose={() => setUnplanned(false)}
          onSaved={invalidate}
        />
      )}
      {showPattern && (
        <PatternForm
          workspaceId={id}
          objectId={objectId}
          timeZone={timeZone}
          open
          onClose={() => setShowPattern(false)}
          onSaved={invalidate}
        />
      )}
      {confirmUI}
    </>
  );
}

function ShiftRow({
  row,
  days,
  timeZone,
  caps,
  shiftsAt,
  onCreate,
  onOpenAttendance,
  onTake,
  onMove,
  onRequestMove,
  onCancel,
}: {
  row: BoardRow;
  days: string[];
  timeZone: string;
  caps: { scheduleManage: boolean; attendanceMark: boolean } | undefined;
  shiftsAt: (userId: string | null, date: string) => ShiftDto[];
  onCreate: (date: string) => void;
  onOpenAttendance: (shift: ShiftDto) => void;
  onTake: (shiftId: string) => void;
  onMove: (shift: ShiftDto, date: string) => void;
  onRequestMove: (shift: ShiftDto) => void;
  onCancel: (shift: ShiftDto) => void;
}) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', minHeight: 56 }}>
        {row.userId ? (
          <PersonChip size="S" userId={row.userId} firstName={row.name} />
        ) : (
          <Chip tone="accent">Открытые смены</Chip>
        )}
      </div>
      {days.map((date) => (
        <ShiftCell
          key={`${row.key}:${date}`}
          date={date}
          rowKey={row.key}
          timeZone={timeZone}
          shifts={shiftsAt(row.userId, date)}
          canManage={!!caps?.scheduleManage}
          canMark={!!caps?.attendanceMark}
          onCreate={() => onCreate(date)}
          onOpenAttendance={onOpenAttendance}
          onTake={onTake}
          onDropShift={(shift) => onMove(shift, date)}
          onRequestMove={onRequestMove}
          onCancel={onCancel}
        />
      ))}
    </>
  );
}

/**
 * Перенос БЕЗ МЫШИ. Нативный drag недоступен с клавиатуры, а на телефоне виден
 * один день — тащить физически некуда. Док `objects_shifts.md` этот путь обещает.
 */
function MoveShiftModal({
  shift,
  rows,
  days,
  busy,
  open,
  onClose,
  onMove,
}: {
  shift: ShiftDto;
  rows: BoardRow[];
  days: string[];
  busy: boolean;
  open: boolean;
  onClose: () => void;
  onMove: (date: string, assignmentId: string | null) => void;
}) {
  const currentRow = shift.userId ?? OPEN_ROW;
  const [rowKey, setRowKey] = useState(rows.some((r) => r.key === currentRow) ? currentRow : OPEN_ROW);
  const [date, setDate] = useState(days.includes(shift.localDate) ? shift.localDate : days[0]);

  const target = rows.find((r) => r.key === rowKey);
  const unchanged = rowKey === currentRow && date === shift.localDate;

  return (
    <Modal open={open} onClose={onClose} title="Переместить смену" size="sm">
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        <span className="label-sm" style={{ opacity: 0.75 }}>
          {`${shift.templateName ?? shift.positionName} · сейчас ${dmy(shift.localDate)}`}
        </span>
        <Select
          label="Кому"
          value={rowKey}
          onChange={setRowKey}
          options={rows.map((r) => ({ value: r.key, label: r.name }))}
        />
        <Select
          label="День"
          value={date}
          onChange={setDate}
          options={days.map((d) => ({ value: d, label: `${dayLabelIso(d)} · ${dmy(d)}` }))}
        />
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={unchanged}
            onClick={() => onMove(date, target?.assignmentId ?? null)}
          >
            Переместить
          </Button>
        </div>
      </div>
    </Modal>
  );
}
