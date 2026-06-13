// ============================================================
// Процессы — общая клиентская обвязка канваса.
// Документ (shared ProcessDocument) ↔ React Flow: docToFlow при загрузке,
// buildDocument при сохранении; во время редактирования источник — flow-state
// (applyNodeChanges/applyEdgeChanges), чтобы драг был плавным (без пересборки нод).
// ============================================================

import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type {
  ProcessDocument,
  ProcessFormField,
  ProcessNodeTypeDto,
  ProcessPortType,
  ProcessStepStatus,
} from '@superapp/shared';

/** Визуальный язык категорий (DESIGN.md: цвет фона, не линии). */
export const CATEGORY_COLORS: Record<string, string> = {
  trigger: '#ffe1b0', // тёплый янтарь — триггеры запуска заметны (модель n8n: вход = особая нода)
  flow: 'var(--tertiary-container)',
  people: 'var(--primary-container)',
  service: 'var(--secondary-container)',
  ai: '#e7d9ff',
  integration: '#d9f2e0',
};

/** Ф4.5: цвет типизированного порта (поток vs подключение под-ноды к агенту). */
export const PORT_COLORS: Record<string, string> = {
  main: 'var(--secondary)',
  ai_model: '#8b5cf6', // фиолетовый — Модель
  ai_memory: '#14b8a6', // бирюзовый — Память
  ai_tool: '#f59e0b', // янтарный — Инструменты
  ai_output: '#10b981', // зелёный — Парсер (структурированный ответ)
};
export const PORT_LABELS: Record<string, string> = {
  ai_model: 'Модель',
  ai_memory: 'Память',
  ai_tool: 'Инструменты',
  ai_output: 'Парсер',
};
export function portType(out: { type?: ProcessPortType }): string {
  return out.type ?? 'main';
}

/** Цвет «точки/кольца» статуса шага (насыщенный — для маленьких индикаторов). */
export const STEP_STATUS_COLORS: Record<ProcessStepStatus, string> = {
  active: '#e8a33d',
  done: '#4f9d69',
  error: 'var(--primary)',
  cancelled: '#9a9a8a',
};

/** Бейджи статусов: тёмный текст на светлой подложке (контраст + скетч-стиль). */
export const STEP_STATUS_BADGE: Record<ProcessStepStatus, { bg: string; fg: string }> = {
  active: { bg: '#f6e3bd', fg: '#7a4f10' },
  done: { bg: '#dff0e4', fg: '#27563a' },
  error: { bg: 'var(--primary-container)', fg: '#8c1416' },
  cancelled: { bg: '#e6e6da', fg: '#55554a' },
};

export const INSTANCE_STATUS_BADGE: Record<string, { bg: string; fg: string }> = {
  running: { bg: '#f6e3bd', fg: '#7a4f10' },
  done: { bg: '#dff0e4', fg: '#27563a' },
  cancelled: { bg: '#e6e6da', fg: '#55554a' },
  error: { bg: 'var(--primary-container)', fg: '#8c1416' },
};

export interface PNodeData extends Record<string, unknown> {
  label: string;
  note?: string;
  config: Record<string, unknown>;
  typeDto: ProcessNodeTypeDto;
  /** Статус шага (страница инстанса). */
  stepStatus?: ProcessStepStatus;
  stepBadge?: string;
}

export type PNode = Node<PNodeData, 'pnode'>;

export function fallbackType(type: string): ProcessNodeTypeDto {
  return {
    type,
    title: type,
    description: '',
    category: 'flow',
    icon: '❓',
    tier: 'standard',
    outputs: [{ key: 'main', label: '' }],
    fields: [],
  };
}

/** Ребро канваса: поток (стрелка, серое) ИЛИ подключение под-ноды к агенту (цветное, пунктир). */
export function makeFlowEdge(
  id: string,
  from: string,
  fromPort: string,
  to: string,
  fromTypeDto: ProcessNodeTypeDto | undefined,
  toPort = 'main',
): Edge {
  const out = fromTypeDto?.outputs.find((o) => o.key === fromPort);
  const type = portType(out ?? {});
  const isAttach = type !== 'main';
  const color = isAttach ? PORT_COLORS[type] : 'var(--outline)';
  return {
    id,
    source: from,
    sourceHandle: fromPort,
    target: to,
    targetHandle: toPort,
    label: isAttach ? undefined : out?.label || undefined,
    style: { stroke: color, strokeWidth: isAttach ? 2.5 : 2, strokeDasharray: isAttach ? '6 4' : undefined },
    markerEnd: isAttach ? undefined : { type: MarkerType.ArrowClosed, width: 17, height: 17, color },
    labelStyle: { fontSize: 11, fontWeight: 600, fill: 'var(--on-surface)' },
    labelBgStyle: { fill: 'var(--surface)', fillOpacity: 0.9 },
  };
}

/** Документ → ноды/рёбра React Flow (загрузка в редактор / read-only инстанс). */
export function docToFlow(
  doc: ProcessDocument,
  typeMap: Map<string, ProcessNodeTypeDto>,
  stepState?: Map<string, { status: ProcessStepStatus; badge?: string }>,
): { nodes: PNode[]; edges: Edge[] } {
  const nodes: PNode[] = doc.nodes.map((n, i) => ({
    id: n.id,
    type: 'pnode',
    position: n.position ?? { x: 80 + (i % 4) * 240, y: 80 + Math.floor(i / 4) * 170 },
    // Любую ноду (включая триггеры) можно удалить — модель n8n; публикацию защищает
    // компилятор (требует ≥1 триггер и ноду «Конец»).
    data: {
      label: n.label || typeMap.get(n.type)?.title || n.type,
      note: n.note,
      config: n.config ?? {},
      typeDto: typeMap.get(n.type) ?? fallbackType(n.type),
      stepStatus: stepState?.get(n.id)?.status,
      stepBadge: stepState?.get(n.id)?.badge,
    },
  }));
  const edges: Edge[] = doc.edges.map((e) => {
    const fromType = doc.nodes.find((n) => n.id === e.from)?.type;
    return makeFlowEdge(e.id, e.from, e.fromPort || 'main', e.to, typeMap.get(fromType ?? ''), e.toPort || 'main');
  });
  return { nodes, edges };
}

/** Flow-state → документ (сохранение/публикация). Канвас — проекция, документ — правда. */
export function buildDocument(
  nodes: PNode[],
  edges: Edge[],
  form: ProcessFormField[],
): ProcessDocument {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.data.typeDto.type,
      label: n.data.label || undefined,
      note: n.data.note || undefined,
      config: n.data.config ?? {},
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    })),
    edges: edges.map((e) => ({
      id: e.id,
      from: e.source,
      fromPort: e.sourceHandle || 'main',
      to: e.target,
      toPort: e.targetHandle || 'main',
    })),
    form,
  };
}

/** Простая авто-раскладка слева-направо по уровням BFS (без внешних зависимостей). */
export function autoLayout(nodes: PNode[], edges: Edge[]): PNode[] {
  const out = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const n of nodes) {
    out.set(n.id, []);
    incoming.set(n.id, 0);
  }
  for (const e of edges) {
    out.get(e.source)?.push(e.target);
    incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
  }
  // Корни раскладки — все триггеры и узлы без входящих рёбер (точки входа процесса).
  const roots = nodes.filter((n) => n.data.typeDto.trigger || (incoming.get(n.id) ?? 0) === 0);
  const level = new Map<string, number>();
  const queue: string[] = (roots.length ? roots : nodes).map((n) => n.id);
  for (const id of queue) level.set(id, 0);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of out.get(cur) ?? []) {
      const candidate = (level.get(cur) ?? 0) + 1;
      if ((level.get(next) ?? -1) < candidate && candidate < 100) {
        level.set(next, candidate);
        queue.push(next);
      }
    }
  }
  let orphan = Math.max(0, ...level.values()) + 1;
  for (const n of nodes) if (!level.has(n.id)) level.set(n.id, orphan++);
  const lanes = new Map<number, number>();
  return nodes.map((n) => {
    const lvl = level.get(n.id) ?? 0;
    const lane = lanes.get(lvl) ?? 0;
    lanes.set(lvl, lane + 1);
    return { ...n, position: { x: 60 + lvl * 270, y: 90 + lane * 170 } };
  });
}

/** Человекочитаемая длительность («2 дн 4 ч», «3 мин», «12 с»). */
export function humanizeDuration(ms: number | null): string {
  if (ms === null || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч ${m % 60 > 0 ? `${m % 60} мин` : ''}`.trim();
  const d = Math.floor(h / 24);
  return `${d} дн ${h % 24 > 0 ? `${h % 24} ч` : ''}`.trim();
}

/** Свободный семантический id для новой ноды данного типа. */
export function nextNodeId(type: string, existing: Set<string>): string {
  const base = (type.split('.').pop() || 'node').replace(/[^a-zA-Z0-9_]/g, '_');
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

export function nextEdgeId(existing: Set<string>): string {
  for (let i = 1; i < 10000; i++) {
    const candidate = `e_${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `e_${Date.now()}`;
}
