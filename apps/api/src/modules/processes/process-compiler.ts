import type { ProcessDocument } from '@superapp/shared';
import type { CompiledPlan, RawIssue } from './process-node.types';
import type { ProcessNodeRegistry } from './process-node.registry';

export interface CompileResult {
  plan: CompiledPlan | null;
  /** Ключи каталога с подстановками — слова добавит сервис */
  issues: RawIssue[];
}

/**
 * Компилятор: канвас-документ → исполняемый план (IR) + список проблем.
 * Та же идея, что graphToPrompt в ComfyUI: редактор хранит «богатый» документ,
 * движок получает минимальную проверенную форму. Публикация требует issues = 0;
 * сохранение черновика — нет (мягкая валидация подсвечивает проблемы в редакторе).
 */
/** Ф2: универсальные настройки обработки ошибок из raw config (клампинг границ). */
function extractErrorHandling(config: Record<string, unknown>): {
  onError: 'stop' | 'continue' | 'errorOutput';
  retryMaxTries: number;
  retryWaitMs: number;
} {
  const oe = config.onError;
  const onError = oe === 'continue' || oe === 'errorOutput' ? oe : 'stop';
  const retryMaxTries = Math.min(5, Math.max(0, Math.floor(Number(config.retryMaxTries ?? 0)) || 0));
  const retryWaitMs = Math.min(10_000, Math.max(0, Math.floor(Number(config.retryWaitMs ?? 0)) || 0));
  return { onError, retryMaxTries, retryWaitMs };
}

export function compileProcessDocument(
  doc: ProcessDocument,
  registry: ProcessNodeRegistry,
): CompileResult {
  const issues: RawIssue[] = [];

  // --- Уникальность id ---
  const nodeIds = new Set<string>();
  for (const n of doc.nodes) {
    if (nodeIds.has(n.id)) issues.push({ nodeId: n.id, message: 'processes.issue.duplicateNodeId', params: { id: n.id } });
    nodeIds.add(n.id);
  }
  const formKeys = new Set<string>();
  for (const f of doc.form) {
    if (formKeys.has(f.key)) issues.push({ message: 'processes.issue.duplicateFormKey', params: { key: f.key } });
    formKeys.add(f.key);
    if (f.type === 'select' && (!f.options || f.options.length === 0)) {
      issues.push({ message: 'processes.issue.selectWithoutOptions', params: { field: f.label } });
    }
  }

  // --- Типы нод и конфиги ---
  const plan: CompiledPlan = { startNodeId: '', entryNodeIds: [], form: doc.form, nodes: {}, adjacency: {}, joinExpected: {}, attachments: {} };
  const triggerIds: string[] = []; // все триггер-ноды = точки входа
  let manualStartId = ''; // триггер «Запуск вручную» (тип 'start') — точка ручного запуска
  const inDegree = new Map<string, number>(); // для join: сколько токенов ждать
  // Ф4.5: какие типизированные выходы под-нод реально подключены к агенту.
  const subNodeConnected = new Set<string>();
  let hasEnd = false;

  // Тип входного порта ноды (по умолчанию 'main'). Триггеры/под-ноды входов не имеют.
  const inputType = (nodeType: string, port: string): string | null => {
    const d = registry.get(nodeType)?.descriptor;
    if (!d) return null;
    const inputs = d.inputs ?? (d.trigger || d.subNode ? [] : [{ key: 'main', type: 'main' as const }]);
    return inputs.find((i) => i.key === port)?.type ?? null;
  };
  const outputType = (nodeType: string, port: string): string | null =>
    registry.get(nodeType)?.descriptor.outputs.find((o) => o.key === port)?.type ?? 'main';

  for (const n of doc.nodes) {
    const provider = registry.get(n.type);
    if (!provider) {
      issues.push({ nodeId: n.id, message: 'processes.issue.unknownNodeType', params: { type: n.type } });
      continue;
    }
    const d = provider.descriptor;
    if (d.trigger) {
      triggerIds.push(n.id);
      if (d.type === 'start') manualStartId = n.id; // ручной запуск стартует отсюда
    }
    if (d.terminal) hasEnd = true;

    const parsed = d.configSchema.safeParse(n.config ?? {});
    if (!parsed.success) {
      for (const e of parsed.error.errors) {
        issues.push({
          nodeId: n.id,
          field: e.path.join('.') || undefined,
          message: 'processes.issue.nodeProblem',
          // Сообщение схемы — тоже ключ каталога: разворачиваем его здесь, чтобы
          // подставить в обрамляющую фразу «<нода>: <что не так>».
          params: { node: n.label || registry.title(n.type), problem: registry.text(e.message) },
        });
      }
    }
    // Нода с НЕДОЗАПОЛНЕННЫМ конфигом остаётся на схеме. Раньше она выпадала из
    // плана, и человек получал каскад: «нет входа», «недостижима» — по одной строке
    // на каждый шаг за ней, вместо единственной настоящей причины «выберите
    // должность». Публикацию по-прежнему блокирует само замечание, а план с
    // ошибками наружу не отдаётся вовсе.
    const config = (parsed.success ? parsed.data : (n.config ?? {})) as Record<string, unknown>;
    if (provider.validateConfig) {
      for (const issue of provider.validateConfig(config, doc)) {
        issues.push({
          ...issue,
          nodeId: n.id,
          message: 'processes.issue.nodeProblem',
          params: { node: n.label || registry.title(n.type), problem: registry.text(issue.message) },
        });
      }
    }
    plan.nodes[n.id] = {
      type: d.type,
      // Подпись шага ЛОЖИТСЯ в план и живёт там вечно — своё имя ноды или
      // название типа в языке ИСТОЧНИКА (правило снимков в БД).
      label: n.label || registry.sourceTitle(d.type),
      config,
      terminal: !!d.terminal,
      auto: d.auto,
      join: !!d.join,
      // агент = потребляет под-ноды (есть вход ai_model)
      cluster: (d.inputs ?? []).some((i) => i.type === 'ai_model'),
      // Ф2: универсальные настройки обработки ошибок — из raw config (node-схема их стрипает).
      ...extractErrorHandling(n.config ?? {}),
    };
    plan.adjacency[n.id] = {};
    plan.attachments[n.id] = {};
  }

  // --- Триггеры/Конец ---
  if (triggerIds.length === 0) {
    issues.push({ message: 'processes.issue.noTrigger' });
  }
  if (!hasEnd) issues.push({ message: 'processes.issue.noEnd' });
  plan.entryNodeIds = triggerIds;
  // Ручной запуск стартует с «Запуск вручную», иначе с первого триггера (back-compat).
  plan.startNodeId = manualStartId || triggerIds[0] || '';

  // --- Рёбра ---
  for (const e of doc.edges) {
    const fromNode = doc.nodes.find((n) => n.id === e.from);
    const toExists = nodeIds.has(e.to);
    if (!fromNode) {
      issues.push({ edgeId: e.id, message: 'processes.issue.edgeFromMissing', params: { id: e.from } });
      continue;
    }
    if (!toExists) {
      issues.push({ edgeId: e.id, message: 'processes.issue.edgeToMissing', params: { id: e.to } });
      continue;
    }
    if (e.from === e.to) {
      issues.push({ edgeId: e.id, nodeId: e.from, message: 'processes.issue.selfEdge' });
      continue;
    }
    if (triggerIds.includes(e.to)) {
      issues.push({ edgeId: e.id, nodeId: e.to, message: 'processes.issue.edgeIntoTrigger' });
      continue;
    }
    const provider = registry.get(fromNode.type);
    if (!provider) continue; // тип уже отмечен как неизвестный
    const port = e.fromPort || 'main';
    const oType = outputType(fromNode.type, port);
    if (oType === null) {
      issues.push({
        edgeId: e.id,
        nodeId: e.from,
        message: 'processes.issue.outputMissing',
        params: { node: fromNode.label || registry.title(provider.descriptor.type), port },
      });
      continue;
    }
    const toPort = e.toPort || 'main';
    const iType = inputType(plan.nodes[e.to]?.type ?? '', toPort);
    if (iType === null) {
      issues.push({
        edgeId: e.id,
        nodeId: e.to,
        message: 'processes.issue.inputMissing',
        params: { node: plan.nodes[e.to]?.label ?? e.to, port: toPort },
      });
      continue;
    }
    if (oType !== iType) {
      issues.push({ edgeId: e.id, message: 'processes.issue.portMismatch', params: { from: oType, to: iType } });
      continue;
    }

    if (iType === 'main') {
      // Поток токенов (как раньше): один токен — одно ребро на порт (кроме Развилки).
      //
      // Ноды с НЕВАЛИДНЫМ конфигом в план не попадают (их ошибки уже собраны выше),
      // и связь из такой ноды раньше разыменовывала undefined — то есть ЧТЕНИЕ
      // страницы процесса падало 500 вместо мягкого замечания. Мягкая валидация
      // существует ровно для того, чтобы недособранный черновик открывался и
      // показывал, что чинить.
      const adj = plan.adjacency[e.from];
      if (!adj) continue;
      if (!adj[port]) adj[port] = [];
      if (adj[port].length >= 1 && !provider.descriptor.multiOut) {
        issues.push({
          edgeId: e.id,
          nodeId: e.from,
          message: 'processes.issue.outputTaken',
          params: { port, node: fromNode.label || fromNode.id },
        });
        continue;
      }
      if (adj[port].includes(e.to)) continue;
      adj[port].push(e.to);
      inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    } else {
      // Ф4.5: подключение под-ноды к агенту (ai_model/ai_memory/ai_tool).
      const att = plan.attachments[e.to]!;
      if (!att[iType]) att[iType] = [];
      const multi = (registry.get(plan.nodes[e.to].type)?.descriptor.inputs ?? []).find((i) => i.key === toPort)?.multi;
      if (att[iType].length >= 1 && !multi) {
        issues.push({
        edgeId: e.id,
        nodeId: e.to,
        message: 'processes.issue.subNodeTaken',
        params: { port: toPort, node: plan.nodes[e.to].label },
      });
        continue;
      }
      if (!att[iType].includes(e.from)) att[iType].push(e.from);
      subNodeConnected.add(e.from);
    }
  }

  // --- Поток: все MAIN-выходы достижимых нод подключены (под-ноды/под-агенты — отдельно) ---
  // Достижимость считаем от ВСЕХ триггеров (каждый — своя точка входа, как в n8n).
  const reachable = new Set<string>();
  const queue = triggerIds.filter((id) => plan.nodes[id]);
  while (queue.length) {
    const cur = queue.pop()!;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const targets of Object.values(plan.adjacency[cur] ?? {})) {
      for (const next of targets) if (!reachable.has(next)) queue.push(next);
    }
  }
  for (const n of doc.nodes) {
    const provider = registry.get(n.type);
    const compiled = plan.nodes[n.id];
    if (!provider || !compiled) continue;
    if (!reachable.has(n.id)) continue; // под-ноды/под-агенты проверяем ниже
    for (const out of provider.descriptor.outputs) {
      if ((out.type ?? 'main') !== 'main') continue; // ai_*-выходы необязательны
      // Необязательный выход можно оставить пустым: так к УЖЕ опубликованным нодам
      // добавляются новые исходы, не превращая все нарисованные маршруты в невалидные
      // (третий исход согласования «На доработку» появился именно так). В рантайме
      // такой токен уходит по запасному выходу — см. `fallback` в паспорте.
      if (out.optional) continue;
      const targets = plan.adjacency[n.id]?.[out.key] ?? [];
      if (targets.length === 0) {
        issues.push({
          nodeId: n.id,
          message: 'processes.issue.outputDangling',
          params: { node: compiled.label, port: out.key },
        });
      }
    }
  }

  // --- Развилка/Слияние (Ф2.5) ---
  for (const n of doc.nodes) {
    const provider = registry.get(n.type);
    const compiled = plan.nodes[n.id];
    if (!provider || !compiled) continue;
    if (provider.descriptor.multiOut) {
      const branches = plan.adjacency[n.id]?.main?.length ?? 0;
      if (branches < 2)
        issues.push({ nodeId: n.id, message: 'processes.issue.forkNeedsBranches', params: { node: compiled.label } });
    }
    if (provider.descriptor.join) {
      const k = inDegree.get(n.id) ?? 0;
      if (k < 2)
        issues.push({ nodeId: n.id, message: 'processes.issue.joinNeedsBranches', params: { node: compiled.label } });
      plan.joinExpected[n.id] = k;
    }
  }

  // --- Ф4.5: кластер агента + подключённость под-нод ---
  for (const n of doc.nodes) {
    const provider = registry.get(n.type);
    const compiled = plan.nodes[n.id];
    if (!provider || !compiled) continue;
    const d = provider.descriptor;

    // Под-нода (Модель/Память/Инструмент/под-агент через astool) должна быть подключена.
    const usedAsProvider = subNodeConnected.has(n.id);
    if (d.subNode && !usedAsProvider) {
      issues.push({ nodeId: n.id, message: 'processes.issue.subNodeDetached', params: { node: compiled.label } });
    }

    // Агент: ровно одна Модель, не больше одной Памяти.
    if (compiled.cluster) {
      const att = plan.attachments[n.id] ?? {};
      if ((att.ai_model?.length ?? 0) === 0)
        issues.push({ nodeId: n.id, message: 'processes.issue.agentNeedsModel', params: { node: compiled.label } });
      if ((att.ai_model?.length ?? 0) > 1)
        issues.push({ nodeId: n.id, message: 'processes.issue.agentOneModel', params: { node: compiled.label } });
      if ((att.ai_memory?.length ?? 0) > 1)
        issues.push({ nodeId: n.id, message: 'processes.issue.agentOneMemory', params: { node: compiled.label } });
    }

    // Достижимость: нода вне потока — либо триггер, либо под-нода/под-агент (provider), либо ошибка.
    if (!reachable.has(n.id) && !d.trigger) {
      const isProvider = d.subNode || usedAsProvider; // под-агент подключён через astool
      if (!isProvider) {
        issues.push({ nodeId: n.id, message: 'processes.issue.unreachable', params: { node: compiled.label } });
      }
    }
  }

  // --- A6: детект циклов «агент-как-инструмент» (agent → под-агент через ai_tool) ---
  // Рантайм ограничивает глубину ≤3, но цикл A→B→A — ошибка конфигурации: ловим при компиляции.
  const agentEdges = new Map<string, string[]>();
  for (const [agentId, att] of Object.entries(plan.attachments)) {
    if (!plan.nodes[agentId]?.cluster) continue;
    const subAgents = (att.ai_tool ?? []).filter((id) => plan.nodes[id]?.cluster);
    if (subAgents.length) agentEdges.set(agentId, subAgents);
  }
  const color = new Map<string, number>(); // 0=white 1=gray 2=black
  let cycleAt: string | null = null;
  const dfs = (id: string): boolean => {
    color.set(id, 1);
    for (const next of agentEdges.get(id) ?? []) {
      const c = color.get(next) ?? 0;
      if (c === 1) { cycleAt = next; return true; }
      if (c === 0 && dfs(next)) return true;
    }
    color.set(id, 2);
    return false;
  };
  for (const id of agentEdges.keys()) {
    if ((color.get(id) ?? 0) === 0 && dfs(id)) break;
  }
  if (cycleAt) {
    issues.push({
      nodeId: cycleAt,
      message: 'processes.issue.agentCycle',
      params: { node: plan.nodes[cycleAt]?.label ?? cycleAt },
    });
  }

  return { plan: issues.length === 0 ? plan : null, issues };
}
