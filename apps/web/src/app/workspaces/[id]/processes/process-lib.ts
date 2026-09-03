// ============================================================
// Процессы — общая клиентская обвязка канваса.
// Документ (shared ProcessDocument) ↔ React Flow: docToFlow при загрузке,
// buildDocument при сохранении; во время редактирования источник — flow-state
// (applyNodeChanges/applyEdgeChanges), чтобы драг был плавным (без пересборки нод).
// ============================================================

// ВАЖНО: только type-импорты из @xyflow/react — этот модуль импортирует страница
// СПИСКА процессов, и value-импорт затащил бы весь канвас-пакет в её чанк.
import type { Edge, MarkerType, Node } from '@xyflow/react';
import type {
  ProcessDocument,
  ProcessFormField,
  ProcessNodeCategory,
  ProcessNodeTypeDto,
  ProcessPortType,
  ProcessStepStatus,
} from '@superapp/shared';
import { ICONS, type IconName, type Tone } from '@/components/ui';
import type { CanvasTone } from '@/components/canvas/tone';

/**
 * Матовый тон — базовый приём системы (DESIGN.md §1): заливка rgba(база,0.12–0.16)
 * + бордер rgba(база,0.30–0.35) + тёмный текст. Категорию ноды показывает ровно
 * он: подложка иконки на ноде и в палитре, точка на миникарте.
 *
 * Цвета — только переменными. В SVG React Flow (миникарта, стрелки рёбер) они
 * работают: библиотека кладёт их в inline-style, а не в атрибут fill.
 */
export type NodeTone = CanvasTone;

/** Шесть категорий на четыре системных тона не ложатся — два взяты из
 *  расширения палитры (violet/teal в globals.css). Красный не участвует:
 *  в системе он означает только опасность. */
export const CATEGORY_TONE: Record<ProcessNodeCategory, NodeTone> = {
  trigger: { bg: 'var(--warning-container)', border: 'var(--warning-border)', fg: 'var(--warning)', base: 'var(--warning-base)' },
  flow: { bg: 'var(--surface-container)', border: 'var(--border)', fg: 'var(--on-surface-variant)', base: 'var(--line)' },
  people: { bg: 'var(--primary-container)', border: 'var(--primary-border)', fg: 'var(--primary-dim)', base: 'var(--primary)' },
  service: { bg: 'var(--success-container)', border: 'var(--success-border)', fg: 'var(--success)', base: 'var(--success-base)' },
  ai: { bg: 'var(--violet-container)', border: 'var(--violet-border)', fg: 'var(--violet)', base: 'var(--violet-base)' },
  integration: { bg: 'var(--teal-container)', border: 'var(--teal-border)', fg: 'var(--teal)', base: 'var(--teal-base)' },
};

export function categoryTone(category: string | undefined): NodeTone {
  return CATEGORY_TONE[(category ?? 'flow') as ProcessNodeCategory] ?? CATEGORY_TONE.flow;
}

/**
 * Иконка ноды. Паспорт присылает семантический ключ реестра кита ('robot',
 * 'clock', …) — незнакомый ключ (нода нового бэкенда на старом фронте) не
 * ломает палитру, а рисуется запасной иконкой категории.
 */
const CATEGORY_FALLBACK_ICON: Record<ProcessNodeCategory, IconName> = {
  trigger: 'bolt',
  flow: 'processes',
  people: 'people',
  service: 'apps',
  ai: 'ai',
  integration: 'plug',
};

export function nodeIcon(t: { icon?: string; category?: string } | undefined): IconName {
  const key = t?.icon;
  if (key && key in ICONS) return key as IconName;
  return CATEGORY_FALLBACK_ICON[(t?.category ?? 'flow') as ProcessNodeCategory] ?? 'processes';
}

/** Ф4.5: цвет типизированного порта (поток vs подключение под-ноды к агенту). */
export const PORT_COLORS: Record<string, string> = {
  main: 'var(--outline)',
  ai_model: 'var(--violet-base)', // фиолетовый — Модель
  ai_memory: 'var(--teal-base)', // бирюзовый — Память
  ai_tool: 'var(--warning-base)', // янтарный — Инструменты
  ai_output: 'var(--success-base)', // зелёный — Парсер (структурированный ответ)
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

/** Кольцо статуса шага вокруг ноды (страница инстанса). */
export const STEP_STATUS_COLORS: Record<ProcessStepStatus, string> = {
  active: 'var(--warning-base)',
  done: 'var(--success-base)',
  // Раньше здесь стоял --primary: в прежней палитре он был красным. Ошибка
  // осталась после смены бренда на синий — «упавший шаг» подсвечивался акцентом.
  error: 'var(--danger-base)',
  cancelled: 'var(--muted)',
};

/** Матовый чип статуса внутри ноды (полноценный `<Chip>` туда не помещается). */
export const STEP_STATUS_BADGE: Record<ProcessStepStatus, NodeTone> = {
  active: { bg: 'var(--warning-container)', border: 'var(--warning-border)', fg: 'var(--warning)', base: 'var(--warning-base)' },
  done: { bg: 'var(--success-container)', border: 'var(--success-border)', fg: 'var(--success)', base: 'var(--success-base)' },
  error: { bg: 'var(--danger-container)', border: 'var(--danger-border)', fg: 'var(--danger)', base: 'var(--danger-base)' },
  cancelled: { bg: 'var(--surface-container)', border: 'var(--border)', fg: 'var(--on-surface-variant)', base: 'var(--muted)' },
};

/**
 * Тон статуса для чипов кита — вне канваса статусы рисует `<Chip tone>`,
 * а не своя подложка (пары выше остаются только внутри нод канваса,
 * где чип не помещается).
 */
export const INSTANCE_STATUS_TONE: Record<string, Tone> = {
  running: 'warning',
  done: 'success',
  cancelled: 'neutral',
  error: 'danger',
};

export const STEP_STATUS_TONE: Record<ProcessStepStatus, Tone> = {
  active: 'warning',
  done: 'success',
  error: 'danger',
  cancelled: 'neutral',
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
    icon: 'info',
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
    // Поток — тонкая карандашная линия; подключение под-ноды к агенту —
    // пунктир цветом своего порта (Модель/Память/Инструменты видны сразу).
    style: { stroke: color, strokeWidth: isAttach ? 1.75 : 1.5, strokeDasharray: isAttach ? '5 4' : undefined },
    markerEnd: isAttach
      ? undefined
      : { type: 'arrowclosed' as MarkerType, width: 15, height: 15, color },
    labelStyle: { fontSize: 10.5, fontWeight: 700, fill: 'var(--on-surface-variant)' },
    labelBgStyle: { fill: 'var(--block)', fillOpacity: 0.95 },
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 8,
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
