'use client';

// ============================================================
// Мастер «Соберём структуру» — три шага в модалке кита:
//  1. Кто во главе? — существующая должность или новая + держатель (предзаполнен
//     директор из реквизитов организации);
//  2. Кто руководит каждым отделом и объектом? — один экран списком;
//  3. Готово — сводка → POST /org/setup.
// ============================================================

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { OrgChartDto, OrgSetupInput } from '@superapp/shared';
import { Button, Chip, Divider, Icon, Input, Modal, SegmentedControl } from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import type { Principal } from '@/lib/entities';
import { runOrgSetup, setBranchHead, setDepartmentHead } from '@/lib/org-api';
import { PersonChip } from '@/app/circles/PersonCard';
import { showApiError, useOrgRefresh } from './org-lib';

type Step = 1 | 2 | 3;

/**
 * Синтетический id «вершины» в пикерах шага 2, пока новая должность ещё не создана.
 * Сервер /org/setup вершину к объектам не привязывает — без этого «во главе» ничего
 * не подчинялось бы; клиент после setup ставит голову объекта/отдела сам.
 */
const TOP_ID = '__top__';

export function OrgWizard({ workspaceId, chart, open, onClose }: { workspaceId: string; chart: OrgChartDto; open: boolean; onClose: () => void }) {
  const refresh = useOrgRefresh(workspaceId);
  const [step, setStep] = useState<Step>(1);
  const [topMode, setTopMode] = useState<'existing' | 'new'>(chart.positions.length ? 'existing' : 'new');
  const [topPos, setTopPos] = useState<Principal[]>([]);
  const [topName, setTopName] = useState('');
  const [topUser, setTopUser] = useState<Principal[]>(chart.suggestedTopUserId ? [{ type: 'user', id: chart.suggestedTopUserId }] : []);
  const [deptHeads, setDeptHeads] = useState<Record<string, Principal[]>>(() =>
    Object.fromEntries(chart.departments.map((d) => [d.id, d.headPositionId ? [{ type: 'position', id: d.headPositionId }] : []])),
  );
  const [branchHeads, setBranchHeads] = useState<Record<string, Principal[]>>(() =>
    Object.fromEntries(chart.branches.map((b) => [b.id, b.headPositionId ? [{ type: 'position', id: b.headPositionId }] : []])),
  );

  const topOk = topMode === 'existing' ? topPos.length > 0 : topName.trim().length > 0;
  const topId = topMode === 'existing' ? topPos[0]?.id ?? null : topName.trim() ? TOP_ID : null;
  const positionOptions = useMemo(() => chart.positions.map((x) => ({ type: 'position', id: x.id, title: x.name, icon: x.glyph })), [chart.positions]);
  const headOptions = useMemo(
    () => (topMode === 'new' && topName.trim() ? [{ type: 'position', id: TOP_ID, title: `${topName.trim()} (вершина, новая)`, icon: 'crown' }, ...positionOptions] : positionOptions),
    [positionOptions, topMode, topName],
  );
  const posName = (id: string | undefined) => (id === TOP_ID ? topName.trim() : id ? chart.positions.find((p) => p.id === id)?.name ?? '' : '');
  const topLabel = topMode === 'existing' ? posName(topPos[0]?.id) : topName.trim();
  const topPerson = topUser[0] ? chart.people[topUser[0].id] : undefined;

  // Шаг 2: основному объекту без головы подставляется вершина — так к ней сходятся
  // должности без отдела и отделы без своей головы.
  const goStep2 = () => {
    const def = chart.branches.find((b) => b.isDefault);
    if (def && topId && !(branchHeads[def.id]?.length)) setBranchHeads((s) => ({ ...s, [def.id]: [{ type: 'position', id: topId }] }));
    setStep(2);
  };

  const run = useMutation({
    mutationFn: async () => {
      const deptChanges = chart.departments
        .filter((d) => (deptHeads[d.id]?.[0]?.id ?? null) !== d.headPositionId)
        .map((d) => ({ departmentId: d.id, positionId: deptHeads[d.id]?.[0]?.id ?? null }));
      const branchChanges = chart.branches
        .filter((b) => (branchHeads[b.id]?.[0]?.id ?? null) !== b.headPositionId)
        .map((b) => ({ branchId: b.id, positionId: branchHeads[b.id]?.[0]?.id ?? null }));
      const dto: OrgSetupInput = {
        top: topMode === 'existing' ? { positionId: topPos[0].id, userId: topUser[0]?.id ?? null } : { newPositionName: topName.trim(), userId: topUser[0]?.id ?? null },
        departmentHeads: deptChanges.filter((h) => h.positionId !== TOP_ID),
        branchHeads: branchChanges.filter((h) => h.positionId !== TOP_ID),
      };
      const res = await runOrgSetup(workspaceId, dto);
      // Головы «= вершина» для НОВОЙ должности — вторым шагом, когда id уже известен
      if (res.topPositionId) {
        for (const h of deptChanges) if (h.positionId === TOP_ID) await setDepartmentHead(workspaceId, h.departmentId, res.topPositionId);
        for (const h of branchChanges) if (h.positionId === TOP_ID) await setBranchHead(workspaceId, h.branchId, res.topPositionId);
      }
      return res;
    },
    onSuccess: () => { refresh(); onClose(); },
    onError: showApiError,
  });

  const footer =
    step === 1 ? (
      <>
        <Button variant="ghost" onClick={onClose}>Позже</Button>
        <Button variant="primary" iconRight="arrowRight" disabled={!topOk} onClick={goStep2}>Дальше</Button>
      </>
    ) : step === 2 ? (
      <>
        <Button variant="ghost" icon="arrowLeft" onClick={() => setStep(1)}>Назад</Button>
        <Button variant="primary" iconRight="arrowRight" onClick={() => setStep(3)}>Дальше</Button>
      </>
    ) : (
      <>
        <Button variant="ghost" icon="arrowLeft" onClick={() => setStep(2)}>Назад</Button>
        <Button variant="primary" tone="success" icon="check" loading={run.isPending} onClick={() => run.mutate()}>Собрать структуру</Button>
      </>
    );

  return (
    <Modal open={open} onClose={onClose} title="Соберём структуру" subtitle={`Шаг ${step} из 3`} size="lg" footer={footer}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
        <SegmentedControl
          aria-label="Шаги мастера"
          value={String(step)}
          onChange={(k) => { const n = Number(k) as Step; if (n < step) setStep(n); else if (n === 2 && topOk) goStep2(); else if (n === 3 && topOk) setStep(3); }}
          items={[{ key: '1', label: 'Кто во главе', icon: 'crown' }, { key: '2', label: 'Отделы и объекты', icon: 'department' }, { key: '3', label: 'Готово', icon: 'check' }]}
        />

        {step === 1 && (
          <>
            <p className="body-sm" style={{ margin: 0 }}>
              Вершина схемы — должность, к которой сходится подчинение (директор, управляющий). Ей же подчинятся отделы без своей головы.
            </p>
            <SegmentedControl
              aria-label="Вершина"
              value={topMode}
              onChange={setTopMode}
              items={[{ key: 'existing', label: 'Существующая должность', disabled: !chart.positions.length }, { key: 'new', label: 'Новая должность' }]}
            />
            {topMode === 'existing' ? (
              <div>
                <div className="ui-field-label label-caps" style={{ marginBottom: '0.375rem' }}>Должность во главе</div>
                <EntitySelector value={topPos} onChange={setTopPos} types={['position']} multi={false} options={positionOptions} placeholder="Например, Директор" context={{ workspaceId }} />
              </div>
            ) : (
              <Input label="Название новой должности" value={topName} onChange={(e) => setTopName(e.target.value)} placeholder="Директор" maxLength={100} required />
            )}
            <div>
              <div className="ui-field-label label-caps" style={{ marginBottom: '0.375rem' }}>Кто её держит (необязательно)</div>
              <EntitySelector value={topUser} onChange={setTopUser} types={['user']} multi={false} placeholder="Человек из команды" context={{ workspaceId }} />
              {chart.suggestedTopUserId && topUser[0]?.id === chart.suggestedTopUserId && (
                <p className="label-sm" style={{ margin: '0.375rem 0 0' }}>Подставлен директор из реквизитов организации.</p>
              )}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <p className="body-sm" style={{ margin: 0 }}>
              Руководитель отдела или объекта — это ДОЛЖНОСТЬ: она может лежать вне отдела и вести сразу несколько. Пустое поле — руководит вершина.
            </p>
            {chart.departments.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                <span className="label-caps">Отделы · {chart.departments.length}</span>
                {chart.departments.map((d) => (
                  <div key={d.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) 2fr', gap: '0.5rem', alignItems: 'center' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', paddingLeft: `${d.depth * 0.75}rem`, minWidth: 0 }}>
                      <Icon name="department" size={15} />
                      <span className="title-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                    </span>
                    <EntitySelector
                      value={deptHeads[d.id] ?? []}
                      onChange={(v) => setDeptHeads((s) => ({ ...s, [d.id]: v }))}
                      types={['position']}
                      multi={false}
                      options={headOptions}
                      placeholder="Кто руководит…"
                      context={{ workspaceId }}
                    />
                  </div>
                ))}
              </div>
            )}
            {chart.branches.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                <span className="label-caps">Объекты · {chart.branches.length}</span>
                {chart.branches.map((b) => (
                  <div key={b.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) 2fr', gap: '0.5rem', alignItems: 'center' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', minWidth: 0 }}>
                      <Icon name="branch" size={15} />
                      <span className="title-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span>
                      {b.isDefault && <Chip size="sm" tone="neutral">основной</Chip>}
                    </span>
                    <EntitySelector
                      value={branchHeads[b.id] ?? []}
                      onChange={(v) => setBranchHeads((s) => ({ ...s, [b.id]: v }))}
                      types={['position']}
                      multi={false}
                      options={headOptions}
                      placeholder="Кто руководит объектом…"
                      context={{ workspaceId }}
                    />
                  </div>
                ))}
              </div>
            )}
            {chart.departments.length === 0 && chart.branches.length === 0 && (
              <p className="label-sm" style={{ margin: 0 }}>Отделов и объектов пока нет — можно добавить их позже кнопками «+ Отдел» и в разделе «Объекты».</p>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <span className="label-caps">Во главе</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <Chip tone="accent" icon="crown">{topLabel || '—'}</Chip>
                {topMode === 'new' && <Chip size="sm" tone="neutral">новая должность</Chip>}
                {topUser[0] && (
                  <PersonChip size="S" userId={topUser[0].id} firstName={topPerson?.firstName ?? 'Держатель'} lastName={topPerson?.lastName ?? null} avatar={topPerson?.avatar ?? null} />
                )}
              </div>
            </div>
            <Divider />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <span className="label-caps">Руководители</span>
              {chart.departments.map((d) => (
                <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <Icon name="department" size={15} />
                  <span className="body-sm">{d.name}</span>
                  <Icon name="arrowRight" size={13} />
                  <Chip size="sm" tone={deptHeads[d.id]?.[0] ? 'accent' : 'neutral'}>{posName(deptHeads[d.id]?.[0]?.id) || 'руководитель родителя / объекта'}</Chip>
                </div>
              ))}
              {chart.branches.map((b) => (
                <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <Icon name="branch" size={15} />
                  <span className="body-sm">{b.name}</span>
                  <Icon name="arrowRight" size={13} />
                  <Chip size="sm" tone={branchHeads[b.id]?.[0] ? 'accent' : 'neutral'}>{posName(branchHeads[b.id]?.[0]?.id) || 'не назначен'}</Chip>
                </div>
              ))}
            </div>
            <p className="label-sm" style={{ margin: 0 }}>Всё можно поправить потом прямо на схеме: перетаскиванием карточек и проводами.</p>
          </>
        )}
      </div>
    </Modal>
  );
}
