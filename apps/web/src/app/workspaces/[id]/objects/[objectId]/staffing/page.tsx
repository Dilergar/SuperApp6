'use client';

// ============================================================
// Штатное расписание объекта: штатные единицы группами, под каждой — люди и
// вакансии. Строка-группа несёт то, что принадлежит ЕДИНИЦЕ (укомплектованность,
// плановая ставка, «Править» / «Убрать»), строки под ней — то, что принадлежит
// НАЗНАЧЕНИЮ (оформление, график, смены, оклады, «Ставки» / «Закрыть»). В одной
// плоской строке это смешивалось, и действия единицы приходилось вешать на
// «первую строку группы». Группы сворачиваются, строки фильтруются чипами,
// итоги — последней строкой таблицы.
//
// Денежные колонки рисуются по `caps.payrollView` из ОТВЕТА (сервер таких полей
// без права просто не отдаёт) — не по роли на клиенте.
//
// Период и «сегодня» считаются В ПОЯСЕ ОБЪЕКТА: `toISOString()` даёт UTC, и в
// ночь с последнего числа месяца раздел открывался на ПРОШЛОМ месяце.
// ============================================================

import { useMemo, useState, type ReactNode } from 'react';
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
  IconButton,
  LoadingBlock,
  Menu,
  Table,
  TableCell,
  TableGroupRow,
  TableHeader,
  TableRow,
  TickBar,
  useConfirm,
  type MenuAction,
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

/** «250 000 ₸ · мес.» — сумма и вид ставки одной строкой */
function rate(r: { amount: string; currency: string; rateType: string } | null | undefined): string | null {
  if (!r) return null;
  const short = RATE_SHORT.get(r.rateType as Parameters<typeof RATE_SHORT.get>[0]);
  return short ? `${money(r.amount, r.currency)} · ${short}` : money(r.amount, r.currency);
}

/** Сдвиг периода `YYYY-MM` — арифметика на строке, «сейчас» здесь ни при чём */
function shiftMonth(period: string, delta: number): string {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** 1 строка · 2 строки · 5 строк */
function rowsWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} строка`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} строки`;
  return `${n} строк`;
}

type RowFilter = 'all' | 'vacant' | 'unregistered';

const NOWRAP = { whiteSpace: 'nowrap' } as const;

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
  const [filter, setFilter] = useState<RowFilter>('all');
  // Свёрнутые позиции — состояние экрана, не настройка: при переходе раскрыто всё.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleUnit = (spId: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(spId)) next.delete(spId);
      else next.add(spId);
      return next;
    });

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
  const canManage = !!caps?.manage;

  // Колонки — про НАЗНАЧЕНИЕ; единица живёт в строке-группе на всю ширину.
  // Колонка действий есть только у того, кто может действовать: пустой трек
  // справа читался бы как недогруженная таблица.
  const columns: TableColumn[] = useMemo(() => {
    const base: TableColumn[] = [{ key: 'who', label: 'Кто', width: 'minmax(250px,1fr)' }];
    if (showMoney) base.push({ key: 'employment', label: 'Как оформлен', width: 'max-content', hideOnMobile: true });
    base.push(
      { key: 'schedule', label: 'График', width: 'max-content', hideOnMobile: true },
      { key: 'shifts', label: 'Смены', title: 'Запланировано / отработано за период', width: 'max-content', align: 'end', hideOnMobile: true },
    );
    if (showMoney) {
      base.push(
        { key: 'official', label: 'Оклад офиц.', width: 'max-content', align: 'end', hideOnMobile: true },
        { key: 'actual', label: 'Оклад факт.', width: 'max-content', align: 'end', hideOnMobile: true },
      );
    }
    if (canManage) base.push({ key: 'actions', label: '', width: 'max-content', align: 'end' });
    return base;
  }, [showMoney, canManage]);

  // На 375 px переключатель месяца и «+ Позиция» едут ПОД шапку (иначе заголовок
  // сжимается в столбик из отдельных букв).
  const periodControls = (
    <>
      <Button size="sm" variant="ghost" icon="arrowLeft" aria-label="Предыдущий месяц" onClick={() => setPickedPeriod(shiftMonth(period, -1))} />
      <Chip tone="neutral">{monthLabel(period)}</Chip>
      <Button size="sm" variant="ghost" icon="arrowRight" aria-label="Следующий месяц" onClick={() => setPickedPeriod(shiftMonth(period, 1))} />
      {canManage && (
        <Button size="sm" variant="outline" icon="add" onClick={() => setAddingUnit(true)}>
          Позиция
        </Button>
      )}
    </>
  );

  if (!isReady) return null;

  const rows = data?.rows ?? [];

  // Фильтр «Не оформлены» опирается на `employment`, которого без права на деньги
  // в ответе нет вовсе, — без права чип не показываем, а не показываем пустой список.
  const vacantCount = rows.filter((r) => !r.assignment).length;
  const unregisteredCount = showMoney ? rows.filter((r) => r.assignment?.active && !r.employment).length : 0;
  const matches = (row: StaffingRowDto): boolean =>
    filter === 'all' ? true : filter === 'vacant' ? !row.assignment : !!row.assignment?.active && !row.employment;

  // Итоги считаются из строк и видны всем; деньги — из totals, только по праву.
  // Строки одной единицы повторяют её headcount — складываем по единицам, не по строкам.
  const seenUnits = new Set<string>();
  let totalHeadcount = 0;
  for (const r of rows) {
    if (seenUnits.has(r.staffingPositionId)) continue;
    seenUnits.add(r.staffingPositionId);
    totalHeadcount += r.headcount;
  }
  const totalFilled = rows.filter((r) => r.assignment?.active).length;

  // Строки ОДНОЙ штатной единицы приходят подряд: перед первой — строка-группа.
  const body: ReactNode[] = [];
  let rowIndex = 1; // шапка = 1
  let shownUnits = 0;
  rows.forEach((row, i) => {
    const firstOfUnit = i === 0 || rows[i - 1].staffingPositionId !== row.staffingPositionId;
    const isCollapsed = collapsed.has(row.staffingPositionId);
    if (firstOfUnit) {
      const unitRows = rows.filter((r) => r.staffingPositionId === row.staffingPositionId && matches(r));
      if (unitRows.length === 0) return;
      shownUnits += 1;
      rowIndex += 1;
      body.push(
        <TableGroupRow
          key={`unit-${row.staffingPositionId}`}
          rowIndex={rowIndex}
          expanded={!isCollapsed}
          onToggle={() => toggleUnit(row.staffingPositionId)}
          toggleLabel={`«${row.positionName}»`}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
            {row.glyph && <Glyph value={row.glyph} size={18} />}
            <span style={{ fontWeight: 700, fontSize: '0.875rem', ...NOWRAP }}>{row.positionName}</span>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }} title="Занято ставок из числа по штату">
            <TickBar
              value={row.headcount ? (row.filled / row.headcount) * 100 : 0}
              tone={row.filled >= row.headcount ? 'success' : 'warning'}
              height={6}
              style={{ width: 96 }}
              aria-label={`Укомплектованность: ${row.filled} из ${row.headcount}`}
            />
            <span className="label-sm" style={NOWRAP}>{`${row.filled} / ${row.headcount}`}</span>
          </span>
          {showMoney && row.plannedRate && (
            <span className="label-sm" style={NOWRAP}>{`план ${rate(row.plannedRate)}`}</span>
          )}
          {isCollapsed && <span className="label-sm" style={NOWRAP}>{rowsWord(unitRows.length)}</span>}
          {row.note && (
            <span
              className="label-sm"
              title={row.note}
              style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', ...NOWRAP }}
            >
              {row.note}
            </span>
          )}
          {canManage && (
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
              <Button size="sm" variant="ghost" onClick={() => setEditingUnit(row)}>
                Править
              </Button>
              <RowMenu
                label={`Действия с позицией «${row.positionName}»`}
                items={[
                  {
                    key: 'remove',
                    label: 'Убрать позицию из штатки',
                    icon: 'delete',
                    danger: true,
                    onClick: () =>
                      confirm(
                        {
                          title: 'Убрать позицию из штатки?',
                          message: `«${row.positionName}» перестанет учитываться в плане затрат.`,
                          confirmLabel: 'Убрать',
                          danger: true,
                        },
                        () => removeUnit.mutateAsync(row.staffingPositionId).then(() => undefined),
                      ),
                  },
                ]}
              />
            </span>
          )}
        </TableGroupRow>,
      );
    }
    if (isCollapsed || !matches(row)) return;

    rowIndex += 1;
    const a = row.assignment;
    const closed = !!a && !a.active;
    const shifts = row.shifts;
    const shiftsText = a
      ? `${shifts.planned} / ${shifts.worked + shifts.late}${shifts.absent > 0 ? ` · ${shifts.absent} невыход` : ''}`
      : '—';

    body.push(
      <TableRow
        key={`${row.staffingPositionId}:${a?.id ?? `vac-${i}`}`}
        rowIndex={rowIndex}
        style={closed ? { opacity: 0.6 } : undefined}
      >
        <TableCell>
          {a ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', ...NOWRAP }}>
              <PersonChip size="S" userId={a.userId} firstName={a.userName} />
              {/* Закрытое назначение выглядело работающим — теперь у него свой чип */}
              {closed && <Chip tone="neutral">{a.endsOn ? `до ${dm(a.endsOn)}` : 'не действует'}</Chip>}
            </span>
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
              <Chip tone="neutral">Вакантно</Chip>
              {row.vacantSince && <span className="label-sm" style={NOWRAP}>{`с ${dm(row.vacantSince)}`}</span>}
            </span>
          )}
        </TableCell>
        {showMoney && (
          <TableCell hideOnMobile>{a ? <EmploymentChip row={row} /> : <span className="label-sm">—</span>}</TableCell>
        )}
        <TableCell hideOnMobile>
          <span className="label-sm">{row.schedule?.label ?? '—'}</span>
        </TableCell>
        <TableCell align="end" hideOnMobile title="Смены за период: запланировано / отработано">
          <span className="label-sm">{shiftsText}</span>
        </TableCell>
        {showMoney && (
          <>
            <TableCell align="end" hideOnMobile>
              <span className="label-sm">{a ? money(row.officialSalary?.amount, row.officialSalary?.currency) : '—'}</span>
            </TableCell>
            <TableCell align="end" hideOnMobile>
              <span className="label-sm">
                {a
                  ? (rate(row.actualRate) ?? '—')
                  : row.plannedRate
                    ? `${money(row.plannedRate.amount, row.plannedRate.currency)} · план`
                    : '—'}
              </span>
            </TableCell>
          </>
        )}
        {canManage && (
          <TableCell align="end">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
              {a ? (
                <>
                  {/* Кнопка нужна и БЕЗ права на деньги: за ней живут даты
                      назначения, а ошибочно закрытое назначение чинится только
                      там. Ставки внутри всё равно скрыты сервером. */}
                  <Button size="sm" variant="ghost" onClick={() => setRatesFor(row)}>
                    {showMoney ? 'Ставки' : 'Период'}
                  </Button>
                  {!closed && (
                    <RowMenu
                      label={`Действия с назначением: ${a.userName}`}
                      items={[
                        {
                          key: 'close',
                          label: 'Закрыть назначение',
                          icon: 'close',
                          onClick: () =>
                            confirm(
                              {
                                title: 'Закрыть назначение?',
                                message: `${a.userName} перестанет числиться на позиции «${row.positionName}» с сегодняшнего дня. История сохранится.`,
                                confirmLabel: 'Закрыть',
                              },
                              () => closeAssignment.mutateAsync(a.id).then(() => undefined),
                            ),
                        },
                      ]}
                    />
                  )}
                </>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setAssignFor(row)}>
                  Назначить
                </Button>
              )}
            </span>
          </TableCell>
        )}
      </TableRow>,
    );
  });

  if (rows.length > 0 && shownUnits === 0) {
    rowIndex += 1;
    body.push(
      <TableGroupRow key="empty-filter" rowIndex={rowIndex}>
        <span className="label-sm">По этому фильтру строк нет</span>
      </TableGroupRow>,
    );
  }

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
              canManage ? (
                <Button variant="primary" icon="add" onClick={() => setAddingUnit(true)}>
                  Добавить позицию
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: 'var(--spacing-3)' }}>
              <Chip tone="accent" selected={filter === 'all'} onClick={() => setFilter('all')}>
                Все
              </Chip>
              <Chip tone="accent" selected={filter === 'vacant'} onClick={() => setFilter('vacant')}>
                {`Вакансии · ${vacantCount}`}
              </Chip>
              {showMoney && (
                <Chip tone="accent" selected={filter === 'unregistered'} onClick={() => setFilter('unregistered')}>
                  {`Не оформлены · ${unregisteredCount}`}
                </Chip>
              )}
            </div>
            {/* Широкая таблица прокручивается ВНУТРИ своего контейнера: на 375 px
                колонка «Кто» и действия не помещаются, а горизонтальный скролл
                страницы целиком — запрещённая конвенцией «дырка». */}
            <div style={{ overflowX: 'auto' }}>
              <Table columns={columns} lines className="density-compact" aria-rowcount={rowIndex + 1} style={{ minWidth: 420 }}>
                <TableHeader />
                {body}
                <TableRow footer rowIndex={rowIndex + 1}>
                  <TableCell>{`Итого · по штату ${totalHeadcount} · занято ${totalFilled}`}</TableCell>
                  {showMoney && <TableCell hideOnMobile />}
                  <TableCell hideOnMobile />
                  <TableCell align="end" hideOnMobile />
                  {showMoney && (
                    <>
                      <TableCell align="end" hideOnMobile />
                      <TableCell align="end" hideOnMobile>
                        {data?.totals ? `план затрат ${money(data.totals.plannedCost, data.totals.currency)}` : null}
                      </TableCell>
                    </>
                  )}
                  {canManage && <TableCell align="end" />}
                </TableRow>
              </Table>
            </div>
          </>
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

/** «Три точки» в строке таблицы: под рост sm-кнопки, чтобы ряд действий был ровным */
function RowMenu({ items, label }: { items: MenuAction[]; label: string }) {
  return (
    <Menu
      items={items}
      label={label}
      trigger={(p) => <IconButton {...p} icon="more" label={label} size={32} round={false} variant="outline" />}
    />
  );
}

function EmploymentChip({ row }: { row: StaffingRowDto }) {
  const e = row.employment;
  if (!e) return <Chip tone="warning">Не оформлен</Chip>;
  if (e.status === 'draft') return <Chip tone="neutral">Черновик</Chip>;
  if (e.status === 'terminated') return <Chip tone="danger">Уволен</Chip>;
  return <Chip tone="success">{e.legalEntityName ? `Оформлен · ${e.legalEntityName}` : 'Оформлен'}</Chip>;
}
