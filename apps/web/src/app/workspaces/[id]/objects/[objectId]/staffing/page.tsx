'use client';

// ============================================================
// Штатное расписание объекта: единицы, люди и вакансии одной таблицей.
// Денежные колонки рисуются по `caps.payrollView` из ОТВЕТА (сервер таких полей
// без права просто не отдаёт) — не по роли на клиенте.
//
// Период и «сегодня» считаются В ПОЯСЕ ОБЪЕКТА: `toISOString()` даёт UTC, и в
// ночь с последнего числа месяца раздел открывался на ПРОШЛОМ месяце.
// ============================================================

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RATE_TYPES, type StaffingRowDto } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  Glyph,
  LoadingBlock,
  TableCell,
  TableHeader,
  TableRow,
  TickBar,
  useConfirm,
  type TableColumn,
} from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { dm } from '@/lib/dates';
import { FALLBACK_TZ, monthIn, monthLabel, todayIn } from '@/lib/objects-time';
import { objectKey, objectStaffingKey } from '@/lib/queries';
import { fetchObject, fetchStaffing, staffingApi } from '../../objects-api';
import { AssignPanel } from '../../_components/AssignPanel';
import { UnitForm } from '../../_components/UnitForm';
import { RateHistory } from '../../_components/RateHistory';

const RATE_SHORT = new Map(RATE_TYPES.map((r) => [r.value, r.short]));

function money(amount: string | null | undefined, currency = 'KZT'): string {
  if (!amount) return '—';
  const n = Number(amount) / 100;
  return `${n.toLocaleString('ru-RU')} ${currency === 'KZT' ? '₸' : currency}`;
}

/** Сдвиг периода `YYYY-MM` — арифметика на строке, «сейчас» здесь ни при чём */
function shiftMonth(period: string, delta: number): string {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

export default function StaffingPage() {
  const { isReady } = useRequireAuth();
  const isMobile = useIsMobile();
  const { id, objectId } = useParams<{ id: string; objectId: string }>();
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();

  // Пояс объекта нужен раньше данных штатки (от него зависит текущий период).
  // Карточку уже загрузил layout — это попадание в кэш, а не второй запрос.
  const { data: object } = useQuery({
    queryKey: objectKey(id, objectId),
    queryFn: () => fetchObject(id, objectId),
    enabled: isReady && !!objectId,
  });
  const timeZone = object?.timeZone ?? FALLBACK_TZ;

  // null = «текущий месяц»: пересчитается, как только приедет пояс объекта.
  const [pickedPeriod, setPickedPeriod] = useState<string | null>(null);
  const period = pickedPeriod ?? monthIn(timeZone);

  const [assignFor, setAssignFor] = useState<StaffingRowDto | null>(null);
  const [addingUnit, setAddingUnit] = useState(false);
  const [editingUnit, setEditingUnit] = useState<StaffingRowDto | null>(null);
  const [ratesFor, setRatesFor] = useState<StaffingRowDto | null>(null);

  const { data, isPending } = useQuery({
    queryKey: objectStaffingKey(id, objectId, period),
    queryFn: () => fetchStaffing(id, objectId, period),
    enabled: isReady && !!objectId && !!object,
  });

  // Префикс ключа штатки (ключ — из lib/queries.ts): правка задевает все периоды,
  // а не только открытый — ставки и назначения версионируются по датам.
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: objectStaffingKey(id, objectId, '').slice(0, -1) });
  };

  const closeAssignment = useMutation({
    mutationFn: (aId: string) => staffingApi.closeAssignment(id, aId, todayIn(timeZone)),
    onSuccess: invalidate,
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const removeUnit = useMutation({
    mutationFn: (spId: string) => staffingApi.removeUnit(id, spId),
    onSuccess: invalidate,
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const caps = data?.caps;
  const showMoney = !!caps?.payrollView;

  const columns: TableColumn[] = useMemo(() => {
    const base: TableColumn[] = [
      { key: 'position', label: 'Позиция', width: 'minmax(160px,1.4fr)' },
      { key: 'headcount', label: 'По штату', width: 'minmax(110px,0.8fr)' },
      { key: 'who', label: 'Кто', width: 'minmax(180px,1.4fr)' },
    ];
    if (showMoney) {
      base.push({ key: 'employment', label: 'Как оформлен', width: 'auto', hideOnMobile: true });
    }
    base.push(
      { key: 'schedule', label: 'График', width: 'auto', hideOnMobile: true },
      { key: 'shifts', label: 'Смены', width: 'auto', hideOnMobile: true },
    );
    if (showMoney) {
      base.push(
        { key: 'official', label: 'Оклад офиц.', width: 'auto', align: 'end', hideOnMobile: true },
        { key: 'actual', label: 'Оклад факт.', width: 'auto', align: 'end', hideOnMobile: true },
      );
    }
    base.push({ key: 'actions', label: '', width: 'auto', align: 'end' });
    return base;
  }, [showMoney]);

  // На 375 px переключатель месяца и «+ Позиция» едут ПОД шапку (иначе заголовок
  // сжимается в столбик из отдельных букв).
  const periodControls = (
    <>
      <Button size="sm" variant="ghost" icon="arrowLeft" aria-label="Предыдущий месяц" onClick={() => setPickedPeriod(shiftMonth(period, -1))} />
      <Chip tone="neutral">{monthLabel(period)}</Chip>
      <Button size="sm" variant="ghost" icon="arrowRight" aria-label="Следующий месяц" onClick={() => setPickedPeriod(shiftMonth(period, 1))} />
      {caps?.manage && (
        <Button size="sm" variant="outline" icon="add" onClick={() => setAddingUnit(true)}>
          Позиция
        </Button>
      )}
    </>
  );

  if (!isReady) return null;

  const rows = data?.rows ?? [];

  return (
    <>
      <Card>
        <CardHeader
          title="Штатное расписание"
          subtitle="Должности объекта, люди и вакансии. Ставки версионируются по датам"
          actions={isMobile ? undefined : periodControls}
        />
        {isMobile && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: 'var(--spacing-4)', alignItems: 'center' }}>
            {periodControls}
          </div>
        )}

        {isPending ? (
          <LoadingBlock />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="staff"
            title="Штат пока не расписан"
            description="Добавьте позицию — «по штату 3 бариста». Вакансии сразу попадут в план затрат."
            action={
              caps?.manage ? (
                <Button variant="primary" icon="add" onClick={() => setAddingUnit(true)}>
                  Добавить позицию
                </Button>
              ) : undefined
            }
          />
        ) : (
          /* Широкая таблица прокручивается ВНУТРИ своего контейнера: на 375 px три
             обязательные колонки не помещаются, а горизонтальный скролл страницы
             целиком — запрещённая конвенцией «дырка». */
          <div style={{ overflowX: 'auto' }}>
            <div role="table" className="density-compact" style={{ minWidth: 420 }}>
              <TableHeader columns={columns} />
            {rows.map((row, i) => {
              // Строки ОДНОЙ штатной единицы идут подряд. Действия самой единицы
              // («Править» / «Убрать») живут в её ПЕРВОЙ строке: раньше они были
              // только в строке-вакансии, и полностью укомплектованную позицию
              // нельзя было ни изменить, ни убрать.
              const firstOfUnit = i === 0 || rows[i - 1].staffingPositionId !== row.staffingPositionId;
              const closed = !!row.assignment && !row.assignment.active;
              return (
              <TableRow
                key={`${row.staffingPositionId}:${row.assignment?.id ?? `vac-${i}`}`}
                columns={columns}
                rowIndex={i + 1}
                style={closed ? { opacity: 0.6 } : undefined}
              >
                <TableCell>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                    {row.glyph && <Glyph value={row.glyph} size={16} />}
                    <span style={{ fontWeight: 600 }}>{row.positionName}</span>
                  </span>
                </TableCell>
                <TableCell>
                  <span style={{ display: 'block' }}>
                    <span className="label-sm">{`${row.filled} / ${row.headcount}`}</span>
                    <TickBar
                      value={row.headcount ? (row.filled / row.headcount) * 100 : 0}
                      tone={row.filled >= row.headcount ? 'success' : 'warning'}
                      height={6}
                    />
                  </span>
                </TableCell>
                <TableCell>
                  {row.assignment ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <PersonChip size="S" userId={row.assignment.userId} firstName={row.assignment.userName} />
                      {/* Закрытое назначение выглядело работающим — теперь у него свой чип */}
                      {closed && (
                        <Chip tone="neutral">
                          {row.assignment.endsOn ? `до ${dm(row.assignment.endsOn)}` : 'не действует'}
                        </Chip>
                      )}
                    </span>
                  ) : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <Chip tone="neutral">Вакантно</Chip>
                      {caps?.manage && (
                        <Button size="sm" variant="ghost" onClick={() => setAssignFor(row)}>
                          Назначить
                        </Button>
                      )}
                    </span>
                  )}
                </TableCell>
                {showMoney && (
                  <TableCell hideOnMobile>
                    {row.assignment ? <EmploymentChip row={row} /> : <span className="label-sm">—</span>}
                  </TableCell>
                )}
                <TableCell hideOnMobile>
                  <span className="label-sm">{row.schedule?.label ?? '—'}</span>
                </TableCell>
                <TableCell hideOnMobile>
                  <span className="label-sm">
                    {`${row.shifts.planned} / ${row.shifts.worked + row.shifts.late}`}
                    {row.shifts.absent > 0 && ` · ${row.shifts.absent} невыход`}
                  </span>
                </TableCell>
                {showMoney && (
                  <>
                    <TableCell align="end" hideOnMobile>
                      <span className="label-sm">{money(row.officialSalary?.amount, row.officialSalary?.currency)}</span>
                    </TableCell>
                    <TableCell align="end" hideOnMobile>
                      <span className="label-sm">
                        {row.actualRate
                          ? `${money(row.actualRate.amount, row.actualRate.currency)} · ${RATE_SHORT.get(row.actualRate.rateType) ?? ''}`
                          : row.plannedRate
                            ? `${money(row.plannedRate.amount, row.plannedRate.currency)} · план`
                            : '—'}
                      </span>
                    </TableCell>
                  </>
                )}
                <TableCell align="end">
                  {caps?.manage && (
                    <span style={{ display: 'inline-flex', gap: '0.25rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {/* Кнопка нужна и БЕЗ права на деньги: за ней живут даты
                          назначения, а ошибочно закрытое назначение чинится только
                          там. Ставки внутри всё равно скрыты сервером. */}
                      {row.assignment && (
                        <Button size="sm" variant="ghost" onClick={() => setRatesFor(row)}>
                          {showMoney ? 'Ставки' : 'Период'}
                        </Button>
                      )}
                      {row.assignment && !closed && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            confirm(
                              {
                                title: 'Закрыть назначение?',
                                message: `${row.assignment!.userName} перестанет числиться на позиции «${row.positionName}» с сегодняшнего дня. История сохранится.`,
                                confirmLabel: 'Закрыть',
                              },
                              () => closeAssignment.mutateAsync(row.assignment!.id).then(() => undefined),
                            )
                          }
                        >
                          Закрыть
                        </Button>
                      )}
                      {firstOfUnit && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => setEditingUnit(row)}>
                            Править
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            tone="danger"
                            onClick={() =>
                              confirm(
                                {
                                  title: 'Убрать позицию из штатки?',
                                  message: `«${row.positionName}» перестанет учитываться в плане затрат.`,
                                  confirmLabel: 'Убрать',
                                  danger: true,
                                },
                                () => removeUnit.mutateAsync(row.staffingPositionId).then(() => undefined),
                              )
                            }
                          >
                            Убрать
                          </Button>
                        </>
                      )}
                    </span>
                  )}
                </TableCell>
              </TableRow>
              );
            })}
            </div>
          </div>
        )}

        {showMoney && data?.totals && (
          <div style={{ marginTop: 'var(--spacing-4)', display: 'flex', gap: 'var(--spacing-4)', flexWrap: 'wrap' }}>
            <Chip tone="accent">{`План затрат: ${money(data.totals.plannedCost, data.totals.currency)}`}</Chip>
            <Chip tone="neutral">{`По штату: ${data.totals.headcount}`}</Chip>
            <Chip tone="neutral">{`Занято: ${data.totals.filled}`}</Chip>
          </div>
        )}
      </Card>

      {addingUnit && (
        <UnitForm
          workspaceId={id}
          objectId={objectId}
          open
          onClose={() => setAddingUnit(false)}
          onSaved={invalidate}
        />
      )}
      {editingUnit && (
        <UnitForm
          key={editingUnit.staffingPositionId}
          workspaceId={id}
          objectId={objectId}
          open
          unit={{
            staffingPositionId: editingUnit.staffingPositionId,
            positionName: editingUnit.positionName,
            headcount: editingUnit.headcount,
            plannedRate: editingUnit.plannedRate ?? null,
          }}
          onClose={() => setEditingUnit(null)}
          onSaved={invalidate}
        />
      )}
      {assignFor && (
        <AssignPanel
          workspaceId={id}
          objectId={objectId}
          row={assignFor}
          timeZone={timeZone}
          open
          onClose={() => setAssignFor(null)}
          onSaved={invalidate}
        />
      )}
      {ratesFor?.assignment && (
        <RateHistory
          workspaceId={id}
          assignmentId={ratesFor.assignment.id}
          userName={ratesFor.assignment.userName}
          userId={ratesFor.assignment.userId}
          timeZone={timeZone}
          showMoney={showMoney}
          assignment={{
            startsOn: ratesFor.assignment.startsOn,
            endsOn: ratesFor.assignment.endsOn,
            rateShare: ratesFor.assignment.rateShare,
          }}
          open
          onClose={() => setRatesFor(null)}
          onSaved={invalidate}
        />
      )}
      {confirmUI}
    </>
  );
}

function EmploymentChip({ row }: { row: StaffingRowDto }) {
  const e = row.employment;
  if (!e) return <Chip tone="warning">Не оформлен</Chip>;
  if (e.status === 'draft') return <Chip tone="neutral">Черновик</Chip>;
  if (e.status === 'terminated') return <Chip tone="danger">Уволен</Chip>;
  return <Chip tone="success">{e.legalEntityName ? `Оформлен · ${e.legalEntityName}` : 'Оформлен'}</Chip>;
}
