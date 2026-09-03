'use client';

// ============================================================
// Мобильный фолбэк (< 768px): дерево-список из тех же данных, что и канвас —
// разворачиваемые отделы → должности → держатели (PersonChip S), сверху блок
// «Мой руководитель» по «месту в структуре» текущего человека. Без
// перетаскивания; 375px без горизонтальной прокрутки.
// ============================================================

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ORG_MANAGER_REASON_LABELS, pluralRu, type OrgChartDepartmentDto, type OrgChartDto, type OrgChartPositionDto } from '@superapp/shared';
import { Button, Card, CardHeader, Chip, EmptyState, Glyph, Icon, LoadingBlock } from '@/components/ui';
import { dmy } from '@/lib/dates';
import { fetchOrgLine } from '@/lib/org-api';
import { orgLineKey } from '@/lib/queries';
import { PersonChip } from '@/app/circles/PersonCard';
import { isTopOfStructure } from './org-lib';

export function OrgTree({ workspaceId, chart, meId }: { workspaceId: string; chart: OrgChartDto; meId: string | null }) {
  const lineQ = useQuery({
    queryKey: orgLineKey(workspaceId, meId ?? ''),
    queryFn: () => fetchOrgLine(workspaceId, meId!),
    enabled: !!meId,
  });
  const line = lineQ.data;
  const byDept = useMemo(() => {
    const m = new Map<string | null, OrgChartPositionDto[]>();
    for (const p of chart.positions) m.set(p.departmentId, [...(m.get(p.departmentId) ?? []), p]);
    for (const list of m.values()) list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'ru'));
    return m;
  }, [chart.positions]);
  const children = useMemo(() => {
    const m = new Map<string | null, OrgChartDepartmentDto[]>();
    for (const d of chart.departments) m.set(d.parentId, [...(m.get(d.parentId) ?? []), d]);
    for (const list of m.values()) list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'ru'));
    return m;
  }, [chart.departments]);

  const noDept = byDept.get(null) ?? [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap-grid)' }}>
      {meId && (
        <Card small>
          <CardHeader title="Мой руководитель" />
          {lineQ.isPending ? (
            <LoadingBlock />
          ) : line ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {isTopOfStructure(line.manager, meId) ? (
                // Владелец — фолбэк вертикали, и сервер честно отдаёт его самого;
                // показывать человеку его же карточку как «моего руководителя» нельзя
                // (на десктопе стояла заглушка, здесь — нет, витрины расходились).
                <Chip tone="neutral" icon="crown">Вершина структуры — руководителя нет</Chip>
              ) : line.manager.userIds.length === 0 ? (
                <Chip tone="neutral">Руководитель не определён</Chip>
              ) : (
                <div className="otree-holders">
                  {line.manager.userIds.map((uid) => {
                    const p = line.people[uid];
                    return <PersonChip key={uid} size="S" userId={uid} firstName={p?.firstName ?? 'Без имени'} lastName={p?.lastName ?? null} avatar={p?.avatar ?? null} role={line.manager.positionName} />;
                  })}
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', alignItems: 'center' }}>
                {/* Подпись причины — факт, а не проблема: «подчиняется владельцу» для
                    небольшой организации норма, амбер тут учил видеть дефект. */}
                {!isTopOfStructure(line.manager, meId) && (
                  <Chip size="sm" tone="neutral">{ORG_MANAGER_REASON_LABELS[line.manager.reason]}</Chip>
                )}
                {line.manager.viaDeputy && <Chip size="sm" tone="warning">через замещение{line.manager.deputyUntil ? ` до ${dmy(line.manager.deputyUntil)}` : ''}</Chip>}
                {/* Переход — ссылка, а не чип: у чипа нет смысла действия (DESIGN.md) */}
                {line.team.count > 0 && (
                  <Button variant="ghost" size="sm" icon="people" href={`/workspaces/${workspaceId}/members/${meId}`}>
                    моя команда: {line.team.count}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <p className="label-sm" style={{ margin: 0 }}>Место в структуре не найдено.</p>
          )}
        </Card>
      )}

      <Card small>
        <CardHeader title="Структура" subtitle={`${chart.counts.positions} ${pluralRu(chart.counts.positions, ['должность', 'должности', 'должностей'])} · ${chart.counts.departments} ${pluralRu(chart.counts.departments, ['отдел', 'отдела', 'отделов'])}`} />
        {chart.positions.length === 0 && chart.departments.length === 0 ? (
          <EmptyState icon="department" title="Структура пока пустая" description="Отделы и должности добавляются на большом экране или в разделе «Люди»." />
        ) : (
          <div className="otree">
            {(children.get(null) ?? []).map((d) => (
              <DeptNode key={d.id} dept={d} chart={chart} byDept={byDept} children={children} level={0} />
            ))}
            {noDept.length > 0 && (
              <div className="otree-children" style={{ marginLeft: 0, paddingLeft: 0, borderLeft: 'none' }}>
                <div className="label-caps" style={{ padding: '0.5rem 0.25rem 0' }}>Без отдела</div>
                {noDept.map((p) => <PositionRow key={p.id} position={p} chart={chart} />)}
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function DeptNode({
  dept, chart, byDept, children, level,
}: {
  dept: OrgChartDepartmentDto; chart: OrgChartDto;
  byDept: Map<string | null, OrgChartPositionDto[]>; children: Map<string | null, OrgChartDepartmentDto[]>; level: number;
}) {
  const [open, setOpen] = useState(level === 0);
  const positions = byDept.get(dept.id) ?? [];
  const kids = children.get(dept.id) ?? [];
  const head = dept.headPositionId ? chart.positions.find((p) => p.id === dept.headPositionId) : null;
  return (
    <div>
      <button type="button" className="otree-dept" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? 'caretDown' : 'caretRight'} size={14} />
        <Icon name="department" size={16} />
        <span className="title-sm" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dept.name}</span>
        <span className="meta" title="Должностей в отделе">{positions.length} {pluralRu(positions.length, ['должность', 'должности', 'должностей'])}</span>
      </button>
      {open && (
        <div className="otree-children">
          {head && (
            <div className="otree-pos-row" style={{ padding: '0.25rem' }}>
              <Chip size="sm" tone="accent" icon="crown">Руководит: {head.name}</Chip>
            </div>
          )}
          {kids.map((k) => <DeptNode key={k.id} dept={k} chart={chart} byDept={byDept} children={children} level={level + 1} />)}
          {positions.map((p) => <PositionRow key={p.id} position={p} chart={chart} />)}
          {positions.length === 0 && kids.length === 0 && <p className="label-sm" style={{ margin: '0.25rem' }}>Должностей нет.</p>}
        </div>
      )}
    </div>
  );
}

function PositionRow({ position: p, chart }: { position: OrgChartPositionDto; chart: OrgChartDto }) {
  return (
    <div className="otree-pos">
      <div className="otree-pos-row">
        <Glyph value={p.glyph} fallback="position" size={16} />
        <span className="body-sm" style={{ fontWeight: 700, minWidth: 0 }}>{p.name}</span>
        {(p.headsDepartmentIds.length > 0 || p.headsBranchIds.length > 0) && <Chip size="sm" tone="accent" icon="crown">руководит</Chip>}
        {p.vacant && <Chip size="sm" tone="waiting">Вакансия</Chip>}
      </div>
      {p.holders.length > 0 && (
        <div className="otree-holders">
          {p.holders.map((h) => {
            const person = chart.people[h.userId];
            return <PersonChip key={h.assignmentId} size="S" userId={h.userId} firstName={person?.firstName ?? 'Без имени'} lastName={person?.lastName ?? null} avatar={person?.avatar ?? null} />;
          })}
        </div>
      )}
    </div>
  );
}
