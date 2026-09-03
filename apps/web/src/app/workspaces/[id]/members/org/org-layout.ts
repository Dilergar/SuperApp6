// ============================================================
// Раскладка оргструктуры — детерминированное дерево (Reingold–Tilford-подобная,
// без dagre/elkjs): лес по серверному `superiorPositionId` (корни — `roots`),
// явная сортировка на каждом уровне, рамки отделов растягиваются по своим
// узлам. Координаты НЕ хранятся: одни и те же данные → та же картинка, поэтому
// после любой правки схема не «прыгает», а пересчитывается на месте.
//
// Правила:
//  • узел = должность (ORG_NODE_W × ORG_NODE_H, размер фиксирован — от него
//    считается вертикаль);
//  • соседи по уровню сгруппированы по отделу (ранг отдела → sortOrder → имя),
//    чтобы рамка отдела была сплошной; между узлами разных рамок — по FRAME_PAD
//    на каждую пересекаемую границу;
//  • рамки — только для отделов глубины ≤ ORG_FRAME_MAX_DEPTH (0 и 1); глубже —
//    чип на узле. Голова, лежащая ВНЕ отдела, в рамку не попадает (членство —
//    по departmentId должности, не по подчинению);
//  • рамка, в которую попал ЧУЖОЙ узел (данные пересекаются между поддеревьями)
//    или которая пересекает соседнюю, не рисуется — лучше без рамки, чем ложь.
// ============================================================

import type { Edge, MarkerType, Node } from '@xyflow/react';
import type { OrgChartDepartmentDto, OrgChartDto, OrgChartPositionDto } from '@superapp/shared';
import { dm } from '@/lib/dates';

export const ORG_NODE_W = 240;
export const ORG_NODE_H = 116;
const H_GAP = 48;
const ROOT_GAP = 96;
const V_GAP = 120;
const FRAME_PAD = 16;
const FRAME_HEAD = 36;
/** Рамки рисуются для отделов глубины 0 и 1; глубже — только чип на узле */
export const ORG_FRAME_MAX_DEPTH = 1;

export type OrgViewMode = 'reports' | 'deputies' | 'both';
export type OrgFocusMode = 'mine' | 'all';

export interface OrgPositionNodeData extends Record<string, unknown> {
  position: OrgChartPositionDto;
  departmentName: string | null;
  /** Голова отдела/объекта — маркер --primary */
  isHead: boolean;
  /** Чем руководит (подпись маркера) */
  headOf: string[];
  /** Среди держателей есть стажёр */
  training: boolean;
}
export type OrgPositionNode = Node<OrgPositionNodeData, 'opos'>;

export interface OrgDeptNodeData extends Record<string, unknown> {
  department: OrgChartDepartmentDto;
  positionsCount: number;
}
export type OrgDeptNode = Node<OrgDeptNodeData, 'odept'>;

export type OrgFlowNode = OrgPositionNode | OrgDeptNode;

export const deptNodeId = (departmentId: string) => `dept:${departmentId}`;
export const isDeptNodeId = (id: string) => id.startsWith('dept:');
export const departmentIdOf = (nodeId: string) => (isDeptNodeId(nodeId) ? nodeId.slice(5) : null);

export interface OrgFrameRect {
  departmentId: string;
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OrgLayoutInput {
  chart: OrgChartDto;
  view: OrgViewMode;
  focus: OrgFocusMode;
  /** Рисовать рамки отделов (выключается на очень больших схемах) */
  frames: boolean;
}

export interface OrgLayout {
  nodes: OrgFlowNode[];
  edges: Edge[];
  /** Видимые должности (после «моей ветки») */
  visible: Set<string>;
  /** Нарисованные рамки в АБСОЛЮТНЫХ координатах (для попадания при перетаскивании) */
  frames: OrgFrameRect[];
  /** «Моя ветка» сузила схему */
  narrowed: boolean;
}

interface Rect { x: number; y: number; w: number; h: number }
const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const byOrder = (a: { sortOrder: number; name: string }, b: { sortOrder: number; name: string }) =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'ru');

/** Подпись периода замещения на пунктире: «01.09–15.09», «с 01.09», «до 15.09», «запасной» */
export function deputyPeriodLabel(startsOn?: string | null, endsOn?: string | null): string {
  if (startsOn && endsOn) return `${dm(startsOn)}–${dm(endsOn)}`;
  if (startsOn) return `с ${dm(startsOn)}`;
  if (endsOn) return `до ${dm(endsOn)}`;
  return 'запасной';
}

export function layoutOrg({ chart, view, focus, frames: wantFrames }: OrgLayoutInput): OrgLayout {
  const posById = new Map(chart.positions.map((p) => [p.id, p]));
  const depById = new Map(chart.departments.map((d) => [d.id, d]));
  const depRank = new Map<string, number>();
  [...chart.departments].sort(byOrder).forEach((d, i) => depRank.set(d.id, i));

  const sup = (p: OrgChartPositionDto): string | null =>
    p.superiorPositionId && p.superiorPositionId !== p.id && posById.has(p.superiorPositionId) ? p.superiorPositionId : null;

  // ---- «Моя ветка»: мои должности + вверх по руководителям + вниз по подчинённым ----
  let visible = new Set(posById.keys());
  let narrowed = false;
  if (focus === 'mine' && chart.myPositionIds.some((id) => posById.has(id))) {
    const childrenAll = new Map<string, string[]>();
    for (const p of chart.positions) {
      const s = sup(p);
      if (s) childrenAll.set(s, [...(childrenAll.get(s) ?? []), p.id]);
    }
    const set = new Set<string>();
    for (const my of chart.myPositionIds) {
      let cur = posById.get(my);
      const guard = new Set<string>();
      while (cur && !guard.has(cur.id)) {
        guard.add(cur.id);
        set.add(cur.id);
        const s = sup(cur);
        cur = s ? posById.get(s) : undefined;
      }
      const stack = [my];
      while (stack.length) {
        const id = stack.pop()!;
        for (const c of childrenAll.get(id) ?? []) {
          if (!set.has(c)) {
            set.add(c);
            stack.push(c);
          }
        }
      }
    }
    visible = set;
    narrowed = set.size < posById.size;
  }

  // ---- Лес по superiorPositionId ----
  const children = new Map<string, OrgChartPositionDto[]>();
  const roots: OrgChartPositionDto[] = [];
  const cmp = (a: OrgChartPositionDto, b: OrgChartPositionDto) =>
    (depRank.get(a.departmentId ?? '') ?? -1) - (depRank.get(b.departmentId ?? '') ?? -1) || byOrder(a, b);
  for (const p of chart.positions) {
    if (!visible.has(p.id)) continue;
    const s = sup(p);
    if (s && visible.has(s)) children.set(s, [...(children.get(s) ?? []), p]);
    else roots.push(p);
  }
  for (const list of children.values()) list.sort(cmp);
  roots.sort(cmp);
  // При фильтре объекта вершина — руководитель объекта
  if (chart.branchId) {
    const head = chart.branches.find((b) => b.id === chart.branchId)?.headPositionId;
    if (head) roots.sort((a, b) => Number(b.id === head) - Number(a.id === head));
  }

  // Дерево с защитой от циклов (повреждённые данные): каждый узел кладётся один раз;
  // недостижимые из корней (замкнутые в цикл) становятся дополнительными корнями.
  const treeKids = new Map<string, OrgChartPositionDto[]>();
  const seen = new Set<string>();
  const build = (p: OrgChartPositionDto) => {
    seen.add(p.id);
    const ks = (children.get(p.id) ?? []).filter((c) => !seen.has(c.id));
    for (const k of ks) seen.add(k.id);
    treeKids.set(p.id, ks);
    for (const k of ks) build(k);
  };
  for (const r of roots) if (!seen.has(r.id)) build(r);
  for (const p of [...chart.positions].sort(cmp)) {
    if (visible.has(p.id) && !seen.has(p.id)) {
      roots.push(p);
      build(p);
    }
  }

  // ---- Цепочка рамок отдела: [depth0, depth1] (предки с глубиной ≤ MAX, включая сам) ----
  const chainCache = new Map<string, string[]>();
  const frameChain = (departmentId: string | null): string[] => {
    if (!departmentId || !wantFrames) return [];
    const hit = chainCache.get(departmentId);
    if (hit) return hit;
    const out: string[] = [];
    let cur = depById.get(departmentId);
    const guard = new Set<string>();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      if (cur.depth <= ORG_FRAME_MAX_DEPTH) out.unshift(cur.id);
      cur = cur.parentId ? depById.get(cur.parentId) : undefined;
    }
    chainCache.set(departmentId, out);
    return out;
  };
  const gapBetween = (a: OrgChartPositionDto, b: OrgChartPositionDto): number => {
    const ca = frameChain(a.departmentId);
    const cb = frameChain(b.departmentId);
    let crossings = 0;
    for (const x of ca) if (!cb.includes(x)) crossings++;
    for (const x of cb) if (!ca.includes(x)) crossings++;
    return H_GAP + crossings * FRAME_PAD;
  };

  // ---- Ширины поддеревьев (post-order) ----
  const width = new Map<string, number>();
  const kidsWidth = (ks: OrgChartPositionDto[]) =>
    ks.reduce((acc, k, i) => acc + (width.get(k.id) ?? ORG_NODE_W) + (i > 0 ? gapBetween(ks[i - 1], k) : 0), 0);
  const subW = (p: OrgChartPositionDto): number => {
    const ks = treeKids.get(p.id) ?? [];
    for (const k of ks) subW(k);
    const w = ks.length ? Math.max(ORG_NODE_W, kidsWidth(ks)) : ORG_NODE_W;
    width.set(p.id, w);
    return w;
  };
  for (const r of roots) subW(r);

  // ---- Координаты ----
  const pos = new Map<string, { x: number; y: number }>();
  const place = (p: OrgChartPositionDto, x0: number, depth: number) => {
    const w = width.get(p.id) ?? ORG_NODE_W;
    pos.set(p.id, { x: x0 + (w - ORG_NODE_W) / 2, y: depth * (ORG_NODE_H + V_GAP) });
    const ks = treeKids.get(p.id) ?? [];
    if (!ks.length) return;
    let cx = x0 + (w - kidsWidth(ks)) / 2;
    ks.forEach((k, i) => {
      if (i > 0) cx += gapBetween(ks[i - 1], k);
      place(k, cx, depth + 1);
      cx += width.get(k.id) ?? ORG_NODE_W;
    });
  };
  let rx = 0;
  roots.forEach((r, i) => {
    if (i > 0) rx += ROOT_GAP;
    place(r, rx, 0);
    rx += width.get(r.id) ?? ORG_NODE_W;
  });

  const nodeRect = (id: string): Rect => {
    const p = pos.get(id)!;
    return { x: p.x, y: p.y, w: ORG_NODE_W, h: ORG_NODE_H };
  };

  // ---- Рамки отделов: сначала глубина 1, потом 0 (внешняя обнимает внутренние) ----
  const frameById = new Map<string, OrgFrameRect>();
  const membersOf = new Map<string, string[]>();
  if (wantFrames) {
    for (const p of chart.positions) {
      if (!visible.has(p.id)) continue;
      for (const depId of frameChain(p.departmentId)) membersOf.set(depId, [...(membersOf.get(depId) ?? []), p.id]);
    }
    const candidates = chart.departments
      .filter((d) => d.depth <= ORG_FRAME_MAX_DEPTH && (membersOf.get(d.id)?.length ?? 0) > 0)
      .sort((a, b) => b.depth - a.depth || byOrder(a, b));
    for (const d of candidates) {
      const members = membersOf.get(d.id) ?? [];
      const rects: Rect[] = members.map(nodeRect);
      for (const f of frameById.values()) {
        const fd = depById.get(f.departmentId);
        if (fd?.parentId === d.id) rects.push(f);
      }
      const minX = Math.min(...rects.map((r) => r.x)) - FRAME_PAD;
      const minY = Math.min(...rects.map((r) => r.y)) - FRAME_PAD - FRAME_HEAD;
      const maxX = Math.max(...rects.map((r) => r.x + r.w)) + FRAME_PAD;
      const maxY = Math.max(...rects.map((r) => r.y + r.h)) + FRAME_PAD;
      const rect: OrgFrameRect = { departmentId: d.id, depth: d.depth, x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      // Чужой узел внутри рамки — рамка лжёт, не рисуем
      const memberSet = new Set(members);
      let foreign = false;
      for (const id of visible) {
        if (memberSet.has(id)) continue;
        if (intersects(rect, nodeRect(id))) { foreign = true; break; }
      }
      if (foreign) continue;
      // Пересечение с уже принятой рамкой того же уровня вложенности
      let clash = false;
      for (const f of frameById.values()) {
        const fd = depById.get(f.departmentId);
        const sameParent = fd?.parentId === d.parentId && f.departmentId !== d.id;
        if (sameParent && intersects(rect, f)) { clash = true; break; }
      }
      if (clash) continue;
      frameById.set(d.id, rect);
    }
  }

  // ---- Узлы: рамки (родитель раньше детей), затем должности ----
  const nodes: OrgFlowNode[] = [];
  const parentFrameOf = (departmentId: string | null): OrgFrameRect | null => {
    const chain = frameChain(departmentId);
    for (let i = chain.length - 1; i >= 0; i--) {
      const f = frameById.get(chain[i]);
      if (f) return f;
    }
    return null;
  };
  const framesSorted = [...frameById.values()].sort((a, b) => a.depth - b.depth || a.x - b.x);
  for (const f of framesSorted) {
    const d = depById.get(f.departmentId)!;
    const parent = d.parentId ? frameById.get(d.parentId) ?? null : null;
    nodes.push({
      id: deptNodeId(f.departmentId),
      type: 'odept',
      position: { x: f.x - (parent?.x ?? 0), y: f.y - (parent?.y ?? 0) },
      parentId: parent ? deptNodeId(parent.departmentId) : undefined,
      style: { width: f.w, height: f.h },
      width: f.w,
      height: f.h,
      draggable: false,
      connectable: false,
      // Рамки — под рёбрами (отрицательный z), должности — над ними
      zIndex: f.depth - 3,
      className: 'ogroup-wrap',
      // Узлы React Flow фокусируемы: без подписи скринридер читал «group» и сырой
      // текст внутри. `ariaLabel` кладётся на обёртку узла самим React Flow.
      ariaLabel: `Отдел «${d.name}», должностей: ${(membersOf.get(f.departmentId) ?? []).length}`,
      data: { department: d, positionsCount: (membersOf.get(f.departmentId) ?? []).length },
    });
  }
  const headOf = (p: OrgChartPositionDto): string[] => [
    ...p.headsDepartmentIds.map((id) => depById.get(id)?.name ?? '').filter(Boolean),
    ...p.headsBranchIds.map((id) => chart.branches.find((b) => b.id === id)?.name ?? '').filter(Boolean),
  ];
  for (const p of [...chart.positions].sort(cmp)) {
    if (!visible.has(p.id)) continue;
    const at = pos.get(p.id);
    if (!at) continue;
    const parent = parentFrameOf(p.departmentId);
    nodes.push({
      id: p.id,
      type: 'opos',
      position: { x: at.x - (parent?.x ?? 0), y: at.y - (parent?.y ?? 0) },
      parentId: parent ? deptNodeId(parent.departmentId) : undefined,
      width: ORG_NODE_W,
      height: ORG_NODE_H,
      zIndex: 1,
      ariaLabel: p.vacant
        ? `Должность «${p.name}», вакансия`
        : `Должность «${p.name}», держателей: ${p.holders.length}`,
      data: {
        position: p,
        departmentName: p.departmentId ? depById.get(p.departmentId)?.name ?? null : null,
        isHead: p.headsDepartmentIds.length > 0 || p.headsBranchIds.length > 0,
        headOf: headOf(p),
        training: p.holders.some((h) => h.status === 'training'),
      },
    });
  }

  // ---- Рёбра: подчинение (сплошная со стрелкой) и замещение (пунктир --warning-base) ----
  const edges: Edge[] = [];
  if (view !== 'deputies') {
    for (const p of chart.positions) {
      const s = sup(p);
      if (!s || !visible.has(p.id) || !visible.has(s)) continue;
      edges.push({
        id: `r:${p.id}`,
        source: s,
        target: p.id,
        sourceHandle: 's',
        targetHandle: 't',
        type: 'smoothstep',
        style: { stroke: 'var(--outline)', strokeWidth: 1.5 },
        markerEnd: { type: 'arrowclosed' as MarkerType, width: 16, height: 16, color: 'var(--outline)' },
      });
    }
  }
  if (view !== 'reports') {
    chart.edges.forEach((e, i) => {
      if (e.kind !== 'deputy' || !visible.has(e.from) || !visible.has(e.to)) return;
      // Пунктир идёт вбок (боковые порты), чтобы не резать узлы по вертикали:
      // зам левее — из его правого порта в левый порт замещаемого, и наоборот.
      const fromLeft = (pos.get(e.from)?.x ?? 0) <= (pos.get(e.to)?.x ?? 0);
      edges.push({
        id: `d:${i}:${e.from}:${e.to}`,
        source: e.from,
        target: e.to,
        sourceHandle: fromLeft ? 'sr' : 'sl',
        targetHandle: fromLeft ? 'tl' : 'tr',
        type: 'default',
        style: { stroke: 'var(--warning-base)', strokeWidth: 1.75, strokeDasharray: '6 4' },
        label: deputyPeriodLabel(e.startsOn, e.endsOn),
        labelStyle: { fontSize: 10.5, fontWeight: 700, fill: 'var(--warning)' },
        labelBgStyle: { fill: 'var(--block)', fillOpacity: 0.95 },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 8,
        zIndex: 2,
      });
    });
  }

  return { nodes, edges, visible, frames: framesSorted, narrowed };
}

/** Самая глубокая рамка, содержащая точку (для дропа карточки в отдел). */
export function frameAtPoint(frames: OrgFrameRect[], x: number, y: number): OrgFrameRect | null {
  let best: OrgFrameRect | null = null;
  for (const f of frames) {
    if (x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h && (!best || f.depth > best.depth)) best = f;
  }
  return best;
}
