'use client';

// ============================================================
// Ноды канваса оргструктуры: должность (.onode) и рамка отдела (.ogroup).
// Человек на узле — только PersonAvatar (стек 3 + «+N», подсказка с именем);
// значок должности — данные, рисует <Glyph/>; статус и отдел — чипы кита;
// «Нанять» у вакансии — кнопка (действие = форма, DESIGN.md §1).
// Люди приходят одним батчем (chart.people) через контекст, не по одному.
// ============================================================

import { createContext, memo, useContext } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { OrgPersonLite } from '@superapp/shared';
import { AvatarStack, Button, Chip, Glyph, Icon, Tooltip, cx } from '@/components/ui';
import { PersonAvatar } from '@/app/messenger/messenger-ui';
import { personName } from './org-lib';
import type { OrgDeptNode, OrgPositionNode } from './org-layout';

export interface OrgCanvasContextValue {
  people: Record<string, OrgPersonLite>;
  /** Куда ведёт «Нанять» у вакансии */
  hireHref: string;
  /** Рамка, над которой сейчас тащат карточку (подсветка цели) */
  dropTargetDepartmentId: string | null;
}

export const OrgCanvasContext = createContext<OrgCanvasContextValue>({ people: {}, hireHref: '#', dropTargetDepartmentId: null });

const MAX_FACES = 3;

/**
 * Боковые порты — только для рёбер замещения (пунктир идёт вбок, а не сквозь
 * узлы по вертикали). Невидимы и несоединяемы: провод человек тянет из нижнего
 * порта в верхний — это подчинение. React Flow меряет их как обычные.
 */
const SIDE_HANDLE: React.CSSProperties = { opacity: 0, pointerEvents: 'none', width: 1, height: 1, minWidth: 0, minHeight: 0 };

export const OrgPositionNodeView = memo(function OrgPositionNodeView({ data, selected }: NodeProps<OrgPositionNode>) {
  const { people, hireHref } = useContext(OrgCanvasContext);
  const p = data.position;
  const holders = p.holders;
  const faces = holders.slice(0, MAX_FACES);
  const rest = holders.length - faces.length;
  const headTitle = data.headOf.length ? `Руководит: ${data.headOf.join(', ')}` : undefined;
  return (
    <div
      className={cx('onode', p.vacant && 'is-vacant', selected && 'is-selected', data.isHead && 'is-head')}
      title={headTitle}
    >
      <Handle id="t" type="target" position={Position.Top} style={{ top: -6 }} />
      <Handle id="sl" type="source" position={Position.Left} isConnectable={false} style={SIDE_HANDLE} />
      <Handle id="sr" type="source" position={Position.Right} isConnectable={false} style={SIDE_HANDLE} />
      <Handle id="tl" type="target" position={Position.Left} isConnectable={false} style={SIDE_HANDLE} />
      <Handle id="tr" type="target" position={Position.Right} isConnectable={false} style={SIDE_HANDLE} />
      <div className="onode-row">
        <span className="onode-glyph" aria-label={headTitle}>
          <Glyph value={p.glyph} fallback="position" size={18} />
          {data.isHead && <span className="onode-head-dot" aria-hidden />}
        </span>
        <span className="onode-text">
          <span className="onode-title" title={p.name}>{p.name}</span>
        </span>
      </div>
      <div className="onode-chips">
        {data.departmentName && (
          <Chip size="sm" tone="neutral" icon="department" title={data.departmentName} className="onode-chip-dept">
            <span className="onode-chip-text">{data.departmentName}</span>
          </Chip>
        )}
        {p.vacant ? (
          <Chip size="sm" tone="waiting">Вакансия</Chip>
        ) : data.training ? (
          <Chip size="sm" tone="waiting">Стажируется</Chip>
        ) : null}
      </div>
      <div className="onode-people">
        {p.vacant ? (
          <span className="nodrag">
            <Button size="sm" variant="matte" icon="userAdd" href={hireHref}>Нанять</Button>
          </span>
        ) : (
          <>
            <AvatarStack size={32} overflow={rest}>
              {faces.map((h) => {
                const person = people[h.userId];
                const name = personName(person);
                return (
                  <Tooltip key={h.assignmentId} content={name}>
                    <span style={{ display: 'inline-flex' }} aria-label={name}>
                      <PersonAvatar userId={h.userId} name={name} avatar={person?.avatar} size="sm" />
                    </span>
                  </Tooltip>
                );
              })}
            </AvatarStack>
            {holders.length === 1 && (
              <span className="onode-people-note" title={personName(people[holders[0].userId])}>
                {personName(people[holders[0].userId])}
              </span>
            )}
          </>
        )}
      </div>
      <Handle id="s" type="source" position={Position.Bottom} style={{ bottom: -6 }} />
    </div>
  );
});

export const OrgDeptNodeView = memo(function OrgDeptNodeView({ data, selected }: NodeProps<OrgDeptNode>) {
  const { dropTargetDepartmentId } = useContext(OrgCanvasContext);
  const d = data.department;
  return (
    <div className={cx('ogroup', selected && 'is-selected', dropTargetDepartmentId === d.id && 'is-drop')}>
      <span className="ogroup-head" title={d.name}>
        <Icon name="department" size={14} />
        {d.name}
        <span className="meta">{data.positionsCount}</span>
      </span>
    </div>
  );
});

export const ORG_NODE_TYPES = { opos: OrgPositionNodeView, odept: OrgDeptNodeView };
