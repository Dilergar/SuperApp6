'use client';

// ============================================================
// FlowCanvas — общая обёртка над @xyflow/react (MIT; тот же класс канваса, что у
// Langflow/Flowise/Dify). Один провайдер, одно полотно в фирменном стиле
// (точки-фон, контролы, миникарта, линия соединения), а НОДЫ и ЖЕСТЫ приносит
// потребитель: Процессы (редактор + read-only инстанс) и Орг. структура.
//
// Извлечено из ProcessCanvas.tsx без изменения поведения: дефолты пропсов равны
// тем, что стояли там (snap 16, zoom 0.15–2, fitView padding 0.2 / maxZoom 1).
// Специфичное для Процессов (дроп из палитры, провод-в-пустоту → пикер) —
// опциональные пропсы: без них обработчики не вешаются.
//
// CSS: стили библиотеки → общий canvas.css (только .react-flow__*) — порядок
// импортов несущий; свои ноды потребитель красит у себя через className-алиас
// (.pcanvas / .ocanvas) на том же корневом элементе.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeTypes,
  type FinalConnectionState,
  type FitViewOptions,
  type IsValidConnection,
  type KeyCode,
  type Node,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance,
  type XYPosition,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
// Порядок важен: наши правила должны идти ПОСЛЕ стилей библиотеки.
import './canvas.css';
import { cx } from '@/components/ui';

/** MIME-ключ dataTransfer при перетаскивании ноды из палитры (Процессы). */
export const CANVAS_DROP_MIME = 'application/superapp-process-node';

export interface FlowCanvasProps<N extends Node = Node, E extends Edge = Edge> {
  nodes: N[];
  edges: E[];
  nodeTypes: NodeTypes;
  edgeTypes?: EdgeTypes;
  /** Редактирование: перетаскивание, соединение, удаление клавишей — одним флагом. */
  editable?: boolean;
  /** Точечные переопределения флага editable. */
  nodesDraggable?: boolean;
  nodesConnectable?: boolean;
  deleteKeyCode?: KeyCode | null;
  onNodesChange?: (changes: NodeChange<N>[]) => void;
  onEdgesChange?: (changes: EdgeChange<E>[]) => void;
  onConnect?: (connection: Connection) => void;
  isValidConnection?: IsValidConnection<E>;
  /** Дроп ноды из палитры: тип + позиция в координатах канваса (Процессы). */
  onDropNode?: (type: string, position: XYPosition) => void;
  /** Бросили провод в пустоту (жест n8n): открыть пикер нод в этой точке. */
  onConnectEndOnPane?: (
    fromNodeId: string,
    fromPort: string,
    flowPosition: XYPosition,
    screenPosition: XYPosition,
  ) => void;
  onNodeClick?: (nodeId: string) => void;
  onNodeDoubleClick?: (nodeId: string) => void;
  /** Тащат ноду: нода + её АБСОЛЮТНАЯ позиция (подсветка цели дропа). */
  onNodeDrag?: (node: N, absolute: XYPosition) => void;
  /** Отпустили ноду после перетаскивания: нода + её АБСОЛЮТНАЯ позиция (с учётом родителя). */
  onNodeDragStop?: (node: N, absolute: XYPosition) => void;
  onPaneClick?: () => void;
  onInit?: (instance: ReactFlowInstance<N, E>) => void;
  snapToGrid?: boolean;
  minZoom?: number;
  maxZoom?: number;
  fitViewOptions?: FitViewOptions;
  /** Рисовать только видимые ноды/рёбра (большие схемы). */
  onlyRenderVisibleElements?: boolean;
  /** Поднимать выбранную ноду над остальными (выкл. для схем с рамками-группами). */
  elevateNodesOnSelect?: boolean;
  height?: string;
  withMiniMap?: boolean;
  /** Цвет ноды на миникарте (CSS-переменная годится: библиотека пишет inline-style). */
  miniMapNodeColor?: (node: N) => string;
  /** Алиас потребителя на корневом элементе (.pcanvas / .ocanvas) — для стилей своих нод. */
  className?: string;
  /** Плавающие панели поверх полотна (внутри провайдера React Flow). */
  children?: ReactNode;
}

function CanvasInner<N extends Node, E extends Edge>({
  nodes,
  edges,
  nodeTypes,
  edgeTypes,
  editable = false,
  nodesDraggable,
  nodesConnectable,
  deleteKeyCode,
  onNodesChange,
  onEdgesChange,
  onConnect,
  isValidConnection,
  onDropNode,
  onConnectEndOnPane,
  onNodeClick,
  onNodeDoubleClick,
  onNodeDrag,
  onNodeDragStop,
  onPaneClick,
  onInit,
  snapToGrid = true,
  minZoom = 0.15,
  maxZoom = 2,
  fitViewOptions,
  onlyRenderVisibleElements,
  elevateNodesOnSelect,
  withMiniMap = true,
  miniMapNodeColor,
  children,
}: FlowCanvasProps<N, E>) {
  const { screenToFlowPosition, getInternalNode } = useReactFlow<N, E>();

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      const type = e.dataTransfer.getData(CANVAS_DROP_MIME);
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

  const handleDrag = useCallback(
    (_: unknown, node: N) => {
      if (!onNodeDrag) return;
      onNodeDrag(node, getInternalNode(node.id)?.internals.positionAbsolute ?? node.position);
    },
    [onNodeDrag, getInternalNode],
  );

  const handleDragStop = useCallback(
    (_: unknown, node: N) => {
      if (!onNodeDragStop) return;
      onNodeDragStop(node, getInternalNode(node.id)?.internals.positionAbsolute ?? node.position);
    },
    [onNodeDragStop, getInternalNode],
  );

  const fitOpts = useMemo<FitViewOptions>(() => fitViewOptions ?? { padding: 0.2, maxZoom: 1 }, [fitViewOptions]);

  /**
   * Клавиатура на полотне. React Flow делает узлы ФОКУСИРУЕМЫМИ (`tabindex=0`), но
   * ничего не делает по Enter: выбор висел только на мыши, и все остановки табуляции
   * были пустыми. Enter/Пробел на сфокусированном узле = клик по нему; кнопки и
   * ссылки ВНУТРИ узла («Нанять») обрабатывают клавишу сами.
   *
   * Слушатель вешается НА ОБЁРТКУ в фазе перехвата: свой обработчик React Flow
   * (выделение, удаление) забирает событие раньше реактовского onKeyDown.
   */
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!onNodeClick) return;
    // Слушаем ДОКУМЕНТ в фазе перехвата: обёртку React Flow ref-ом не достать
    // (компонент его не пробрасывает), а собственный обработчик полотна забирает
    // Enter раньше реактовского onKeyDown. Событие фильтруем по своему контейнеру.
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('a, button, input, textarea, select, [role="button"], [contenteditable="true"]')) return;
      const nodeEl = target.closest('.react-flow__node') as HTMLElement | null;
      const id = nodeEl?.getAttribute('data-id');
      if (!id) return;
      const container = wrapRef.current;
      if (container && !container.contains(nodeEl)) return;
      e.preventDefault();
      e.stopPropagation();
      onNodeClick(id);
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [onNodeClick]);

  return (
    <ReactFlow<N, E>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      isValidConnection={isValidConnection}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onConnectEnd={editable && onConnectEndOnPane ? handleConnectEnd : undefined}
      onNodeClick={onNodeClick ? (_, node) => onNodeClick(node.id) : undefined}
      onNodeDoubleClick={onNodeDoubleClick ? (_, node) => onNodeDoubleClick(node.id) : undefined}
      onNodeDrag={onNodeDrag ? handleDrag : undefined}
      onNodeDragStop={onNodeDragStop ? handleDragStop : undefined}
      onPaneClick={onPaneClick}
      onDrop={editable && onDropNode ? handleDrop : undefined}
      onDragOver={editable && onDropNode ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } : undefined}
      onInit={onInit}
      nodesDraggable={nodesDraggable ?? editable}
      nodesConnectable={nodesConnectable ?? editable}
      elementsSelectable
      elevateNodesOnSelect={elevateNodesOnSelect}
      deleteKeyCode={deleteKeyCode !== undefined ? deleteKeyCode : editable ? ['Backspace', 'Delete'] : null}
      snapToGrid={snapToGrid}
      snapGrid={[16, 16]}
      minZoom={minZoom}
      maxZoom={maxZoom}
      onlyRenderVisibleElements={onlyRenderVisibleElements}
      fitView
      fitViewOptions={fitOpts}
      connectionLineStyle={{ stroke: 'var(--primary)', strokeWidth: 2 }}
      proOptions={{ hideAttribution: false }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.4} color="var(--line)" />
      <Controls showInteractive={false} position="bottom-left" />
      {withMiniMap && (
        <MiniMap<N>
          pannable
          zoomable
          nodeColor={miniMapNodeColor}
          nodeStrokeWidth={0}
          nodeBorderRadius={4}
          // Затемнение вне вида задаётся ИНЛАЙНОМ библиотеки и перебило бы CSS,
          // поэтому цвет считается из токена здесь (прозрачности у токена нет).
          maskColor="color-mix(in srgb, var(--surface-container) 62%, transparent)"
        />
      )}
      {children}
    </ReactFlow>
  );
}

export function FlowCanvas<N extends Node = Node, E extends Edge = Edge>(props: FlowCanvasProps<N, E>) {
  return (
    <div className={cx('sa-canvas', props.className)} style={{ height: props.height ?? '62vh' }}>
      <ReactFlowProvider>
        <CanvasInner<N, E> {...props} />
      </ReactFlowProvider>
    </div>
  );
}
