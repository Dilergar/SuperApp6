'use client';

// ============================================================
// Канвас оргструктуры поверх общего FlowCanvas. Схема — чистая функция данных
// (org-layout): после любого изменения снимка раскладка пересчитывается заново,
// координаты не хранятся. Жесты правки:
//  • карточку тащат в рамку отдела → смена отдела (movePositionToDepartment);
//    бросили в пустоту — узел возвращается на место;
//  • провод узел→узел = переопределение подчинения (from = руководитель,
//    to = подчинённый — направление как у рёбер).
// Оптимистичных правок здесь нет: изменения применяет родитель и инвалидирует
// снимок; на время запроса узел стоит там, куда его бросили.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyNodeChanges, type Connection, type Edge, type NodeChange, type ReactFlowInstance, type XYPosition } from '@xyflow/react';
import type { OrgChartDto } from '@superapp/shared';
import { FlowCanvas } from '@/components/canvas/FlowCanvas';
// Свои ноды — ПОСЛЕ общего canvas.css (его тянет FlowCanvas)
import './org.css';
import { cx } from '@/components/ui';
import { ORG_NODE_TYPES, OrgCanvasContext } from './OrgNode';
import {
  deptNodeId,
  frameAtPoint,
  isDeptNodeId,
  layoutOrg,
  ORG_NODE_H,
  ORG_NODE_W,
  type OrgFlowNode,
  type OrgFocusMode,
  type OrgPositionNode,
  type OrgViewMode,
} from './org-layout';
import type { OrgSelection } from './org-lib';

export interface OrgCanvasProps {
  chart: OrgChartDto;
  view: OrgViewMode;
  focusMode: OrgFocusMode;
  /** Рисовать рамки отделов (на очень больших схемах выключается) */
  frames: boolean;
  /** Совпадения поиска (id узлов); null — поиска нет */
  hits: Set<string> | null;
  /** Узел, к которому нужно подъехать и подсветить (из адреса или списка поиска) */
  focusNodeId: string | null;
  /** Счётчик «подъехать ещё раз» к тому же узлу */
  focusTick: number;
  /** Счётчик «вернуть узлы на места раскладки» (после ответа сервера на жест) */
  resetTick: number;
  selection: OrgSelection | null;
  onSelect: (sel: OrgSelection | null) => void;
  canEdit: boolean;
  hireHref: string;
  onMoveToDepartment: (positionId: string, departmentId: string) => void;
  onReportsTo: (positionId: string, superiorPositionId: string) => void;
}

export function OrgCanvas({
  chart, view, focusMode, frames, hits, focusNodeId, focusTick, resetTick, selection, onSelect, canEdit, hireHref,
  onMoveToDepartment, onReportsTo,
}: OrgCanvasProps) {
  const layout = useMemo(() => layoutOrg({ chart, view, focus: focusMode, frames }), [chart, view, focusMode, frames]);

  // Цель фокуса: рамка отдела, если нарисована, иначе первая должность отдела
  const resolvedFocus = useMemo(() => {
    if (!focusNodeId) return null;
    if (!isDeptNodeId(focusNodeId)) return layout.visible.has(focusNodeId) ? focusNodeId : null;
    if (layout.nodes.some((n) => n.id === focusNodeId)) return focusNodeId;
    const depId = focusNodeId.slice(5);
    const first = layout.nodes.find((n) => n.type === 'opos' && (n as OrgPositionNode).data.position.departmentId === depId);
    return first?.id ?? null;
  }, [focusNodeId, layout]);

  const selectedNodeId = selection?.type === 'position' ? selection.id : selection?.type === 'department' ? deptNodeId(selection.id) : null;

  // Подсветка и выделение — классом на обёртке React Flow, данные нод не трогаем
  const decorated = useMemo<OrgFlowNode[]>(
    () =>
      layout.nodes.map((n) => {
        const hit = hits ? hits.has(n.id) : resolvedFocus === n.id;
        const dim = !!hits && !hits.has(n.id);
        return { ...n, className: cx(n.className, hit && 'is-hit', dim && 'is-dim') || undefined, selected: n.id === selectedNodeId };
      }),
    [layout, hits, resolvedFocus, selectedNodeId],
  );

  const [nodes, setNodes] = useState<OrgFlowNode[]>(decorated);
  useEffect(() => setNodes(decorated), [decorated, resetTick]);
  const onNodesChange = useCallback((changes: NodeChange<OrgFlowNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);

  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const frameUnder = useCallback(
    (abs: XYPosition) => frameAtPoint(layout.frames, abs.x + ORG_NODE_W / 2, abs.y + ORG_NODE_H / 2),
    [layout.frames],
  );
  const onNodeDrag = useCallback(
    (node: OrgFlowNode, abs: XYPosition) => {
      if (node.type !== 'opos') return;
      const f = frameUnder(abs);
      const own = (node as OrgPositionNode).data.position.departmentId;
      setDropTarget(f && f.departmentId !== own ? f.departmentId : null);
    },
    [frameUnder],
  );
  const onNodeDragStop = useCallback(
    (node: OrgFlowNode, abs: XYPosition) => {
      setDropTarget(null);
      if (node.type !== 'opos') return;
      const f = frameUnder(abs);
      if (f && f.departmentId !== (node as OrgPositionNode).data.position.departmentId) {
        onMoveToDepartment(node.id, f.departmentId);
        return;
      }
      // В пустоту или в свой же отдел — узел возвращается на место раскладки
      setNodes(decorated);
    },
    [frameUnder, onMoveToDepartment, decorated],
  );

  const isValidConnection = useCallback(
    (c: Connection | Edge) => !!c.source && !!c.target && c.source !== c.target && !isDeptNodeId(c.source) && !isDeptNodeId(c.target),
    [],
  );
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      onReportsTo(c.target, c.source);
    },
    [onReportsTo],
  );

  const onNodeClick = useCallback(
    (id: string) => onSelect(isDeptNodeId(id) ? { type: 'department', id: id.slice(5) } : { type: 'position', id }),
    [onSelect],
  );
  const onPaneClick = useCallback(() => onSelect(null), [onSelect]);

  // Подъехать к цели фокуса (после раскладки; узлы известны по width/height, замер не нужен)
  const rf = useRef<ReactFlowInstance<OrgFlowNode, Edge> | null>(null);
  useEffect(() => {
    if (!resolvedFocus) return;
    const t = window.setTimeout(() => {
      void rf.current?.fitView({ nodes: [{ id: resolvedFocus }], duration: 500, maxZoom: 1.1, padding: 0.6 });
    }, 80);
    return () => window.clearTimeout(t);
  }, [resolvedFocus, focusTick]);

  // Смена «моя ветка ↔ вся компания» / фильтра объекта — вписать схему заново
  const first = useRef(true);
  const scopeKey = `${focusMode}|${chart.branchId ?? ''}`;
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = window.setTimeout(() => { void rf.current?.fitView({ duration: 400, padding: 0.2, maxZoom: 1 }); }, 80);
    return () => window.clearTimeout(t);
  }, [scopeKey]);

  const ctx = useMemo(() => ({ people: chart.people, hireHref, dropTargetDepartmentId: dropTarget }), [chart.people, hireHref, dropTarget]);

  return (
    <OrgCanvasContext.Provider value={ctx}>
      <FlowCanvas<OrgFlowNode, Edge>
        className="ocanvas"
        nodes={nodes}
        edges={layout.edges}
        nodeTypes={ORG_NODE_TYPES}
        editable={canEdit}
        deleteKeyCode={null}
        snapToGrid={false}
        elevateNodesOnSelect={false}
        onlyRenderVisibleElements={chart.positions.length > 120}
        onNodesChange={onNodesChange}
        onNodeDrag={canEdit ? onNodeDrag : undefined}
        onNodeDragStop={canEdit ? onNodeDragStop : undefined}
        isValidConnection={isValidConnection}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onInit={(inst) => { rf.current = inst; }}
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        height="100%"
      />
    </OrgCanvasContext.Provider>
  );
}
