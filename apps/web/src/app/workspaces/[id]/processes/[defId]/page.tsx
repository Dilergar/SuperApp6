'use client';

import {
  Alert, Button, Checkbox, Chip, Field, Icon, IconButton, Input, Modal, Select, Textarea, useConfirm,
} from '@/components/ui';
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
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '@/lib/api';
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
import { useTranslations } from 'next-intl';
import { useFormatters } from '@/lib/format';
import {
  PROCESS_CREDENTIAL_TYPES,
  type ProcessDocument,
  type ProcessFormField,
  type ProcessNodeField,
  type ProcessNodeTypeDto,
  type ProcessTriggerNodeInfo,
  type ProcessValidationIssue,
  type WorkspaceMember,
  type ProcessInstanceDto,
} from '@superapp/shared';
import { EntitySelector } from '@/components/EntitySelector';
import type { EntityOption } from '@/lib/entities';
import { ProcessCanvas } from '../ProcessCanvas';
import {
  buildDocument,
  categoryTone,
  docToFlow,
  makeFlowEdge,
  nextEdgeId,
  nextNodeId,
  nodeIcon,
  autoLayout,
  portType,
  type PNode,
} from '../process-lib';

/**
 * Текст отказа из конверта API — он приходит УЖЕ переведённым в языке запроса.
 * Пусто (сеть легла, чужая форма) — общую фразу подставляет вызывающий: словаря
 * у модульной функции нет.
 */
function errText(e: unknown): string {
  const r = e as { response?: { data?: { message?: string; errors?: { message: string }[] } } };
  const data = r.response?.data;
  if (data?.errors?.length) return data.errors.map((x) => x.message).join(' · ');
  return data?.message ?? '';
}

/**
 * Предупреждения предметной области из отказа публикации. Отличать их от обычной
 * ошибки надо по МАШИННОМУ коду, а не по тексту: правил станет больше, а тексты
 * пишутся для человека и меняются.
 */
function publishWarnings(e: unknown): { ruleKey: string; message: string }[] {
  const data = (e as {
    response?: {
      data?: { details?: { code?: string; warnings?: { ruleKey?: string; message?: string }[] } };
    };
  }).response?.data;
  if (data?.details?.code !== 'process_warnings_unaccepted') return [];
  return (data.details.warnings ?? [])
    .filter((w): w is { ruleKey: string; message: string } => !!w.ruleKey && !!w.message);
}

const CATEGORY_ORDER = ['trigger', 'flow', 'people', 'service', 'ai', 'integration'] as const;

/** Виджеты паспорта, которые рисуют подпись сами (кит связывает label с контролом). */
const SELF_LABELED_FIELDS = new Set<ProcessNodeField['kind']>([
  'text', 'textarea', 'number', 'select', 'credential', 'formField',
]);

export default function ProcessEditorPage() {
  const t = useTranslations('processes');
  const tc = useTranslations('common');
  const { isReady } = useRequireAuth();
  const { id: wsId, defId } = useParams<{ id: string; defId: string }>();
  const router = useRouter();
  const qc = useQueryClient();

  const detailQ = useQuery({
    queryKey: processKey(wsId, defId),
    queryFn: () => fetchProcess(wsId, defId),
    enabled: isReady,
  });
  // Палитра — по ПРОФИЛЮ процесса: у кадрового маршрута она урезана до нужных нод,
  // и ждать её приходится до загрузки самого процесса (профиль лежит в нём).
  const surface = detailQ.data?.surface ?? null;
  const typesQ = useQuery({
    queryKey: processNodeTypesKey(wsId, surface),
    queryFn: () => fetchProcessNodeTypes(wsId, surface),
    enabled: isReady && !!detailQ.data,
    staleTime: 5 * 60_000,
  });
  const membersQ = useQuery({
    queryKey: workspaceMembersKey(wsId),
    queryFn: async () => await apiGet<WorkspaceMember[]>(`/workspaces/${wsId}/members`),
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
  // Предупреждения предметной области, с которыми сервер не пустил публикацию: их
  // показываем поимённо и даём взять риск («Понимаю, публикую» пишется в журнал).
  const [pendingWarnings, setPendingWarnings] = useState<{ ruleKey: string; message: string }[] | null>(null);
  const [confirm, confirmUI] = useConfirm();
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
    mutationFn: (doc: ProcessDocument) =>
      apiPut<{ version: number; issues: ProcessValidationIssue[] }>(
        `/workspaces/${wsId}/processes/${defId}/document`,
        { document: doc },
      ),
    onSuccess: (res, _doc, ctx) => {
      // dirty снимаем только если с момента отправки правок не было.
      if ((ctx as { seq: number }).seq === editSeq.current) setDirty(false);
      hydratedKey.current = `${defId}:${res.version}`;
      void qc.invalidateQueries({ queryKey: processKey(wsId, defId) });
      void qc.invalidateQueries({ queryKey: processesKey(wsId) });
      flash('ok', res.issues.length === 0 ? t('editor.savedClean') : t('editor.savedWithIssues', { count: res.issues.length }));
    },
    onMutate: () => ({ seq: editSeq.current }),
    onError: (e) => flash('err', errText(e) || tc('state.error')),
  });

  const publishMut = useMutation({
    // acceptWarnings — ПОИМЁННОЕ согласие с предупреждениями предметной области
    // (правила кадрового учёта). Пока веб публиковал без него, любой кадровый маршрут
    // упирался в 400 «подтвердите публикацию», а подтвердить было нечем — заготовка
    // из кнопки «Маршрут» не публиковалась вообще никогда.
    mutationFn: async (acceptWarnings?: string[]) => {
      const seq = editSeq.current;
      if (dirty) {
        await apiPut(`/workspaces/${wsId}/processes/${defId}/document`, { document: currentDocument() });
        if (seq === editSeq.current) setDirty(false);
      }
      const body = acceptWarnings?.length ? { acceptWarnings } : {};
      return await apiPost(`/workspaces/${wsId}/processes/${defId}/publish`, body);
    },
    onSuccess: () => {
      setPendingWarnings(null);
      void qc.invalidateQueries({ queryKey: processKey(wsId, defId) });
      void qc.invalidateQueries({ queryKey: processesKey(wsId) });
      flash('ok', t('editor.published'));
    },
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: processKey(wsId, defId) });
      const warnings = publishWarnings(e);
      if (warnings.length) {
        // Не ошибка, а вопрос: показываем ЧТО именно нарушено и даём взять риск.
        setPendingWarnings(warnings);
        return;
      }
      flash('err', errText(e) || tc('state.error'));
    },
  });

  const metaMut = useMutation({
    mutationFn: async (data: { name?: string; description?: string | null; visibility?: 'team' | 'admins' }) =>
      apiPatch(`/workspaces/${wsId}/processes/${defId}`, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: processKey(wsId, defId) });
      void qc.invalidateQueries({ queryKey: processesKey(wsId) });
    },
    onError: (e) => flash('err', errText(e) || tc('state.error')),
  });

  const archiveMut = useMutation({
    mutationFn: async () => apiDelete(`/workspaces/${wsId}/processes/${defId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: processesKey(wsId) });
      router.push(`/workspaces/${wsId}/processes`);
    },
    onError: (e) => flash('err', errText(e) || tc('state.error')),
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
    const go = () => router.push(`/workspaces/${wsId}/processes`);
    if (!dirty) { go(); return; }
    confirm(
      {
        title: t('editor.leaveTitle'),
        message: t('editor.leaveText'),
        confirmLabel: t('editor.leaveConfirm'),
        danger: true,
      },
      go,
    );
  }, [dirty, router, wsId, confirm]);

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
    return <CenteredMsg text={tc('state.loading')} />;
  }
  if (detailQ.isError || !detail) {
    return (
      <CenteredMsg
        text={errText(detailQ.error) || t('editor.openFailed')}
        action={{ label: t('editor.toList'), onClick: () => router.push(`/workspaces/${wsId}/processes`) }}
      />
    );
  }

  const issues = detail.issues;

  return (
    // Полноэкранный слой канваса — общий класс (globals.css): он сам считает
    // топбар и сайдбар каркаса. Инлайновая копия с `inset: 0` тут работала лишь
    // потому, что у редактора процесса сайдбара нет; на схеме оргструктуры та же
    // копия накрыла навигацию.
    <div className="canvas-layer">
      {/* Тулбар — светлый блок с несущим 1px-бордером снизу, как топбар каркаса */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap', padding: '0.5rem var(--spacing-5)', background: 'var(--block)', borderBottom: '1px solid var(--border)' }}>
        <Button variant="ghost" size="sm" icon="arrowLeft" onClick={leave}>
              {t('title')}
            </Button>
        <strong className="title-md">{detail.name}</strong>
        <Chip size="sm" tone="neutral">
          v{detail.editableVersion} · {t(`versionStatus.${detail.editableVersionStatus}`)}
          {detail.publishedVersion && detail.publishedVersion !== detail.editableVersion ? ` · ${t('editor.runsOn', { version: detail.publishedVersion })}` : ''}
        </Chip>
        {dirty && (
              <Chip size="sm" tone="warning" icon="pending">
                {t('editor.unsaved')}
              </Chip>
            )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
          <Button
            variant={settingsOpen ? 'matte' : 'ghost'}
            tone="accent"
            size="sm"
            icon="settings"
            onClick={() => { setSettingsOpen((v) => !v); setSelectedId(null); }}
            title={t('editor.settingsHint')}
          >
            {t('editor.settings')}
          </Button>
          {canEdit && (
            <>
              <Button
                variant="ghost"
                size="sm"
                icon="processes"
                title={t('editor.autoLayout')}
                onClick={() => { setNodes((ns) => autoLayout(ns, edges)); markDirty(); }}
              >
                {t('editor.layout')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                icon="save"
                disabled={!dirty}
                loading={saveMut.isPending}
                onClick={onSave}
              >
                {dirty ? t('editor.save') : t('editor.saved')}
              </Button>
              <Button variant="primary" tone="success" size="sm" icon="uploadCloud" loading={publishMut.isPending} onClick={() => publishMut.mutate(undefined)}>
                {t('editor.publish')}
              </Button>
            </>
          )}
          {detail.canStart && (
            <Button variant="primary" size="sm" icon="play" onClick={() => setStartOpen(true)}>
                {t('editor.start')}
              </Button>
          )}
        </div>
      </div>

      {/* Всплывающие сообщения над канвасом — плашки кита в фиксированной позиции */}
      {banner && (
        <div style={{ position: 'absolute', top: '3.6rem', left: '50%', transform: 'translateX(-50%)', zIndex: 60, maxWidth: 420, boxShadow: 'var(--shadow-pop)' }}>
          <Alert tone={banner.kind === 'ok' ? 'success' : 'danger'}>{banner.text}</Alert>
        </div>
      )}
      {conflict && (
        <div style={{ position: 'absolute', top: '3.6rem', left: '50%', transform: 'translateX(-50%)', zIndex: 60, maxWidth: 460, boxShadow: 'var(--shadow-pop)' }}>
          <Alert
            tone="warning"
            action={
              <Button
                variant="matte"
                tone="warning"
                size="sm"
                icon="refresh"
                onClick={() => { hydratedKey.current = null; setDirty(false); setConflict(false); void detailQ.refetch(); }}
              >
                {t('editor.reload')}
              </Button>
            }
          >
            {t('editor.changedElsewhere')}
          </Alert>
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
          <div className="pfloat ppalette" style={{ width: paletteOpen ? '13.5rem' : 'auto' }}>
            <button
              className="ppalette-head title-sm"
              aria-expanded={paletteOpen}
              aria-label={paletteOpen ? t('editor.paletteCollapse') : t('editor.paletteExpand')}
              onClick={() => setPaletteOpen((v) => !v)}
            >
              <Icon name={paletteOpen ? 'caretLeft' : 'caretRight'} size={16} />
              {paletteOpen && <span>{t('editor.nodes')}</span>}
            </button>
            {paletteOpen && (
              <div className="ppalette-body">
                {CATEGORY_ORDER.filter((cat) => nodeTypes.some((t) => t.category === cat)).map((cat) => {
                  const tone = categoryTone(cat);
                  return (
                    <div key={cat} className="ppalette-group">
                      <div className="ppalette-group-label label-caps">{t(`category.${cat}`)}</div>
                      {nodeTypes.filter((nt) => nt.category === cat).map((nt) => (
                        <button
                          key={nt.type}
                          className="ppalette-item"
                          draggable
                          onDragStart={(e) => { e.dataTransfer.setData('application/superapp-process-node', nt.type); e.dataTransfer.effectAllowed = 'move'; }}
                          onClick={() => addNodeCentered(nt)}
                          title={`${nt.description}\n${t('editor.dragHint')}`}
                        >
                          <span className="pnode-chip" style={{ background: tone.bg, borderColor: tone.border, color: tone.fg }}>
                            <Icon name={nodeIcon(nt)} size={15} />
                          </span>
                          <span className="ppalette-item-title">{nt.title}</span>
                        </button>
                      ))}
                    </div>
                  );
                })}
                {nodes.length <= 2 && (
                  <p className="label-sm" style={{ marginTop: 'var(--spacing-3)', padding: '0 0.375rem' }}>
                    {t('editor.paletteHelp')}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Правая панель: настройки ВЫБРАННОЙ ноды (по клику) ИЛИ настройки процесса (кнопка «Настройки»).
            Если ничего не выбрано и настройки закрыты — панели нет (холст во весь экран). */}
        {(settingsOpen || selectedNode) && (
          <div className="pfloat ppanel">
            {settingsOpen ? (
              <ProcessPanel
                wsId={wsId}
                detail={detail}
                readOnly={!canEdit}
                onClose={() => setSettingsOpen(false)}
                onMeta={(data) => metaMut.mutate(data)}
                onArchive={() => confirm(
                  {
        title: t('editor.archiveTitle'),
        message: t('editor.archiveText'),
        confirmLabel: t('editor.archiveConfirm'),
        danger: true,
      },
                  () => archiveMut.mutate(),
                )}
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
        )}

        {/* Проблемы публикации — плавающая карточка снизу по центру (видна всегда, когда есть) */}
        {issues.length > 0 && (
          <div className="pfloat pissues">
            <div className="title-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.3rem' }}>
              <Icon name="warning" size={16} style={{ color: 'var(--warning-icon)' }} />
              {t('editor.blocksPublish', { count: issues.length })}
            </div>
            {issues.map((iss, i) => (
              <button key={i} className="pissue" onClick={() => iss.nodeId && selectNode(iss.nodeId)}>
                <Icon name="caretRight" size={12} style={{ marginTop: 2, color: 'var(--label)' }} />
                {iss.message}
              </button>
            ))}
            {dirty && <p className="label-sm" style={{ margin: '0.25rem 0 0', padding: '0 0.375rem' }}>{t('editor.saveToRecheck')}</p>}
          </div>
        )}

        {/* Пикер «что добавить» при броске провода в пустоту */}
        {picker && (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 70 }} onClick={() => setPicker(null)} />
            <div
              className="pfloat ppicker"
              style={{ left: Math.min(picker.x, window.innerWidth - 230), top: Math.min(picker.y, window.innerHeight - 290) }}
            >
              <div className="label-caps" style={{ padding: '0.25rem 0.5rem 0.375rem' }}>{t('editor.addAndLink')}</div>
              {addableTypes.map((t) => {
                const tone = categoryTone(t.category);
                return (
                  <button key={t.type} className="ppalette-item" onClick={() => { addNodeAt(t, picker.flow, picker.from); setPicker(null); }}>
                    <span className="pnode-chip" style={{ background: tone.bg, borderColor: tone.border, color: tone.fg }}>
                      <Icon name={nodeIcon(t)} size={15} />
                    </span>
                    <span className="ppalette-item-title">{t.title}</span>
                  </button>
                );
              })}
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
      {pendingWarnings && (
        <Modal
          open
          onClose={() => setPendingWarnings(null)}
          title={t('editor.hrWarnTitle')}
          subtitle={t('editor.hrWarnSubtitle')}
          size="md"
          footer={
            <>
              <Button variant="ghost" onClick={() => setPendingWarnings(null)}>
                {t('editor.hrWarnBack')}
              </Button>
              <Button
                variant="primary"
                tone="success"
                icon="uploadCloud"
                loading={publishMut.isPending}
                onClick={() => publishMut.mutate(pendingWarnings.map((w) => w.ruleKey))}
              >
                {t('editor.hrWarnAccept')}
              </Button>
            </>
          }
        >
          <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
            {pendingWarnings.map((w) => (
              <Alert key={w.ruleKey} tone="warning">
                {w.message}
              </Alert>
            ))}
          </div>
        </Modal>
      )}
      {confirmUI}
    </div>
  );
}

function CenteredMsg({ text, action }: { text: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--spacing-4)', padding: 'var(--spacing-12)' }}>
      <p className="label-md">{text}</p>
      {action && <Button variant="outline" size="sm" onClick={action.onClick}>{action.label}</Button>}
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
  const tp = useTranslations('processes');
  const tc = useTranslations('common');
  const nt = node.data.typeDto;
  const tone = categoryTone(nt.category);
  const cfg = node.data.config ?? {};
  const setCfg = (key: string, value: unknown) => onChange({ config: { ...cfg, [key]: value } });
  const visible = (f: ProcessNodeField) => !f.showIf || f.showIf.in.includes(String(cfg[f.showIf.field] ?? ''));

  return (
    <>
      <div className="ppanel-head">
        <span className="pnode-chip" style={{ background: tone.bg, borderColor: tone.border, color: tone.fg }}>
          <Icon name={nodeIcon(nt)} size={15} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="title-sm">{nt.title}</div>
          {nt.trigger && <div className="label-caps" style={{ color: 'var(--warning)' }}>{tp('editor.triggerBadge')}</div>}
        </div>
        <IconButton icon="close" label={tp('editor.closeNode')} size={28} onClick={onClose} />
      </div>

      <div className="ppanel-body ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        <p className="body-sm" style={{ margin: 0 }}>{nt.description}</p>

        <Input
          label={tp('editor.nodeLabel')}
          value={node.data.label ?? ''}
          disabled={readOnly}
          onChange={(e) => onChange({ label: e.target.value })}
        />

      {nt.fields.filter(visible).map((f) => (
        // Поля кита подписывают себя сами (label связан с контролом через htmlFor).
        // Обёртка-Field нужна только тем, у кого своей подписи нет: группе флажков
        // и пикерам сущностей — иначе подпись задвоится.
        <Field
          key={f.key}
          label={SELF_LABELED_FIELDS.has(f.kind) ? undefined : f.label}
          required={SELF_LABELED_FIELDS.has(f.kind) ? undefined : f.required}
          hint={SELF_LABELED_FIELDS.has(f.kind) ? undefined : f.help}
        >
          {f.kind === 'text' && (
            <Input label={f.label} required={f.required} hint={f.help} value={String(cfg[f.key] ?? '')} placeholder={f.placeholder} disabled={readOnly} onChange={(e) => setCfg(f.key, e.target.value)} />
          )}
          {f.kind === 'textarea' && (
            <Textarea
              label={f.label}
              required={f.required}
              hint={f.help}
              value={String(cfg[f.key] ?? '')}
              placeholder={f.placeholder}
              disabled={readOnly}
              onChange={(e) => setCfg(f.key, e.target.value)}
              style={{ minHeight: '4.5rem', resize: 'vertical' }}
            />
          )}
          {f.kind === 'number' && (
            <Input
              label={f.label}
              required={f.required}
              hint={f.help}
              type="number"
              value={cfg[f.key] === undefined || cfg[f.key] === '' ? '' : Number(cfg[f.key])}
              placeholder={f.placeholder}
              disabled={readOnly}
              onChange={(e) => setCfg(f.key, e.target.value === '' ? undefined : Number(e.target.value))}
            />
          )}
          {f.kind === 'select' && (
            <Select
              label={f.label}
              hint={f.help}
              value={String(cfg[f.key] ?? '')}
              disabled={readOnly}
              width="100%"
              onChange={(v) => setCfg(f.key, v || undefined)}
              options={[{ value: '', label: '—' }, ...(f.options ?? []).map((o) => ({ value: o.value, label: o.label }))]}
            />
          )}
          {f.kind === 'multiselect' && (
            <div className="ui-stack" style={{ gap: '0.25rem' }}>
              {(f.options ?? []).map((o) => {
                const arr = Array.isArray(cfg[f.key]) ? (cfg[f.key] as string[]) : [];
                const on = arr.includes(o.value);
                return (
                  <Checkbox
                    key={o.value}
                    checked={on}
                    disabled={readOnly}
                    label={o.label}
                    onChange={(next) => setCfg(f.key, next ? [...arr, o.value] : arr.filter((x) => x !== o.value))}
                  />
                );
              })}
            </div>
          )}
          {f.kind === 'member' && (
            <EntitySelector value={cfg[f.key] ? [{ type: 'user', id: String(cfg[f.key]) }] : []} onChange={(next) => setCfg(f.key, next[0]?.id)} multi={false} options={memberOptions} placeholder={tp('editor.pickMember')} />
          )}
          {f.kind === 'department' && (
            <EntitySelector value={cfg[f.key] ? [{ type: 'department', id: String(cfg[f.key]) }] : []} onChange={(next) => setCfg(f.key, next[0]?.id)} multi={false} types={['department']} context={{ workspaceId: wsId }} placeholder={tp('editor.pickDepartment')} />
          )}
          {f.kind === 'position' && (
            <EntitySelector value={cfg[f.key] ? [{ type: 'position', id: String(cfg[f.key]) }] : []} onChange={(next) => setCfg(f.key, next[0]?.id)} multi={false} types={['position']} context={{ workspaceId: wsId }} placeholder={tp('editor.pickPosition')} />
          )}
          {f.kind === 'branch' && (
            <EntitySelector value={cfg[f.key] ? [{ type: 'branch', id: String(cfg[f.key]) }] : []} onChange={(next) => setCfg(f.key, next[0]?.id)} multi={false} types={['branch']} context={{ workspaceId: wsId }} placeholder={tp('editor.pickBranch')} />
          )}
          {f.kind === 'credential' && (
            <CredentialField wsId={wsId} label={f.label} hint={f.help} value={cfg[f.key] ? String(cfg[f.key]) : ''} disabled={readOnly} onChange={(v) => setCfg(f.key, v || undefined)} />
          )}
          {f.kind === 'formField' && (
            <Select
              label={f.label}
              hint={f.help}
              value={String(cfg[f.key] ?? '')}
              disabled={readOnly}
              width="100%"
              onChange={(v) => setCfg(f.key, v || undefined)}
              options={[{ value: '', label: '—' }, ...form.map((ff) => ({ value: ff.key, label: ff.label, hint: ff.key }))]}
            />
          )}
        </Field>
      ))}

      {/* Веб-хук / Telegram: публичный URL (появляется после публикации) */}
      {(nt.type === 'trigger.webhook' || nt.type === 'trigger.telegram') && (
        <Field
          label={nt.type === 'trigger.telegram' ? tp('editor.botWebhookUrl') : tp('editor.webhookUrl')}
          hint={
            nt.type === 'trigger.telegram'
              ? tp('editor.botWebhookHint')
              : tp('editor.webhookHint')
          }
        >
          {triggerInfo?.webhookUrl ? (
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Input
                  value={triggerInfo.webhookUrl}
                  readOnly
                  aria-label={tp('editor.webhookUrl')}
                  onFocus={(e) => e.currentTarget.select()}
                  style={{ fontSize: '0.6875rem' }}
                />
              </div>
              <IconButton
                icon="copy"
                label={tp('editor.copyUrl')}
                variant="outline"
                size={34}
                onClick={() => navigator.clipboard?.writeText(triggerInfo.webhookUrl!)}
              />
            </div>
          ) : (
            <p className="body-sm" style={{ margin: 0 }}>{tp('editor.webhookAfterPublish')}</p>
          )}
        </Field>
      )}

      {/* Telegram-триггер: какие переменные доступны дальше + как ответить */}
      {nt.type === 'trigger.telegram' && (
        <div className="ppanel-note">
          <div className="label-caps" style={{ marginBottom: '0.3rem' }}>{tp('editor.availableToNodes')}</div>
          <div className="body-sm" style={{ lineHeight: 1.9 }}>
            <code>{'{{form.text}}'}</code> — {tp('editor.tgText')} · <code>{'{{form.chatId}}'}</code> —{' '}
            {tp('editor.tgChat')} · <code>{'{{form.fromName}}'}</code> — {tp('editor.tgName')}
          </div>
          <p className="label-sm" style={{ margin: '0.4rem 0 0' }}>
            {tp('editor.tgReply')} <code>{'{{form.chatId}}'}</code>
          </p>
        </div>
      )}

      {/* Запуск вручную: анкета, которую инициатор заполняет при старте (модель Form Trigger n8n) */}
      {nt.type === 'start' && (
        <div className="ppanel-note">
          <div className="title-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Icon name="list" size={15} style={{ color: 'var(--muted)' }} />
            {tp('editor.startForm')}
          </div>
          <p className="label-sm" style={{ margin: '0.25rem 0 0.625rem' }}>
            {tp('editor.startFormHint')}
          </p>
          <FormPanel form={form} readOnly={readOnly} onChange={onFormChange} />
        </div>
      )}

        {!readOnly && onDelete && (
          <div>
            <Button variant="ghost" tone="danger" size="sm" icon="delete" onClick={onDelete}>
            {tp('editor.deleteNode')}
          </Button>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------
// Анкета процесса
// ---------------------------------------------------------------

/** Виды полей анкеты: реестр несёт ЗНАЧЕНИЕ, слова — каталог (`processes.form.type.*`). */
const FORM_TYPES: ProcessFormField['type'][] = ['text', 'number', 'boolean', 'date', 'select'];

function FormPanel({ form, readOnly, onChange }: { form: ProcessFormField[]; readOnly: boolean; onChange: (form: ProcessFormField[]) => void }) {
  const t = useTranslations('processes');
  const setField = (i: number, patch: Partial<ProcessFormField>) => onChange(form.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const keyCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of form) m.set(f.key, (m.get(f.key) ?? 0) + 1);
    return m;
  }, [form]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
      {form.map((f, i) => (
        <div
          key={i}
          className="ui-stack"
          style={{ background: 'var(--block)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '0.625rem', gap: '0.4rem' }}
        >
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <div style={{ flex: 2, minWidth: 0 }}>
              <Input value={f.label} placeholder={t('form.fieldName')} disabled={readOnly} aria-label={t('form.fieldName')} onChange={(e) => setField(i, { label: e.target.value })} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Input value={f.key} placeholder={t('form.fieldKey')} disabled={readOnly} aria-label={t('form.fieldKeyLabel')} onChange={(e) => setField(i, { key: e.target.value.replace(/[^a-zA-Z0-9_-]/g, '_') })} />
            </div>
          </div>
          {(keyCounts.get(f.key) ?? 0) > 1 && (
            <p className="label-sm" style={{ margin: 0, color: 'var(--danger)' }}>{t('form.duplicateKey', { key: f.key })}</p>
          )}
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 120 }}>
              <Select
                aria-label={t('form.fieldType')}
                value={f.type}
                disabled={readOnly}
                width="100%"
                onChange={(v) => setField(i, { type: v as ProcessFormField['type'] })}
                options={FORM_TYPES.map((v) => ({ value: v, label: t(`form.type.${v}`) }))}
              />
            </div>
            <Checkbox checked={!!f.required} disabled={readOnly} label={t('form.required')} onChange={(next) => setField(i, { required: next })} />
            {!readOnly && (
              <IconButton icon="close" label={t('form.removeField')} size={28} onClick={() => onChange(form.filter((_, idx) => idx !== i))} />
            )}
          </div>
          {f.type === 'select' && (
            <Input
              value={(f.options ?? []).join(', ')}
              placeholder={t('form.optionsPlaceholder')}
              disabled={readOnly}
              aria-label={t('form.options')}
              onChange={(e) => setField(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            />
          )}
        </div>
      ))}
      {!readOnly && (
        <Button variant="ghost" size="sm" icon="add" onClick={() => onChange([...form, { key: `field_${form.length + 1}`, label: '', type: 'text' }])}>
          {t('form.addField')}
        </Button>
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
  const t = useTranslations('processes');
  const f = useFormatters();
  const [name, setName] = useState(detail.name);
  const [description, setDescription] = useState(detail.description ?? '');
  useEffect(() => { setName(detail.name); setDescription(detail.description ?? ''); }, [detail.name, detail.description]);
  return (
    <>
      <div className="ppanel-head">
        <Icon name="settings" size={17} style={{ color: 'var(--on-surface-variant)' }} />
        <span className="title-sm" style={{ flex: 1 }}>{t('settings.title')}</span>
        <IconButton icon="close" label={t('settings.close')} size={28} onClick={onClose} />
      </div>

      <div className="ppanel-body ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        <Input
          label={t('settings.name')}
          value={name}
          disabled={readOnly}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== detail.name && onMeta({ name: name.trim() })}
        />
        <Textarea
          label={t('settings.description')}
          value={description}
          disabled={readOnly}
          style={{ minHeight: '3.6rem', resize: 'vertical' }}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description !== (detail.description ?? '') && onMeta({ description: description || null })}
        />
        <Select
          label={t('settings.visibility')}
          hint={t('settings.visibilityHint')}
          value={detail.visibility}
          disabled={readOnly}
          width="100%"
          onChange={(v) => onMeta({ visibility: v as 'team' | 'admins' })}
          options={[
            { value: 'team', label: t('visibility.team'), icon: 'people' },
            { value: 'admins', label: t('visibility.admins'), icon: 'lock' },
          ]}
        />

        <div>
          <div className="label-caps" style={{ marginBottom: '0.375rem' }}>{t('settings.versions')}</div>
          <div className="ui-stack" style={{ gap: '0.25rem' }}>
            {detail.versions.map((v) => (
              <div key={v.version} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Chip size="sm" tone={v.status === 'published' ? 'success' : 'neutral'}>v{v.version}</Chip>
                <span className="body-sm">{t(`versionStatus.${v.status}`)}</span>
                {v.publishedAt && (
                  <span className="label-sm" style={{ marginLeft: 'auto' }}>{f.date(v.publishedAt)}</span>
                )}
              </div>
            ))}
          </div>
          <p className="label-sm" style={{ margin: '0.375rem 0 0' }}>{t('settings.versionsHint')}</p>
        </div>

        {!readOnly && <CredentialsSection wsId={wsId} />}

        {!readOnly && (
          <div>
            <Button variant="ghost" tone="danger" size="sm" icon="archive" onClick={onArchive}>
              {t('settings.archive')}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------
// Ф3: сейф кредов (организация)
// ---------------------------------------------------------------

function CredentialsSection({ wsId }: { wsId: string }) {
  const t = useTranslations('processes');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const { data: creds } = useQuery({ queryKey: processCredentialsKey(wsId), queryFn: () => fetchProcessCredentials(wsId), staleTime: 30_000 });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({ name: '', type: 'bearer' });
  const [err, setErr] = useState<string | null>(null);
  const inval = () => qc.invalidateQueries({ queryKey: processCredentialsKey(wsId) });
  const addMut = useMutation({
    mutationFn: async () => apiPost(`/workspaces/${wsId}/processes/credentials`, form),
    onSuccess: () => { setAdding(false); setForm({ name: '', type: 'bearer' }); setErr(null); inval(); },
    onError: (e) => setErr(errText(e) || tc('state.error')),
  });
  const delMut = useMutation({ mutationFn: async (id: string) => apiDelete(`/workspaces/${wsId}/processes/credentials/${id}`), onSuccess: inval });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="ui-stack" style={{ gap: '0.375rem' }}>
      <div className="label-caps">{t('creds.title')}</div>
      {(creds ?? []).map((c) => (
        <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', minWidth: 0 }}>
            <Icon name="key" size={14} style={{ color: 'var(--muted)' }} />
            <span className="body-sm">{c.name}</span>
            <span className="label-sm">· {c.type}</span>
          </span>
          <IconButton icon="close" label={t('creds.delete', { name: c.name })} size={26} iconSize={12} onClick={() => delMut.mutate(c.id)} />
        </div>
      ))}
      {adding ? (
        <div className="ui-stack" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '0.625rem', gap: '0.4rem' }}>
          <Input placeholder={t('settings.name')} aria-label={t('creds.nameLabel')} value={form.name} onChange={(e) => set('name', e.target.value)} />
          <Select
            aria-label={t('creds.typeLabel')}
            value={form.type}
            width="100%"
            onChange={(v) => set('type', v)}
            options={PROCESS_CREDENTIAL_TYPES.map((v) => ({ value: v, label: t(`credentialType.${v}`), icon: 'key' as const }))}
          />
          {form.type === 'bearer' && (
            <Input placeholder={t('creds.token')} aria-label={t('creds.token')} value={form.token ?? ''} onChange={(e) => set('token', e.target.value)} />
          )}
          {form.type === 'basic' && (
            <>
              <Input placeholder={t('creds.login')} aria-label={t('creds.login')} value={form.username ?? ''} onChange={(e) => set('username', e.target.value)} />
              <Input type="password" placeholder={t('creds.password')} aria-label={t('creds.password')} value={form.password ?? ''} onChange={(e) => set('password', e.target.value)} />
            </>
          )}
          {form.type === 'header' && (
            <>
              <Input placeholder={t('creds.headerNamePlaceholder')} aria-label={t('creds.headerName')} value={form.headerName ?? ''} onChange={(e) => set('headerName', e.target.value)} />
              <Input placeholder={t('creds.headerValue')} aria-label={t('creds.headerValue')} value={form.headerValue ?? ''} onChange={(e) => set('headerValue', e.target.value)} />
            </>
          )}
          {err && <Alert tone="danger" onClose={() => setErr(null)}>{err}</Alert>}
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <Button variant="primary" tone="success" size="sm" icon="save" disabled={!form.name} loading={addMut.isPending} onClick={() => addMut.mutate()}>
              {tc('actions.save')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
              {tc('actions.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button variant="ghost" size="sm" icon="add" onClick={() => setAdding(true)}>
          {t('creds.add')}
        </Button>
        </div>
      )}
    </div>
  );
}

function CredentialField({ wsId, label, hint, value, disabled, onChange }: { wsId: string; label?: string; hint?: string; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const t = useTranslations('processes');
  const { data: creds } = useQuery({ queryKey: processCredentialsKey(wsId), queryFn: () => fetchProcessCredentials(wsId), staleTime: 30_000 });
  return (
    <Select
      label={label}
      hint={hint}
      aria-label={label ?? t('creds.short')}
      value={value}
      disabled={disabled}
      width="100%"
      onChange={onChange}
      options={[
        { value: '', label: t('creds.none'), icon: 'key' },
        ...(creds ?? []).map((c) => ({ value: c.id, label: c.name, hint: c.type, icon: 'key' as const })),
      ]}
    />
  );
}

// ---------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------

function StartModal({ wsId, defId, name, form, onClose, onStarted }: { wsId: string; defId: string; name: string; form: ProcessFormField[]; onClose: () => void; onStarted: (instanceId: string) => void }) {
  const t = useTranslations('processes');
  const tc = useTranslations('common');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true); setError(null);
    try {
      const started = await apiPost<ProcessInstanceDto>(`/workspaces/${wsId}/processes/${defId}/start`, {
        input: values,
      });
      onStarted(started.id);
    } catch (e) { setError(errText(e) || tc('state.error')); setBusy(false); }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('start.title', { name })}
      subtitle={form.length === 0 ? t('start.noForm') : t('start.withForm')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{tc('actions.cancel')}</Button>
          <Button variant="primary" icon="play" loading={busy} onClick={start}>
              {t('editor.start')}
            </Button>
        </>
      }
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}
        {form.map((f) => (
          <div key={f.key}>
            {f.type === 'text' && (
              <Input label={f.label} required={f.required} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
            )}
            {f.type === 'number' && (
              <Input label={f.label} required={f.required} type="number" onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
            )}
            {f.type === 'date' && (
              <Input label={f.label} required={f.required} type="date" onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
            )}
            {f.type === 'boolean' && (
              <Checkbox
                checked={values[f.key] === true}
                label={f.label}
                onChange={(next) => setValues((v) => ({ ...v, [f.key]: next }))}
              />
            )}
            {f.type === 'select' && (
              <Select
                label={f.label}
                value={typeof values[f.key] === 'string' ? (values[f.key] as string) : ''}
                width="100%"
                placeholder={tc('actions.select')}
                onChange={(val) => setValues((v) => ({ ...v, [f.key]: val }))}
                options={(f.options ?? []).map((o) => ({ value: o, label: o }))}
              />
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
