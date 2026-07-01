'use client';

// Редактор процесса — полноэкранный канвас (как n8n) + плавающие панели.
// ИСТОЧНИК ПРАВДЫ во время правки — flow-state (applyNodeChanges/applyEdgeChanges):
// драг двигает ноды внутренним механизмом React Flow без пересборки объектов → нет
// мерцания. Документ собирается из flow-state только при сохранении/публикации.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance,
} from '@xyflow/react';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api } from '@/lib/api';
import {
  fetchProcess,
  fetchProcessCredentials,
  fetchProcessNodeTypes,
  processCredentialsKey,
  processesKey,
  processInstancesKey,
  processKey,
  processNodeTypesKey,
  workspaceMembersKey,
} from '@/lib/queries';
import {
  PROCESS_CREDENTIAL_TYPE_LABELS,
  PROCESS_NODE_CATEGORY_LABELS,
  PROCESS_VERSION_STATUS_LABELS,
  type ProcessDocument,
  type ProcessFormField,
  type ProcessNodeField,
  type ProcessNodeTypeDto,
  type ProcessTriggerNodeInfo,
  type ProcessValidationIssue,
  type WorkspaceMember,
} from '@superapp/shared';
import { EntitySelector } from '@/components/EntitySelector';
import type { EntityOption } from '@/lib/entities';
import { ProcessCanvas } from '../ProcessCanvas';
import {
  buildDocument,
  CATEGORY_COLORS,
  docToFlow,
  makeFlowEdge,
  nextEdgeId,
  nextNodeId,
  autoLayout,
  portType,
  type PNode,
} from '../process-lib';

function errText(e: unknown): string {
  const r = e as { response?: { data?: { message?: string; errors?: { message: string }[] } } };
  const data = r.response?.data;
  if (data?.errors?.length) return data.errors.map((x) => x.message).join(' · ');
  return data?.message ?? 'Что-то пошло не так';
}

const CATEGORY_ORDER = ['trigger', 'flow', 'people', 'service', 'ai', 'integration'] as const;

export default function ProcessEditorPage() {
  const { isReady } = useRequireAuth();
  const { id: wsId, defId } = useParams<{ id: string; defId: string }>();
  const router = useRouter();
  const qc = useQueryClient();

  const detailQ = useQuery({
    queryKey: processKey(wsId, defId),
    queryFn: () => fetchProcess(wsId, defId),
    enabled: isReady,
  });
  const typesQ = useQuery({
    queryKey: processNodeTypesKey(wsId),
    queryFn: () => fetchProcessNodeTypes(wsId),
    enabled: isReady,
    staleTime: 5 * 60_000,
  });
  const membersQ = useQuery({
    queryKey: workspaceMembersKey(wsId),
    queryFn: async () => (await api.get(`/workspaces/${wsId}/members`)).data.data as WorkspaceMember[],
    enabled: isReady,
    staleTime: 60_000,
  });

  const detail = detailQ.data;
  const nodeTypes = useMemo(() => typesQ.data ?? [], [typesQ.data]);
  const typeMap = useMemo(() => new Map(nodeTypes.map((t) => [t.type, t])), [nodeTypes]);
  // В пикере «добавить и связать» (тянем провод из выхода) триггеры исключены — у них нет входа.
  const addableTypes = useMemo(() => nodeTypes.filter((t) => !t.trigger), [nodeTypes]);
  const memberOptions: EntityOption[] = useMemo(
    () =>
      (membersQ.data ?? []).map((m) => {
        const [fn, ...rest] = (m.userName || '?').split(' ');
        return {
          type: 'user',
          id: m.userId,
          title: m.userName,
          firstName: m.card?.firstName ?? fn,
          lastName: m.card?.lastName ?? (rest.join(' ') || null),
          role: m.assignments?.[0]?.positionName ?? null,
        } as EntityOption;
      }),
    [membersQ.data],
  );

  // ---- Flow-state (источник правды редактора) ----
  const [nodes, setNodes] = useState<PNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [form, setForm] = useState<ProcessFormField[]>([]);
  const [dirty, setDirty] = useState(false);
  const editSeq = useRef(0); // против гонки «сохранил→onSuccess стёр dirty, а правки уже новые»
  const hydratedKey = useRef<string | null>(null);
  const rfRef = useRef<ReactFlowInstance<PNode, Edge> | null>(null);

  const canEdit = !!detail?.canEdit;

  // Гидрация из сервера: при первой загрузке версии и при чистом состоянии.
  useEffect(() => {
    if (!detail || typeMap.size === 0) return;
    const key = `${detail.id}:${detail.editableVersion}`;
    if (hydratedKey.current === key) return;
    if (dirty && hydratedKey.current !== null) {
      // версия сменилась под несохранёнными правками — не затираем, предупреждаем
      setConflict(true);
      return;
    }
    const flow = docToFlow(detail.document, typeMap);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setForm(detail.document.form);
    setDirty(false);
    setConflict(false);
    hydratedKey.current = key;
  }, [detail, typeMap, dirty]);

  const [conflict, setConflict] = useState(false);
  // Правая панель открывается только когда выбрана нода (модель n8n) — иначе скрыта.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Настройки всего процесса (имя/видимость/креды/архив) — отдельный ящик по кнопке «⚙».
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [picker, setPicker] = useState<{ x: number; y: number; flow: { x: number; y: number }; from: { id: string; port: string } } | null>(null);

  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((kind: 'ok' | 'err', text: string) => {
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    setBanner({ kind, text });
    bannerTimer.current = setTimeout(() => setBanner(null), 4500);
  }, []);
  useEffect(() => () => { if (bannerTimer.current) clearTimeout(bannerTimer.current); }, []);

  const markDirty = useCallback(() => {
    editSeq.current += 1;
    setDirty(true);
  }, []);

  // ---- Изменения канваса ----
  const onNodesChange = useCallback(
    (changes: NodeChange<PNode>[]) => {
      // Старт защищён deletable:false в docToFlow — RF сам не пошлёт его remove.
      const meaningful = changes.some((c) => c.type === 'position' || c.type === 'remove' || c.type === 'add');
      setNodes((ns) => applyNodeChanges(changes, ns));
      if (meaningful) markDirty();
      const removed = changes.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id);
      if (removed.length) {
        setSelectedId((cur) => (cur && removed.includes(cur) ? null : cur));
      }
    },
    [markDirty],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((es) => applyEdgeChanges(changes, es));
      if (changes.some((c) => c.type === 'remove' || c.type === 'add')) markDirty();
    },
    [markDirty],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      const port = c.sourceHandle || 'main';
      const toPort = c.targetHandle || 'main';
      const fromType = nodes.find((n) => n.id === c.source)?.data.typeDto;
      const toTypeDto = nodes.find((n) => n.id === c.target)?.data.typeDto;
      const outType = portType(fromType?.outputs.find((o) => o.key === port) ?? {});
      setEdges((es) => {
        let rest = es;
        if (outType === 'main') {
          // поток: одно ребро на выходной порт (кроме Развилки)
          rest = fromType?.multiOut
            ? es.filter((e) => !(e.source === c.source && (e.sourceHandle || 'main') === port && e.target === c.target))
            : es.filter((e) => !(e.source === c.source && (e.sourceHandle || 'main') === port));
        } else {
          // подключение под-ноды: одно на входной порт агента (кроме Инструментов = multi)
          const inp = (toTypeDto?.inputs ?? []).find((i) => i.key === toPort);
          rest = inp?.multi
            ? es.filter((e) => !(e.target === c.target && (e.targetHandle || 'main') === toPort && e.source === c.source))
            : es.filter((e) => !(e.target === c.target && (e.targetHandle || 'main') === toPort));
        }
        const id = nextEdgeId(new Set(es.map((e) => e.id)));
        return addEdge(makeFlowEdge(id, c.source!, port, c.target!, fromType, toPort), rest);
      });
      markDirty();
    },
    [nodes, markDirty],
  );

  const addNodeAt = useCallback(
    (t: ProcessNodeTypeDto, flowPos: { x: number; y: number }, connectFrom?: { id: string; port: string }) => {
      const id = nextNodeId(t.type, new Set(nodes.map((n) => n.id)));
      const node: PNode = {
        id,
        type: 'pnode',
        position: { x: Math.round(flowPos.x), y: Math.round(flowPos.y) },
        data: { label: t.title, config: {}, typeDto: t },
      };
      setNodes((ns) => [...ns, node]);
      if (connectFrom) {
        setEdges((es) => {
          const rest = es.filter((e) => !(e.source === connectFrom.id && (e.sourceHandle || 'main') === connectFrom.port));
          const eid = nextEdgeId(new Set(es.map((e) => e.id)));
          const fromType = nodes.find((n) => n.id === connectFrom.id)?.data.typeDto;
          return addEdge(makeFlowEdge(eid, connectFrom.id, connectFrom.port, id, fromType), rest);
        });
      }
      setSelectedId(id);
      setSettingsOpen(false);
      markDirty();
    },
    [nodes, markDirty],
  );

  // Клик по ноде в палитре → добавить в центр текущего вида.
  const addNodeCentered = useCallback(
    (t: ProcessNodeTypeDto) => {
      const pos = rfRef.current
        ? rfRef.current.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
        : { x: 300, y: 200 };
      addNodeAt(t, pos);
    },
    [addNodeAt],
  );

  const updateNode = useCallback(
    (id: string, patch: Partial<PNode['data']>) => {
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
      markDirty();
    },
    [markDirty],
  );

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
      setSelectedId((cur) => (cur === id ? null : cur));
      markDirty();
    },
    [markDirty],
  );

  const currentDocument = useCallback((): ProcessDocument => buildDocument(nodes, edges, form), [nodes, edges, form]);

  // ---- Мутации ----
  const saveMut = useMutation({
    mutationFn: async (doc: ProcessDocument) =>
      (await api.put(`/workspaces/${wsId}/processes/${defId}/document`, { document: doc })).data.data as {
        version: number;
        issues: ProcessValidationIssue[];
      },
    onSuccess: (res, _doc, ctx) => {
      // dirty снимаем только если с момента отправки правок не было.
      if ((ctx as { seq: number }).seq === editSeq.current) setDirty(false);
      hydratedKey.current = `${defId}:${res.version}`;
      void qc.invalidateQueries({ queryKey: processKey(wsId, defId) });
      void qc.invalidateQueries({ queryKey: processesKey(wsId) });
      flash('ok', res.issues.length === 0 ? 'Сохранено — ошибок нет' : `Сохранено · проблем: ${res.issues.length}`);
    },
    onMutate: () => ({ seq: editSeq.current }),
    onError: (e) => flash('err', errText(e)),
  });

  const publishMut = useMutation({
    mutationFn: async () => {
      const seq = editSeq.current;
      if (dirty) {
        await api.put(`/workspaces/${wsId}/processes/${defId}/document`, { document: currentDocument() });
        if (seq === editSeq.current) setDirty(false);
      }
      return (await api.post(`/workspaces/${wsId}/processes/${defId}/publish`)).data.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: processKey(wsId, defId) });
      void qc.invalidateQueries({ queryKey: processesKey(wsId) });
      flash('ok', 'Опубликовано — процесс можно запускать');
    },
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: processKey(wsId, defId) });
      flash('err', errText(e));
    },
  });

  const metaMut = useMutation({
    mutationFn: async (data: { name?: string; description?: string | null; visibility?: 'team' | 'admins' }) =>
      api.patch(`/workspaces/${wsId}/processes/${defId}`, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: processKey(wsId, defId) });
      void qc.invalidateQueries({ queryKey: processesKey(wsId) });
    },
    onError: (e) => flash('err', errText(e)),
  });

  const archiveMut = useMutation({
    mutationFn: async () => api.delete(`/workspaces/${wsId}/processes/${defId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: processesKey(wsId) });
      router.push(`/workspaces/${wsId}/processes`);
    },
    onError: (e) => flash('err', errText(e)),
  });

  const [startOpen, setStartOpen] = useState(false);

  // ---- Защита от потери правок ----
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const leave = useCallback(() => {
    if (dirty && !confirm('Есть несохранённые изменения. Уйти без сохранения?')) return;
    router.push(`/workspaces/${wsId}/processes`);
  }, [dirty, router, wsId]);

  const onSave = useCallback(() => saveMut.mutate(currentDocument()), [saveMut, currentDocument]);

  // Ctrl+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (canEdit && dirty) onSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [canEdit, dirty, onSave]);

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;
  // Выбор ноды закрывает ящик настроек (показываем панель ноды).
  const selectNode = useCallback((id: string) => { setSelectedId(id); setSettingsOpen(false); }, []);

  if (!isReady || detailQ.isLoading) {
    return <CenteredMsg text="Загрузка…" />;
  }
  if (detailQ.isError || !detail) {
    return (
      <CenteredMsg
        text={errText(detailQ.error) || 'Не удалось открыть процесс'}
        action={{ label: 'К списку', onClick: () => router.push(`/workspaces/${wsId}/processes`) }}
      />
    );
  }

  const issues = detail.issues;

  return (
    // Полноэкранный слой под навбаром организации (z-40 < nav z-50) — простор как в n8n.
    <div style={{ position: 'fixed', inset: 0, top: '3.75rem', zIndex: 40, display: 'flex', flexDirection: 'column', background: 'var(--surface)' }}>
      {/* Тулбар */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap', padding: '0.55rem 1rem', background: 'rgba(245,245,220,0.75)', backdropFilter: 'blur(8px)' }}>
        <button className="label-md" style={{ opacity: 0.75, fontWeight: 600 }} onClick={leave}>← Процессы</button>
        <strong className="title-md" style={{ fontSize: '1rem' }}>{detail.name}</strong>
        <span className="ghost-border label-md" style={{ padding: '0.15rem 0.6rem', fontSize: '0.7rem' }}>
          v{detail.editableVersion} · {PROCESS_VERSION_STATUS_LABELS[detail.editableVersionStatus]}
          {detail.publishedVersion && detail.publishedVersion !== detail.editableVersion ? ` · запуск v${detail.publishedVersion}` : ''}
        </span>
        {dirty && <span className="label-md" style={{ fontSize: '0.72rem', color: 'var(--primary)', fontWeight: 700 }}>● не сохранено</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center' }}>
          <button
            className="btn-secondary"
            style={{ padding: '0.4rem 0.9rem', fontSize: '0.78rem', background: settingsOpen ? 'var(--secondary-container)' : undefined }}
            onClick={() => { setSettingsOpen((v) => !v); setSelectedId(null); }}
            title="Настройки процесса: имя, видимость, креды, архив"
          >
            ⚙ Настройки
          </button>
          {canEdit && (
            <>
              <button className="btn-secondary" style={{ padding: '0.4rem 0.9rem', fontSize: '0.78rem' }} onClick={() => { setNodes((ns) => autoLayout(ns, edges)); markDirty(); }} title="Авто-раскладка">
                ⤢ Разложить
              </button>
              <button
                className="btn-secondary"
                style={{ padding: '0.4rem 0.9rem', fontSize: '0.78rem', opacity: dirty ? 1 : 0.55 }}
                disabled={!dirty || saveMut.isPending}
                onClick={onSave}
              >
                {saveMut.isPending ? 'Сохраняю…' : dirty ? 'Сохранить (Ctrl+S)' : 'Сохранено'}
              </button>
              <button className="btn-primary" style={{ padding: '0.4rem 1rem', fontSize: '0.78rem' }} disabled={publishMut.isPending} onClick={() => publishMut.mutate()}>
                Опубликовать
              </button>
            </>
          )}
          {detail.canStart && (
            <button className="btn-primary" style={{ padding: '0.4rem 1rem', fontSize: '0.78rem' }} onClick={() => setStartOpen(true)}>▶ Запустить</button>
          )}
        </div>
      </div>

      {banner && (
        <div style={{ position: 'absolute', top: '3.6rem', left: '50%', transform: 'translateX(-50%)', zIndex: 60, padding: '0.5rem 1.1rem', borderRadius: '0.8rem 0.5rem 0.9rem 0.6rem', background: banner.kind === 'ok' ? '#dff0e4' : 'var(--primary-container)', boxShadow: '0 8px 22px rgba(56,57,45,0.14)' }}>
          <span className="label-md" style={{ fontWeight: 700, fontSize: '0.82rem' }}>{banner.text}</span>
        </div>
      )}
      {conflict && (
        <div style={{ position: 'absolute', top: '3.6rem', left: '50%', transform: 'translateX(-50%)', zIndex: 60, padding: '0.5rem 1.1rem', borderRadius: '0.8rem', background: 'var(--primary-container)', boxShadow: '0 8px 22px rgba(56,57,45,0.14)' }}>
          <span className="label-md" style={{ fontWeight: 700, fontSize: '0.8rem' }}>Процесс изменён в другом месте. </span>
          <button className="label-md" style={{ fontWeight: 700, fontSize: '0.8rem', color: 'var(--secondary)' }} onClick={() => { hydratedKey.current = null; setDirty(false); setConflict(false); void detailQ.refetch(); }}>Загрузить заново</button>
        </div>
      )}

      {/* Канвас + плавающие панели */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <ProcessCanvas
          nodes={nodes}
          edges={edges}
          editable={canEdit}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onDropNode={(type, pos) => {
            const t = typeMap.get(type);
            if (t) addNodeAt(t, pos);
          }}
          onConnectEndOnPane={(fromNodeId, fromPort, flowPos, screenPos) =>
            setPicker({ x: screenPos.x, y: screenPos.y, flow: flowPos, from: { id: fromNodeId, port: fromPort } })
          }
          onNodeClick={selectNode}
          onNodeDoubleClick={selectNode}
          onPaneClick={() => setSelectedId(null)}
          onInit={(inst) => { rfRef.current = inst; }}
          height="100%"
        />

        {/* Палитра (плавающая, сворачиваемая) */}
        {canEdit && (
          <div style={{ position: 'absolute', top: '0.8rem', left: '0.8rem', width: paletteOpen ? '12rem' : 'auto', maxHeight: 'calc(100% - 1.6rem)', overflowY: 'auto', background: 'var(--surface-container-lowest)', borderRadius: '0.9rem 0.6rem 1rem 0.7rem', boxShadow: '0 10px 26px rgba(56,57,45,0.12)', padding: paletteOpen ? '0.7rem' : '0.4rem' }}>
            <button className="title-md" style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem', width: '100%' }} onClick={() => setPaletteOpen((v) => !v)}>
              <span>{paletteOpen ? '◀' : '▶'}</span>{paletteOpen && <span>Ноды</span>}
            </button>
            {paletteOpen &&
              CATEGORY_ORDER.filter((cat) => nodeTypes.some((t) => t.category === cat)).map((cat) => (
                <div key={cat} style={{ marginTop: 'var(--spacing-3)' }}>
                  <div className="label-md" style={{ fontSize: '0.64rem', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.3rem', paddingLeft: '0.2rem' }}>
                    {PROCESS_NODE_CATEGORY_LABELS[cat]}
                  </div>
                  {nodeTypes.filter((t) => t.category === cat).map((t) => (
                    <button
                      key={t.type}
                      draggable
                      onDragStart={(e) => { e.dataTransfer.setData('application/superapp-process-node', t.type); e.dataTransfer.effectAllowed = 'move'; }}
                      onClick={() => addNodeCentered(t)}
                      title={`${t.description}\n(перетащите на холст или кликните)`}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', padding: '0.4rem 0.5rem', marginBottom: '0.3rem', background: 'var(--surface-container)', borderRadius: '0.7rem 0.5rem 0.8rem 0.55rem', cursor: 'grab', textAlign: 'left' }}
                    >
                      <span style={{ width: '1.5rem', height: '1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', background: CATEGORY_COLORS[cat], borderRadius: '45% 55% 50% 60%' }}>{t.icon}</span>
                      <span className="label-md" style={{ fontSize: '0.77rem', fontWeight: 600, color: 'var(--on-surface)' }}>{t.title}</span>
                    </button>
                  ))}
                </div>
              ))}
            {paletteOpen && nodes.length <= 2 && (
              <p className="label-md" style={{ fontSize: '0.64rem', opacity: 0.65, marginTop: 'var(--spacing-3)', paddingLeft: '0.2rem' }}>
                Перетащите ноду на холст. Соедините точки-порты. Из порта в пустоту — быстрый выбор следующей ноды.
              </p>
            )}
          </div>
        )}

        {/* Правая панель: настройки ВЫБРАННОЙ ноды (по клику) ИЛИ настройки процесса (кнопка ⚙).
            Если ничего не выбрано и настройки закрыты — панели нет (холст во весь экран). */}
        {(settingsOpen || selectedNode) && (
          <div style={{ position: 'absolute', top: '0.8rem', right: '0.8rem', bottom: '0.8rem', width: '20rem', display: 'flex', flexDirection: 'column', background: 'var(--surface-container-lowest)', borderRadius: '0.9rem 0.6rem 1rem 0.7rem', boxShadow: '0 10px 26px rgba(56,57,45,0.12)', overflow: 'hidden' }}>
            <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--spacing-4)' }}>
              {settingsOpen ? (
                <ProcessPanel
                  wsId={wsId}
                  detail={detail}
                  readOnly={!canEdit}
                  onClose={() => setSettingsOpen(false)}
                  onMeta={(data) => metaMut.mutate(data)}
                  onArchive={() => { if (confirm('Архивировать процесс? Он исчезнет из списка (запущенные блокируют).')) archiveMut.mutate(); }}
                />
              ) : selectedNode ? (
                <NodePanel
                  key={selectedNode.id}
                  wsId={wsId}
                  node={selectedNode}
                  form={form}
                  triggerInfo={detail.triggers.find((t) => t.nodeId === selectedNode.id) ?? null}
                  memberOptions={memberOptions}
                  readOnly={!canEdit}
                  onChange={(patch) => updateNode(selectedNode.id, patch)}
                  onFormChange={(f) => { setForm(f); markDirty(); }}
                  onClose={() => setSelectedId(null)}
                  onDelete={() => deleteNode(selectedNode.id)}
                />
              ) : null}
            </div>
          </div>
        )}

        {/* Проблемы публикации — плавающая карточка снизу по центру (видна всегда, когда есть) */}
        {issues.length > 0 && (
          <div style={{ position: 'absolute', bottom: '0.8rem', left: '50%', transform: 'translateX(-50%)', zIndex: 20, width: '30rem', maxWidth: 'calc(100% - 2rem)', maxHeight: '11rem', overflowY: 'auto', padding: '0.6rem 0.95rem', background: 'var(--surface-container)', borderRadius: '0.9rem 0.6rem 1rem 0.7rem', boxShadow: '0 10px 26px rgba(56,57,45,0.16)' }}>
            <div className="title-md" style={{ fontSize: '0.78rem', marginBottom: '0.3rem' }}>⚠ Мешает публикации · {issues.length}</div>
            {issues.map((iss, i) => (
              <button key={i} className="label-md" style={{ display: 'block', fontSize: '0.74rem', padding: '0.1rem 0', color: 'var(--primary)', textAlign: 'left' }} onClick={() => iss.nodeId && selectNode(iss.nodeId)}>• {iss.message}</button>
            ))}
            {dirty && <p className="label-md" style={{ fontSize: '0.66rem', opacity: 0.6 }}>Сохраните, чтобы перепроверить.</p>}
          </div>
        )}

        {/* Пикер «что добавить» при броске провода в пустоту */}
        {picker && (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 70 }} onClick={() => setPicker(null)} />
            <div style={{ position: 'fixed', left: Math.min(picker.x, window.innerWidth - 200), top: Math.min(picker.y, window.innerHeight - 260), zIndex: 71, width: '11rem', maxHeight: '15rem', overflowY: 'auto', background: 'var(--surface-container-lowest)', borderRadius: '0.8rem 0.5rem 0.9rem 0.6rem', boxShadow: '0 12px 30px rgba(56,57,45,0.18)', padding: '0.4rem' }}>
              <div className="label-md" style={{ fontSize: '0.66rem', opacity: 0.7, padding: '0.2rem 0.4rem' }}>Добавить и связать</div>
              {addableTypes.map((t) => (
                <button key={t.type} onClick={() => { addNodeAt(t, picker.flow, picker.from); setPicker(null); }} style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', width: '100%', padding: '0.35rem 0.45rem', borderRadius: '0.6rem', textAlign: 'left' }}>
                  <span style={{ fontSize: '0.85rem' }}>{t.icon}</span>
                  <span className="label-md" style={{ fontSize: '0.76rem', fontWeight: 600, color: 'var(--on-surface)' }}>{t.title}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {startOpen && (
        <StartModal
          wsId={wsId}
          defId={defId}
          name={detail.name}
          form={detail.startForm ?? []}
          onClose={() => setStartOpen(false)}
          onStarted={(instId) => { void qc.invalidateQueries({ queryKey: processInstancesKey(wsId) }); router.push(`/workspaces/${wsId}/processes/instances/${instId}`); }}
        />
      )}
    </div>
  );
}

function CenteredMsg({ text, action }: { text: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--spacing-4)', padding: 'var(--spacing-12)' }}>
      <p className="label-md">{text}</p>
      {action && <button className="btn-secondary" style={{ padding: '0.4rem 1rem' }} onClick={action.onClick}>{action.label}</button>}
    </div>
  );
}

// ---------------------------------------------------------------
// Панель ноды — декларативная форма по паспорту типа (fields)
// ---------------------------------------------------------------

function NodePanel({
  wsId,
  node,
  form,
  triggerInfo,
  memberOptions,
  readOnly,
  onChange,
  onFormChange,
  onClose,
  onDelete,
}: {
  wsId: string;
  node: PNode;
  form: ProcessFormField[];
  triggerInfo: ProcessTriggerNodeInfo | null;
  memberOptions: EntityOption[];
  readOnly: boolean;
  onChange: (patch: Partial<PNode['data']>) => void;
  onFormChange: (form: ProcessFormField[]) => void;
  onClose: () => void;
  onDelete?: () => void;
}) {
  const t = node.data.typeDto;
  const cfg = node.data.config ?? {};
  const setCfg = (key: string, value: unknown) => onChange({ config: { ...cfg, [key]: value } });
  const visible = (f: ProcessNodeField) => !f.showIf || f.showIf.in.includes(String(cfg[f.showIf.field] ?? ''));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span style={{ fontSize: '1.1rem' }}>{t.icon}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="title-md" style={{ fontSize: '0.9rem' }}>{t.title}</div>
          {t.trigger && <div className="label-md" style={{ fontSize: '0.62rem', fontWeight: 700, color: '#9a6a16' }}>ТРИГГЕР ЗАПУСКА</div>}
        </div>
        <button className="label-md" onClick={onClose} title="Закрыть" style={{ fontSize: '1rem', lineHeight: 1, opacity: 0.6, padding: '0.1rem 0.3rem' }}>✕</button>
      </div>
      <p className="label-md" style={{ fontSize: '0.74rem', opacity: 0.8 }}>{t.description}</p>

      <Field label="Подпись на холсте">
        <input className="input-sketch" style={{ width: '100%' }} value={node.data.label ?? ''} disabled={readOnly} onChange={(e) => onChange({ label: e.target.value })} />
      </Field>

      {t.fields.filter(visible).map((f) => (
        <Field key={f.key} label={f.label + (f.required ? ' *' : '')} help={f.help}>
          {f.kind === 'text' && (
            <input className="input-sketch" style={{ width: '100%' }} value={String(cfg[f.key] ?? '')} placeholder={f.placeholder} disabled={readOnly} onChange={(e) => setCfg(f.key, e.target.value)} />
          )}
          {f.kind === 'textarea' && (
            <textarea className="input-sketch" style={{ width: '100%', minHeight: '4.5rem', resize: 'vertical' }} value={String(cfg[f.key] ?? '')} placeholder={f.placeholder} disabled={readOnly} onChange={(e) => setCfg(f.key, e.target.value)} />
          )}
          {f.kind === 'number' && (
            <input className="input-sketch" type="number" style={{ width: '100%' }} value={cfg[f.key] === undefined || cfg[f.key] === '' ? '' : Number(cfg[f.key])} placeholder={f.placeholder} disabled={readOnly} onChange={(e) => setCfg(f.key, e.target.value === '' ? undefined : Number(e.target.value))} />
          )}
          {f.kind === 'select' && (
            <select className="input-sketch" style={{ width: '100%' }} value={String(cfg[f.key] ?? '')} disabled={readOnly} onChange={(e) => setCfg(f.key, e.target.value || undefined)}>
              <option value="">—</option>
              {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
          {f.kind === 'multiselect' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              {(f.options ?? []).map((o) => {
                const arr = Array.isArray(cfg[f.key]) ? (cfg[f.key] as string[]) : [];
                const on = arr.includes(o.value);
                return (
                  <label key={o.value} className="label-md" style={{ fontSize: '0.78rem', display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={readOnly}
                      onChange={(e) => setCfg(f.key, e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value))}
                    />
                    {o.label}
                  </label>
                );
              })}
            </div>
          )}
          {f.kind === 'member' && (
            <EntitySelector value={cfg[f.key] ? [{ type: 'user', id: String(cfg[f.key]) }] : []} onChange={(next) => setCfg(f.key, next[0]?.id)} multi={false} options={memberOptions} placeholder="Выберите сотрудника…" />
          )}
          {f.kind === 'department' && (
            <EntitySelector value={cfg[f.key] ? [{ type: 'department', id: String(cfg[f.key]) }] : []} onChange={(next) => setCfg(f.key, next[0]?.id)} multi={false} types={['department']} context={{ workspaceId: wsId }} placeholder="Выберите отдел…" />
          )}
          {f.kind === 'position' && (
            <EntitySelector value={cfg[f.key] ? [{ type: 'position', id: String(cfg[f.key]) }] : []} onChange={(next) => setCfg(f.key, next[0]?.id)} multi={false} types={['position']} context={{ workspaceId: wsId }} placeholder="Выберите должность…" />
          )}
          {f.kind === 'branch' && (
            <EntitySelector value={cfg[f.key] ? [{ type: 'branch', id: String(cfg[f.key]) }] : []} onChange={(next) => setCfg(f.key, next[0]?.id)} multi={false} types={['branch']} context={{ workspaceId: wsId }} placeholder="Выберите филиал…" />
          )}
          {f.kind === 'credential' && (
            <CredentialField wsId={wsId} value={cfg[f.key] ? String(cfg[f.key]) : ''} disabled={readOnly} onChange={(v) => setCfg(f.key, v || undefined)} />
          )}
          {f.kind === 'formField' && (
            <select className="input-sketch" style={{ width: '100%' }} value={String(cfg[f.key] ?? '')} disabled={readOnly} onChange={(e) => setCfg(f.key, e.target.value || undefined)}>
              <option value="">—</option>
              {form.map((ff) => <option key={ff.key} value={ff.key}>{ff.label} ({ff.key})</option>)}
            </select>
          )}
        </Field>
      ))}

      {/* Веб-хук / Telegram: публичный URL (появляется после публикации) */}
      {(t.type === 'trigger.webhook' || t.type === 'trigger.telegram') && (
        <Field
          label={t.type === 'trigger.telegram' ? 'Адрес вебхука бота' : 'URL вебхука'}
          help={
            t.type === 'trigger.telegram'
              ? 'После публикации бот подключается автоматически (нужен публичный API-адрес). На localhost задайте этот адрес боту вручную через setWebhook.'
              : 'Внешняя система (Kaspi, 1С, сайт…) вызывает этот адрес методом POST — процесс запускается. Тело запроса попадает в анкету.'
          }
        >
          {triggerInfo?.webhookUrl ? (
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <input className="input-sketch" style={{ flex: 1, fontSize: '0.68rem' }} value={triggerInfo.webhookUrl} readOnly onFocus={(e) => e.currentTarget.select()} />
              <button className="btn-secondary" style={{ padding: '0.3rem 0.6rem', fontSize: '0.72rem' }} onClick={() => navigator.clipboard?.writeText(triggerInfo.webhookUrl!)}>Копировать</button>
            </div>
          ) : (
            <p className="label-md" style={{ fontSize: '0.72rem', opacity: 0.7 }}>URL появится после публикации процесса.</p>
          )}
        </Field>
      )}

      {/* Telegram-триггер: какие переменные доступны дальше + как ответить */}
      {t.type === 'trigger.telegram' && (
        <div style={{ padding: '0.65rem 0.75rem', background: 'var(--surface-container)', borderRadius: '0.7rem 0.5rem 0.8rem 0.55rem' }}>
          <div className="label-md" style={{ fontSize: '0.68rem', fontWeight: 700, marginBottom: '0.25rem' }}>Доступно следующим нодам:</div>
          <div className="label-md" style={{ fontSize: '0.68rem', opacity: 0.85, lineHeight: 1.6 }}>
            <code>{'{{form.text}}'}</code> — текст · <code>{'{{form.chatId}}'}</code> — чат · <code>{'{{form.fromName}}'}</code> — имя
          </div>
          <div className="label-md" style={{ fontSize: '0.66rem', opacity: 0.7, marginTop: '0.4rem' }}>
            Чтобы ответить: добавьте ноду «Telegram» (тот же кред-токен), Chat ID = <code>{'{{form.chatId}}'}</code>, Текст = ответ AI-Агента.
          </div>
        </div>
      )}

      {/* Запуск вручную: анкета, которую инициатор заполняет при старте (модель Form Trigger n8n) */}
      {t.type === 'start' && (
        <div style={{ marginTop: '0.2rem', padding: '0.75rem', background: 'var(--surface-container)', borderRadius: '0.8rem 0.55rem 0.9rem 0.6rem' }}>
          <div className="title-md" style={{ fontSize: '0.82rem', marginBottom: '0.25rem' }}>📋 Анкета запуска</div>
          <p className="label-md" style={{ fontSize: '0.68rem', opacity: 0.7, marginBottom: '0.55rem' }}>Поля, которые инициатор заполняет при нажатии «Запустить». Доступны нодам как {'{{form.ключ}}'}.</p>
          <FormPanel form={form} readOnly={readOnly} onChange={onFormChange} />
        </div>
      )}

      {!readOnly && onDelete && (
        <button className="label-md" style={{ color: 'var(--primary)', fontWeight: 700, textAlign: 'left', fontSize: '0.78rem' }} onClick={onDelete}>✕ Удалить ноду</button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// Анкета процесса
// ---------------------------------------------------------------

const FORM_TYPES: { value: ProcessFormField['type']; label: string }[] = [
  { value: 'text', label: 'Текст' },
  { value: 'number', label: 'Число' },
  { value: 'boolean', label: 'Да/Нет' },
  { value: 'date', label: 'Дата' },
  { value: 'select', label: 'Список' },
];

function FormPanel({ form, readOnly, onChange }: { form: ProcessFormField[]; readOnly: boolean; onChange: (form: ProcessFormField[]) => void }) {
  const setField = (i: number, patch: Partial<ProcessFormField>) => onChange(form.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const keyCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of form) m.set(f.key, (m.get(f.key) ?? 0) + 1);
    return m;
  }, [form]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
      <p className="label-md" style={{ fontSize: '0.74rem', opacity: 0.8 }}>Анкета заполняется при запуске. Поля доступны нодам как {'{{form.ключ}}'} и в условиях «Если».</p>
      {form.map((f, i) => (
        <div key={i} className="ghost-border" style={{ padding: '0.7rem' }}>
          <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.4rem' }}>
            <input className="input-sketch" style={{ flex: 2 }} value={f.label} placeholder="Название поля" disabled={readOnly} onChange={(e) => setField(i, { label: e.target.value })} />
            <input className="input-sketch" style={{ flex: 1, fontSize: '0.74rem' }} value={f.key} placeholder="ключ" disabled={readOnly} onChange={(e) => setField(i, { key: e.target.value.replace(/[^a-zA-Z0-9_-]/g, '_') })} />
          </div>
          {(keyCounts.get(f.key) ?? 0) > 1 && <p className="label-md" style={{ fontSize: '0.66rem', color: 'var(--primary)' }}>Ключ «{f.key}» повторяется</p>}
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <select className="input-sketch" style={{ flex: 1 }} value={f.type} disabled={readOnly} onChange={(e) => setField(i, { type: e.target.value as ProcessFormField['type'] })}>
              {FORM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <label className="label-md" style={{ fontSize: '0.72rem', display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
              <input type="checkbox" checked={!!f.required} disabled={readOnly} onChange={(e) => setField(i, { required: e.target.checked })} /> обяз.
            </label>
            {!readOnly && <button className="label-md" style={{ color: 'var(--primary)', fontWeight: 700 }} onClick={() => onChange(form.filter((_, idx) => idx !== i))}>✕</button>}
          </div>
          {f.type === 'select' && (
            <input className="input-sketch" style={{ width: '100%', marginTop: '0.4rem', fontSize: '0.76rem' }} value={(f.options ?? []).join(', ')} placeholder="Варианты через запятую" disabled={readOnly} onChange={(e) => setField(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
          )}
        </div>
      ))}
      {!readOnly && (
        <button className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.78rem' }} onClick={() => onChange([...form, { key: `field_${form.length + 1}`, label: '', type: 'text' }])}>+ Поле анкеты</button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// Панель процесса
// ---------------------------------------------------------------

function ProcessPanel({
  wsId,
  detail,
  readOnly,
  onClose,
  onMeta,
  onArchive,
}: {
  wsId: string;
  detail: { name: string; description: string | null; visibility: 'team' | 'admins'; versions: { version: number; status: string; publishedAt: string | null }[] };
  readOnly: boolean;
  onClose: () => void;
  onMeta: (data: { name?: string; description?: string | null; visibility?: 'team' | 'admins' }) => void;
  onArchive: () => void;
}) {
  const [name, setName] = useState(detail.name);
  const [description, setDescription] = useState(detail.description ?? '');
  useEffect(() => { setName(detail.name); setDescription(detail.description ?? ''); }, [detail.name, detail.description]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="title-md" style={{ fontSize: '0.9rem' }}>⚙ Настройки процесса</div>
        <button className="label-md" onClick={onClose} title="Закрыть" style={{ fontSize: '1rem', lineHeight: 1, opacity: 0.6, padding: '0.1rem 0.3rem' }}>✕</button>
      </div>
      <Field label="Название">
        <input className="input-sketch" style={{ width: '100%' }} value={name} disabled={readOnly} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== detail.name && onMeta({ name: name.trim() })} />
      </Field>
      <Field label="Описание">
        <textarea className="input-sketch" style={{ width: '100%', minHeight: '3.6rem', resize: 'vertical' }} value={description} disabled={readOnly} onChange={(e) => setDescription(e.target.value)} onBlur={() => description !== (detail.description ?? '') && onMeta({ description: description || null })} />
      </Field>
      <Field label="Кому виден" help="«Только админы» — процессы для разработчиков/руководства">
        <select className="input-sketch" style={{ width: '100%' }} value={detail.visibility} disabled={readOnly} onChange={(e) => onMeta({ visibility: e.target.value as 'team' | 'admins' })}>
          <option value="team">Вся команда</option>
          <option value="admins">Только админы</option>
        </select>
      </Field>
      <div>
        <div className="label-md" style={{ fontSize: '0.72rem', marginBottom: '0.3rem' }}>Версии</div>
        {detail.versions.map((v) => (
          <div key={v.version} className="label-md" style={{ fontSize: '0.76rem', padding: '0.12rem 0' }}>
            v{v.version} — {PROCESS_VERSION_STATUS_LABELS[v.status] ?? v.status}{v.publishedAt ? ` · ${new Date(v.publishedAt).toLocaleDateString('ru-RU')}` : ''}
          </div>
        ))}
        <p className="label-md" style={{ fontSize: '0.66rem', opacity: 0.65, marginTop: '0.3rem' }}>Запущенные процессы доживают на своей версии — правки им не мешают.</p>
      </div>

      {!readOnly && <CredentialsSection wsId={wsId} />}

      {!readOnly && (
        <button className="label-md" style={{ color: 'var(--primary)', fontWeight: 700, textAlign: 'left', fontSize: '0.78rem' }} onClick={onArchive}>🗂 Архивировать процесс</button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// Ф3: сейф кредов (организация)
// ---------------------------------------------------------------

function CredentialsSection({ wsId }: { wsId: string }) {
  const qc = useQueryClient();
  const { data: creds } = useQuery({ queryKey: processCredentialsKey(wsId), queryFn: () => fetchProcessCredentials(wsId), staleTime: 30_000 });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({ name: '', type: 'bearer' });
  const [err, setErr] = useState<string | null>(null);
  const inval = () => qc.invalidateQueries({ queryKey: processCredentialsKey(wsId) });
  const addMut = useMutation({
    mutationFn: async () => api.post(`/workspaces/${wsId}/processes/credentials`, form),
    onSuccess: () => { setAdding(false); setForm({ name: '', type: 'bearer' }); setErr(null); inval(); },
    onError: (e) => setErr(errText(e)),
  });
  const delMut = useMutation({ mutationFn: async (id: string) => api.delete(`/workspaces/${wsId}/processes/credentials/${id}`), onSuccess: inval });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div>
      <div className="label-md" style={{ fontSize: '0.72rem', fontWeight: 700, marginBottom: '0.3rem' }}>Креды для HTTP-нод</div>
      {(creds ?? []).map((c) => (
        <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.2rem 0' }}>
          <span className="label-md" style={{ fontSize: '0.76rem' }}>🔑 {c.name} <span style={{ opacity: 0.6 }}>· {c.type}</span></span>
          <button className="label-md" style={{ fontSize: '0.7rem', color: 'var(--primary)' }} onClick={() => delMut.mutate(c.id)}>✕</button>
        </div>
      ))}
      {adding ? (
        <div className="ghost-border" style={{ padding: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <input className="input-sketch" placeholder="Название" value={form.name} onChange={(e) => set('name', e.target.value)} />
          <select className="input-sketch" value={form.type} onChange={(e) => set('type', e.target.value)}>
            {Object.entries(PROCESS_CREDENTIAL_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {form.type === 'bearer' && <input className="input-sketch" placeholder="Токен" value={form.token ?? ''} onChange={(e) => set('token', e.target.value)} />}
          {form.type === 'basic' && (<><input className="input-sketch" placeholder="Логин" value={form.username ?? ''} onChange={(e) => set('username', e.target.value)} /><input className="input-sketch" type="password" placeholder="Пароль" value={form.password ?? ''} onChange={(e) => set('password', e.target.value)} /></>)}
          {form.type === 'header' && (<><input className="input-sketch" placeholder="Имя заголовка (напр. X-Auth-Token)" value={form.headerName ?? ''} onChange={(e) => set('headerName', e.target.value)} /><input className="input-sketch" placeholder="Значение" value={form.headerValue ?? ''} onChange={(e) => set('headerValue', e.target.value)} /></>)}
          {err && <p className="label-md" style={{ fontSize: '0.7rem', color: 'var(--primary)' }}>{err}</p>}
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <button className="btn-primary" style={{ padding: '0.3rem 0.9rem', fontSize: '0.74rem' }} disabled={!form.name || addMut.isPending} onClick={() => addMut.mutate()}>Сохранить</button>
            <button className="btn-secondary" style={{ padding: '0.3rem 0.8rem', fontSize: '0.74rem' }} onClick={() => setAdding(false)}>Отмена</button>
          </div>
        </div>
      ) : (
        <button className="btn-secondary" style={{ padding: '0.3rem 0.9rem', fontSize: '0.74rem' }} onClick={() => setAdding(true)}>+ Креды</button>
      )}
    </div>
  );
}

function CredentialField({ wsId, value, disabled, onChange }: { wsId: string; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const { data: creds } = useQuery({ queryKey: processCredentialsKey(wsId), queryFn: () => fetchProcessCredentials(wsId), staleTime: 30_000 });
  return (
    <select className="input-sketch" style={{ width: '100%' }} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">— без кредов —</option>
      {(creds ?? []).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.type})</option>)}
    </select>
  );
}

// ---------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------

function StartModal({ wsId, defId, name, form, onClose, onStarted }: { wsId: string; defId: string; name: string; form: ProcessFormField[]; onClose: () => void; onStarted: (instanceId: string) => void }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true); setError(null);
    try {
      const res = await api.post(`/workspaces/${wsId}/processes/${defId}/start`, { input: values });
      onStarted((res.data.data as { id: string }).id);
    } catch (e) { setError(errText(e)); setBusy(false); }
  };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(56,57,45,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }} onClick={onClose}>
      <div className="card-elevated" style={{ width: '26rem', maxWidth: '100%', maxHeight: '85vh', overflowY: 'auto', background: 'var(--surface)' }} onClick={(e) => e.stopPropagation()}>
        <div className="title-lg" style={{ fontSize: '1.1rem', marginBottom: 'var(--spacing-4)' }}>▶ Запустить «{name}»</div>
        {form.length === 0 && <p className="label-md" style={{ marginBottom: 'var(--spacing-4)' }}>Анкета не требуется — процесс стартует сразу.</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
          {form.map((f) => (
            <Field key={f.key} label={f.label + (f.required ? ' *' : '')}>
              {f.type === 'text' && <input className="input-sketch" style={{ width: '100%' }} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />}
              {f.type === 'number' && <input className="input-sketch" type="number" style={{ width: '100%' }} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />}
              {f.type === 'date' && <input className="input-sketch" type="date" style={{ width: '100%' }} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />}
              {f.type === 'boolean' && <label className="label-md" style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}><input type="checkbox" onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.checked }))} /> да</label>}
              {f.type === 'select' && (
                <select className="input-sketch" style={{ width: '100%' }} defaultValue="" onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}>
                  <option value="" disabled>Выберите…</option>
                  {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              )}
            </Field>
          ))}
        </div>
        {error && <p className="label-md" style={{ color: 'var(--primary)', marginTop: 'var(--spacing-3)' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', marginTop: 'var(--spacing-6)' }}>
          <button className="btn-primary" style={{ padding: '0.5rem 1.3rem' }} disabled={busy} onClick={start}>{busy ? 'Запускаю…' : 'Запустить'}</button>
          <button className="btn-secondary" style={{ padding: '0.5rem 1rem' }} onClick={onClose}>Отмена</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label-md" style={{ display: 'block', fontSize: '0.72rem', marginBottom: '0.3rem' }}>{label}</label>
      {children}
      {help && <p className="label-md" style={{ fontSize: '0.64rem', opacity: 0.65, marginTop: '0.25rem' }}>{help}</p>}
    </div>
  );
}
