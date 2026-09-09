'use client';

// ============================================================
// Мобильный фолбэк (< 768px): дерево-список из тех же данных, что и канвас —
// разворачиваемые отделы → должности → держатели (PersonChip S), сверху блок
// «Мой руководитель» по «месту в структуре» текущего человека. Без
// перетаскивания; 375px без горизонтальной прокрутки.
// ============================================================

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import type { OrgChartDepartmentDto, OrgChartDto, OrgChartPositionDto } from '@superapp/shared';
import { Button, Card, CardHeader, Chip, EmptyState, Glyph, Icon, LoadingBlock } from '@/components/ui';
import { dmy } from '@/lib/dates';
import { fetchOrgLine } from '@/lib/org-api';
import { orgLineKey } from '@/lib/queries';
import { PersonChip } from '@/app/circles/PersonCard';
import { isTopOfStructure } from './org-lib';

export function OrgTree({ workspaceId, chart, meId }: { workspaceId: string; chart: OrgChartDto; meId: string | null }) {
  const t = useTranslations('staff');
  const lineQ = useQuery({
    queryKey: orgLineKey(workspaceId, meId ?? ''),
    queryFn: () => fetchOrgLine(workspaceId, meId!),
    enabled: !!meId,
  });
  const line = lineQ.data;
  const byDept = useMemo(() => {
    const m = new Map<string | null, OrgChartPositionDto[]>();
    for (const p of chart.positions) m.set(p.departmentId, [...(m.get(p.departmentId) ?? []), p]);
    for (const list of m.values()) list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    return m;
  }, [chart.positions]);
  const children = useMemo(() => {
    const m = new Map<string | null, OrgChartDepartmentDto[]>();
    for (const d of chart.departments) m.set(d.parentId, [...(m.get(d.parentId) ?? []), d]);
    for (const list of m.values()) list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    return m;
  }, [chart.departments]);

  const noDept = byDept.get(null) ?? [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap-grid)' }}>
      {meId && (
        <Card small>
          <CardHeader title={t('card.myManager')} />
          {lineQ.isPending ? (
            <LoadingBlock />
          ) : line ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {isTopOfStructure(line.manager, meId) ? (
                // Владелец — фолбэк вертикали, и сервер честно отдаёт его самого;
                // показывать человеку его же карточку как «моего руководителя» нельзя
                // (на десктопе стояла заглушка, здесь — нет, витрины расходились).
                <Chip tone="neutral" icon="crown">{t('card.topOfStructure')}</Chip>
              ) : line.manager.userIds.length === 0 ? (
                <Chip tone="neutral">{t('org.tree.managerUnknown')}</Chip>
              ) : (
                <div className="otree-holders">
                  {line.manager.userIds.map((uid) => {
                    const p = line.people[uid];
                    return <PersonChip key={uid} size="S" userId={uid} firstName={p?.firstName ?? t('noName')} lastName={p?.lastName ?? null} avatar={p?.avatar ?? null} role={line.manager.positionName} />;
                  })}
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', alignItems: 'center' }}>
                {/* Подпись причины — факт, а не проблема: «подчиняется владельцу» для
                    небольшой организации норма, амбер тут учил видеть дефект. */}
                {!isTopOfStructure(line.manager, meId) && (
                  <Chip size="sm" tone="neutral">{t(`managerReason.${line.manager.reason}`)}</Chip>
                )}
                {line.manager.viaDeputy && (
                  <Chip size="sm" tone="warning">
                    {line.manager.deputyUntil
                      ? t('org.tree.viaDeputyUntil', { date: dmy(line.manager.deputyUntil) })
                      : t('org.tree.viaDeputy')}
                  </Chip>
                )}
                {/* Переход — ссылка, а не чип: у чипа нет смысла действия (DESIGN.md) */}
                {line.team.count > 0 && (
                  <Button variant="ghost" size="sm" icon="people" href={`/workspaces/${workspaceId}/members/${meId}`}>
                    {t('org.tree.myTeamLink', { n: line.team.count })}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <p className="label-sm" style={{ margin: 0 }}>{t('org.tree.placeNotFound')}</p>
          )}
        </Card>
      )}

      <Card small>
        <CardHeader
          title={t('org.tree.structure')}
          subtitle={`${t('positionsCount', { n: chart.counts.positions })} · ${t('departmentsCount', { n: chart.counts.departments })}`}
        />
        {chart.positions.length === 0 && chart.departments.length === 0 ? (
          <EmptyState icon="department" title={t('org.tree.emptyTitle')} description={t('org.tree.emptyHint')} />
        ) : (
          <div className="otree">
            {(children.get(null) ?? []).map((d) => (
              <DeptNode key={d.id} dept={d} chart={chart} byDept={byDept} children={children} level={0} />
            ))}
            {noDept.length > 0 && (
              <div className="otree-children" style={{ marginLeft: 0, paddingLeft: 0, borderLeft: 'none' }}>
                <div className="label-caps" style={{ padding: '0.5rem 0.25rem 0' }}>{t('org.tree.noDepartment')}</div>
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
  const t = useTranslations('staff');
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
        <span className="meta" title={t('org.tree.positionsInDepartment')}>{t('positionsCount', { n: positions.length })}</span>
      </button>
      {open && (
        <div className="otree-children">
          {head && (
            <div className="otree-pos-row" style={{ padding: '0.25rem' }}>
              <Chip size="sm" tone="accent" icon="crown">{t('org.leadsName', { name: head.name })}</Chip>
            </div>
          )}
          {kids.map((k) => <DeptNode key={k.id} dept={k} chart={chart} byDept={byDept} children={children} level={level + 1} />)}
          {positions.map((p) => <PositionRow key={p.id} position={p} chart={chart} />)}
          {positions.length === 0 && kids.length === 0 && <p className="label-sm" style={{ margin: '0.25rem' }}>{t('org.tree.noPositions')}</p>}
        </div>
      )}
    </div>
  );
}

function PositionRow({ position: p, chart }: { position: OrgChartPositionDto; chart: OrgChartDto }) {
  const t = useTranslations('staff');
  return (
    <div className="otree-pos">
      <div className="otree-pos-row">
        <Glyph value={p.glyph} fallback="position" size={16} />
        <span className="body-sm" style={{ fontWeight: 700, minWidth: 0 }}>{p.name}</span>
        {(p.headsDepartmentIds.length > 0 || p.headsBranchIds.length > 0) && <Chip size="sm" tone="accent" icon="crown">{t('org.leads')}</Chip>}
        {p.vacant && <Chip size="sm" tone="waiting">{t('org.vacancyChip')}</Chip>}
      </div>
      {p.holders.length > 0 && (
        <div className="otree-holders">
          {p.holders.map((h) => {
            const person = chart.people[h.userId];
            return <PersonChip key={h.assignmentId} size="S" userId={h.userId} firstName={person?.firstName ?? t('noName')} lastName={person?.lastName ?? null} avatar={person?.avatar ?? null} />;
          })}
        </div>
      )}
    </div>
  );
}
