'use client';

// Канвас процессов — ноды «Процессов» поверх общего FlowCanvas (@xyflow/react;
// тот же класс канваса, что у Langflow/Flowise/Dify; n8n сидит на Vue-собрате).
// Используется редактором (editable) и страницей инстанса (read-only со
// статусами шагов).
//
// Organic Bento (DESIGN.md): полотно — тёплая бумага, нода — светлый блок с
// 1px-бордером и единственной тенью системы, категория показана матовым кругом
// с иконкой Phosphor Light. Полотно, порты, контролы и миникарта — общие
// (components/canvas: FlowCanvas + canvas.css); здесь только свои ноды, их
// стили (process-canvas.css, алиас .pcanvas) и правила соединения портов.

import { memo, useCallback, useMemo } from 'react';
import {
  Handle,
  Position,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import { FlowCanvas } from '@/components/canvas/FlowCanvas';
// Порядок важен: свои ноды — ПОСЛЕ общего canvas.css (его тянет FlowCanvas).
import './process-canvas.css';
import { PROCESS_STEP_STATUS_LABELS, type ProcessNodeInput, type ProcessNodeTypeDto } from '@superapp/shared';
import { Icon } from '@/components/ui';
import {
  categoryTone,
  nodeIcon,
  PORT_COLORS,
  PORT_LABELS,
  portType,
  STEP_STATUS_BADGE,
  STEP_STATUS_COLORS,
  type PNode,
  type PNodeData,
} from './process-lib';

/** Входные порты ноды (по умолчанию: один main; у триггеров/под-нод — пусто). */
function nodeInputs(t: ProcessNodeTypeDto): ProcessNodeInput[] {
  if (t.inputs) return t.inputs;
  if (t.trigger || t.subNode) return [];
  return [{ key: 'main', type: 'main' }];
}

const ProcessNodeView = memo(function ProcessNodeView({ data, selected }: NodeProps<PNode>) {
  const d = data as PNodeData;
  const t = d.typeDto;
  const tone = categoryTone(t.category);
  const status = d.stepStatus ? STEP_STATUS_BADGE[d.stepStatus] : null;
  // Триггеры теперь — полноценные ноды (со своими настройками); точкой остаётся только «Конец».
  const isDot = t.type === 'end';
  return (
    <div
      className={`pnode${isDot ? ' pnode--dot' : ''}${selected ? ' is-selected' : ''}`}
      // Статус шага красит рамку ноды; выделение перебивает его классом.
      style={
        d.stepStatus
          ? ({
              '--pnode-ring': STEP_STATUS_COLORS[d.stepStatus],
              '--pnode-halo': status?.bg,
            } as React.CSSProperties)
          : undefined
      }
    >
      {/* входы: main — слева; типизированные (Модель/Память/Инструменты) — снизу */}
      {(() => {
        const inputs = nodeInputs(t);
        const aiInputs = inputs.filter((i) => i.type !== 'main');
        return (
          <>
            {inputs.some((i) => i.type === 'main') && (
              <Handle id="main" type="target" position={Position.Left} style={{ left: -6 }} />
            )}
            {aiInputs.map((inp, i) => {
              const left = `${((i + 1) / (aiInputs.length + 1)) * 100}%`;
              const color = PORT_COLORS[inp.type];
              return (
                <Handle key={inp.key} id={inp.key} type="target" position={Position.Bottom} style={{ bottom: -6, left, borderColor: color }}>
                  <span className="pnode-port-label pnode-port-label--bottom" style={{ color }}>
                    {inp.label ?? PORT_LABELS[inp.type]}
                  </span>
                </Handle>
              );
            })}
          </>
        );
      })()}

      <div className="pnode-row">
        <span className="pnode-icon" style={{ background: tone.bg, borderColor: tone.border, color: tone.fg }}>
          <Icon name={nodeIcon(t)} size={17} />
        </span>
        <span className="pnode-text">
          <span className="pnode-title" title={d.label}>{d.label}</span>
          {/* Подпись типа — только когда она добавляет смысл: у неназванной ноды
              подпись равна названию типа, и вторая строка была бы эхом. */}
          {d.label !== t.title && <span className="pnode-sub">{t.title}</span>}
        </span>
      </div>

      {(d.stepStatus || d.stepBadge) && (
        <span
          className="pnode-badge"
          style={{ background: status?.bg, borderColor: status?.border, color: status?.fg }}
        >
          {d.stepBadge ?? (d.stepStatus ? PROCESS_STEP_STATUS_LABELS[d.stepStatus] : '')}
        </span>
      )}

      {/* выходы: main — справа (подписи Да/Нет); типизированный (astool) — сверху */}
      {(() => {
        const mainOuts = t.outputs.filter((o) => portType(o) === 'main');
        const aiOuts = t.outputs.filter((o) => portType(o) !== 'main');
        return (
          <>
            {mainOuts.map((out, i) => {
              const top = `${((i + 1) / (mainOuts.length + 1)) * 100}%`;
              return (
                <Handle key={out.key} id={out.key} type="source" position={Position.Right} style={{ right: -6, top }}>
                  {out.label && <span className="pnode-port-label pnode-port-label--right">{out.label}</span>}
                </Handle>
              );
            })}
            {aiOuts.map((out, i) => {
              const left = `${((i + 1) / (aiOuts.length + 1)) * 100}%`;
              const color = PORT_COLORS[portType(out)];
              return (
                <Handle key={out.key} id={out.key} type="source" position={Position.Top} style={{ top: -6, left, borderColor: color }}>
                  <span className="pnode-port-label pnode-port-label--top" style={{ color }}>{out.label}</span>
                </Handle>
              );
            })}
          </>
        );
      })()}
    </div>
  );
});

const NODE_TYPES = { pnode: ProcessNodeView };

export interface ProcessCanvasProps {
  nodes: PNode[];
  edges: Edge[];
  editable?: boolean;
  onNodesChange?: (changes: NodeChange<PNode>[]) => void;
  onEdgesChange?: (changes: EdgeChange[]) => void;
  onConnect?: (connection: Connection) => void;
  /** Дроп ноды из палитры: тип + позиция в координатах канваса. */
  onDropNode?: (type: string, position: { x: number; y: number }) => void;
  /** Бросили провод в пустоту (жест n8n): открыть пикер нод в этой точке. */
  onConnectEndOnPane?: (
    fromNodeId: string,
    fromPort: string,
    flowPosition: { x: number; y: number },
    screenPosition: { x: number; y: number },
  ) => void;
  onNodeClick?: (nodeId: string) => void;
  onNodeDoubleClick?: (nodeId: string) => void;
  onPaneClick?: () => void;
  onInit?: (instance: ReactFlowInstance<PNode, Edge>) => void;
  height?: string;
  withMiniMap?: boolean;
}

export function ProcessCanvas(props: ProcessCanvasProps) {
  const { nodes } = props;

  // Соединять можно только совместимые порты (main↔main, ai_model↔ai_model и т.д.).
  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      const src = nodes.find((n) => n.id === c.source)?.data.typeDto;
      const tgt = nodes.find((n) => n.id === c.target)?.data.typeDto;
      if (!src || !tgt) return false;
      const outT = portType(src.outputs.find((o) => o.key === (c.sourceHandle || 'main')) ?? {});
      const tIn = nodeInputs(tgt).find((i) => i.key === (c.targetHandle || 'main'));
      return !!tIn && outT === tIn.type;
    },
    [nodes],
  );

  // Миникарта красит ноды базой тона категории. CSS-переменные тут работают:
  // React Flow кладёт цвет в inline-style прямоугольника, а не в атрибут fill.
  const miniMapNodeColor = useMemo(
    () => (n: PNode) => categoryTone(n.data?.typeDto?.category).base,
    [],
  );

  return (
    <FlowCanvas<PNode, Edge>
      {...props}
      className="pcanvas"
      nodeTypes={NODE_TYPES}
      isValidConnection={isValidConnection}
      miniMapNodeColor={miniMapNodeColor}
    />
  );
}
