'use client';

// Канвас процессов — обёртка над @xyflow/react (MIT; тот же класс канваса, что у
// Langflow/Flowise/Dify; n8n сидит на Vue-собрате). Используется редактором
// (editable) и страницей инстанса (read-only со статусами шагов).
// Скетч-стиль DESIGN.md: поверхности и мягкие тени вместо линий.

import { memo, useCallback, useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { PROCESS_STEP_STATUS_LABELS, type ProcessNodeInput, type ProcessNodeTypeDto } from '@superapp/shared';
import {
  CATEGORY_COLORS,
  PORT_COLORS,
  PORT_LABELS,
  portType,
  STEP_STATUS_BADGE,
  STEP_STATUS_COLORS,
  type PNode,
  type PNodeData,
} from './process-lib';

const HANDLE_STYLE: React.CSSProperties = {
  width: 13,
  height: 13,
  background: 'var(--surface)',
  border: '2.5px solid var(--secondary)',
  borderRadius: '40% 60% 55% 45%',
};

/** Входные порты ноды (по умолчанию: один main; у триггеров/под-нод — пусто). */
function nodeInputs(t: ProcessNodeTypeDto): ProcessNodeInput[] {
  if (t.inputs) return t.inputs;
  if (t.trigger || t.subNode) return [];
  return [{ key: 'main', type: 'main' }];
}

const ProcessNodeView = memo(function ProcessNodeView({ data, selected }: NodeProps<PNode>) {
  const d = data as PNodeData;
  const t = d.typeDto;
  const ringColor = d.stepStatus ? STEP_STATUS_COLORS[d.stepStatus] : null;
  const badge = d.stepStatus ? STEP_STATUS_BADGE[d.stepStatus] : null;
  // Триггеры теперь — полноценные ноды (со своими настройками); точкой остаётся только «Конец».
  const isDot = t.type === 'end';
  return (
    <div
      style={{
        minWidth: isDot ? 132 : 196,
        maxWidth: 250,
        background: 'var(--surface-container-lowest)',
        borderRadius: '0.9rem 0.6rem 1rem 0.7rem',
        padding: '0.7rem 0.9rem',
        boxShadow: selected
          ? '0 0 0 2.5px var(--secondary), 0 10px 26px rgba(198,26,30,0.10)'
          : ringColor
            ? `0 0 0 2.5px ${ringColor}, 0 8px 22px rgba(56,57,45,0.08)`
            : '0 8px 22px rgba(56,57,45,0.10)',
        transform: 'rotate(-0.3deg)',
      }}
    >
      {/* входы: main — слева; типизированные (Модель/Память/Инструменты) — снизу */}
      {(() => {
        const inputs = nodeInputs(t);
        const aiInputs = inputs.filter((i) => i.type !== 'main');
        return (
          <>
            {inputs.some((i) => i.type === 'main') && (
              <Handle id="main" type="target" position={Position.Left} style={{ ...HANDLE_STYLE, left: -7 }} />
            )}
            {aiInputs.map((inp, i) => {
              const left = `${((i + 1) / (aiInputs.length + 1)) * 100}%`;
              const color = PORT_COLORS[inp.type];
              return (
                <Handle key={inp.key} id={inp.key} type="target" position={Position.Bottom} style={{ ...HANDLE_STYLE, bottom: -7, left, borderColor: color }}>
                  <span style={{ position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)', fontSize: '0.58rem', fontWeight: 700, color, pointerEvents: 'none', whiteSpace: 'nowrap' }}>
                    {inp.label ?? PORT_LABELS[inp.type]}
                  </span>
                </Handle>
              );
            })}
          </>
        );
      })()}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
        <div
          style={{
            width: '2rem',
            height: '2rem',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1.05rem',
            background: CATEGORY_COLORS[t.category] ?? 'var(--surface-container)',
            borderRadius: '45% 55% 50% 60%',
            opacity: 0.9,
          }}
        >
          {t.icon}
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            className="title-md"
            style={{ fontSize: '0.86rem', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {d.label}
          </div>
          <div className="label-md" style={{ fontSize: '0.68rem', opacity: 0.75 }}>
            {t.title}
          </div>
        </div>
      </div>

      {(d.stepStatus || d.stepBadge) && (
        <div
          style={{
            marginTop: '0.45rem',
            display: 'inline-block',
            padding: '0.12rem 0.55rem',
            fontSize: '0.67rem',
            fontWeight: 700,
            color: badge?.fg ?? 'var(--on-surface)',
            background: badge?.bg ?? 'var(--surface-container-high)',
            borderRadius: '0.6rem 0.4rem 0.7rem 0.5rem',
          }}
        >
          {d.stepBadge ?? (d.stepStatus ? PROCESS_STEP_STATUS_LABELS[d.stepStatus] : '')}
        </div>
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
                <Handle key={out.key} id={out.key} type="source" position={Position.Right} style={{ ...HANDLE_STYLE, right: -7, top }}>
                  {out.label && (
                    <span style={{ position: 'absolute', right: 16, top: -6, fontSize: '0.62rem', fontWeight: 700, color: 'var(--secondary)', pointerEvents: 'none', whiteSpace: 'nowrap' }}>{out.label}</span>
                  )}
                </Handle>
              );
            })}
            {aiOuts.map((out, i) => {
              const left = `${((i + 1) / (aiOuts.length + 1)) * 100}%`;
              const color = PORT_COLORS[portType(out)];
              return (
                <Handle key={out.key} id={out.key} type="source" position={Position.Top} style={{ ...HANDLE_STYLE, top: -7, left, borderColor: color }}>
                  <span style={{ position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)', fontSize: '0.56rem', fontWeight: 700, color, pointerEvents: 'none', whiteSpace: 'nowrap' }}>{out.label}</span>
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

function CanvasInner({
  nodes,
  edges,
  editable = false,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onDropNode,
  onConnectEndOnPane,
  onNodeClick,
  onNodeDoubleClick,
  onPaneClick,
  onInit,
  withMiniMap = true,
}: ProcessCanvasProps) {
  const { screenToFlowPosition } = useReactFlow();

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      const type = e.dataTransfer.getData('application/superapp-process-node');
      if (!type || !onDropNode) return;
      e.preventDefault();
      onDropNode(type, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    },
    [onDropNode, screenToFlowPosition],
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      if (!onConnectEndOnPane) return;
      // соединение не состоялось и тянули ИЗ source-порта → пикер «что добавить дальше»
      if (connectionState.isValid || !connectionState.fromNode) return;
      if (connectionState.fromHandle?.type !== 'source') return;
      const { clientX, clientY } =
        'changedTouches' in event ? event.changedTouches[0] : (event as MouseEvent);
      onConnectEndOnPane(
        connectionState.fromNode.id,
        connectionState.fromHandle?.id ?? 'main',
        screenToFlowPosition({ x: clientX, y: clientY }),
        { x: clientX, y: clientY },
      );
    },
    [onConnectEndOnPane, screenToFlowPosition],
  );

  const miniMapNodeColor = useMemo(
    () => (n: PNode) => CATEGORY_COLORS[n.data?.typeDto?.category ?? 'flow'] ?? '#ddd',
    [],
  );

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

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      isValidConnection={isValidConnection}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onConnectEnd={editable ? handleConnectEnd : undefined}
      onNodeClick={(_, node) => onNodeClick?.(node.id)}
      onNodeDoubleClick={(_, node) => onNodeDoubleClick?.(node.id)}
      onPaneClick={onPaneClick}
      onDrop={editable ? handleDrop : undefined}
      onDragOver={editable ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } : undefined}
      onInit={onInit}
      nodesDraggable={editable}
      nodesConnectable={editable}
      elementsSelectable
      deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
      snapToGrid
      snapGrid={[16, 16]}
      minZoom={0.15}
      maxZoom={2}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
      connectionLineStyle={{ stroke: 'var(--secondary)', strokeWidth: 2.5 }}
      proOptions={{ hideAttribution: false }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} color="#bbbaab" />
      <Controls showInteractive={false} position="bottom-left" />
      {withMiniMap && (
        <MiniMap
          pannable
          zoomable
          nodeColor={miniMapNodeColor}
          style={{ background: 'var(--surface)', borderRadius: 12, overflow: 'hidden' }}
          maskColor="rgba(228,228,209,0.55)"
        />
      )}
    </ReactFlow>
  );
}

export function ProcessCanvas(props: ProcessCanvasProps) {
  return (
    <div
      style={{
        height: props.height ?? '62vh',
        background: 'var(--surface-container-low)',
        borderRadius: '1rem 0.7rem 1.1rem 0.8rem',
        overflow: 'hidden',
      }}
    >
      <ReactFlowProvider>
        <CanvasInner {...props} />
      </ReactFlowProvider>
    </div>
  );
}
