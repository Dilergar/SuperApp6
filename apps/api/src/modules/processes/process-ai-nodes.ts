import { z } from 'zod';
import type { AgentCluster, NodeRunContext, ProcessNodeProvider } from './process-node.types';
import { decryptSecret } from './process-crypto';
import { credentialKey } from './process-service-nodes';
import { llmAgentLoop, llmGenerateText, type LlmConfig, type LlmProvider } from './process-ai-client';

// ============================================================
// AI-ноды Ф4 + cluster-модель Ф4.5 (n8n: агент + под-ноды через порты).
// «AI» = простой LLM-шаг (модель в конфиге ноды).
// «AI-Агент» = мозг: к нему ПОРТАМИ снизу подключают Модель/Память/Инструменты
//   (отдельные под-ноды), как в n8n/ComfyUI. Агента можно подключить инструментом
//   к другому агенту (оркестратор → специалисты).
// Ключ API — bearer-кред из сейфа (наружу не отдаётся).
// ============================================================

const PROVIDER_OPTS = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'openai-compatible', label: 'OpenAI-совместимый (свой URL)' },
];

const llmConfigShape = {
  provider: z.enum(['anthropic', 'openai', 'openai-compatible']),
  credentialId: z.string().uuid(),
  model: z.string().min(1).max(120),
  baseUrl: z.string().max(300).optional(),
  temperature: z.coerce.number().min(0).max(2).optional(),
  maxTokens: z.coerce.number().int().min(16).max(8192).optional(),
};

const llmFields = [
  { key: 'provider', label: 'Провайдер', kind: 'select' as const, required: true, options: PROVIDER_OPTS },
  { key: 'credentialId', label: 'API-ключ (bearer-кред)', kind: 'credential' as const, required: true },
  { key: 'model', label: 'Модель', kind: 'text' as const, required: true, placeholder: 'claude-sonnet-4-6 / gpt-4o' },
  { key: 'baseUrl', label: 'Base URL', kind: 'text' as const, placeholder: 'https://...', showIf: { field: 'provider', in: ['openai-compatible'] } },
  { key: 'temperature', label: 'Температура (0–2)', kind: 'number' as const, placeholder: '0.7' },
  { key: 'maxTokens', label: 'Лимит токенов ответа', kind: 'number' as const, placeholder: '1024' },
];

/** Резолвим модель: достаём ключ из bearer-креда сейфа. Используется и нодой AI, и движком (под-нода Модель). */
export async function resolveLlmConfig(
  ctx: NodeRunContext,
  cfg: { provider: LlmProvider; credentialId: string; model: string; baseUrl?: string; temperature?: number; maxTokens?: number },
): Promise<LlmConfig> {
  const cred = await ctx.deps.db.processCredential.findUnique({ where: { id: cfg.credentialId } });
  if (!cred || cred.workspaceId !== ctx.workspaceId) throw new Error('API-ключ не найден в сейфе');
  const apiKey = credentialKey(JSON.parse(decryptSecret(cred.data)));
  return { provider: cfg.provider, apiKey, model: cfg.model, baseUrl: cfg.baseUrl, temperature: cfg.temperature, maxTokens: cfg.maxTokens };
}

// ------------------------------------------------------------
// «AI» — простой LLM-шаг (модель/промпт в конфиге самой ноды)
// ------------------------------------------------------------
export const aiGenerateNode: ProcessNodeProvider = {
  descriptor: {
    type: 'ai.generate',
    title: 'AI',
    description: 'Простой запрос к ИИ по API (Claude/GPT). Свой промпт/модель на каждой ноде. Подстановки {{form.x}}/{{steps.x}}. Результат в output.text.',
    category: 'ai',
    icon: '✨',
    tier: 'standard',
    io: true, // LLM-вызов → вне инстанс-лока (P3): долгий ответ не задваивается
    outputs: [
      { key: 'success', label: 'Готово' },
      { key: 'error', label: 'Ошибка' },
    ],
    fields: [
      ...llmFields.slice(0, 4),
      { key: 'systemPrompt', label: 'Системный промпт', kind: 'textarea', placeholder: 'Ты — помощник…' },
      { key: 'userPrompt', label: 'Запрос', kind: 'textarea', required: true, placeholder: 'Сократи: {{steps.fetch.body}}' },
      ...llmFields.slice(4),
    ],
    configSchema: z.object({ ...llmConfigShape, systemPrompt: z.string().max(8000).optional(), userPrompt: z.string().min(1).max(20000) }),
    auto: true,
  },
  async run(ctx) {
    const cfg = ctx.config as { provider: LlmProvider; credentialId: string; model: string; baseUrl?: string; systemPrompt?: string; userPrompt: string; temperature?: number; maxTokens?: number };
    try {
      const llm = await resolveLlmConfig(ctx, cfg);
      const text = await llmGenerateText(llm, cfg.systemPrompt ? ctx.render(cfg.systemPrompt) : undefined, ctx.render(cfg.userPrompt));
      return { kind: 'complete', outputKey: 'success', output: { text } };
    } catch (err) {
      return { kind: 'complete', outputKey: 'error', output: { error: (err as Error).message } };
    }
  },
};

// ------------------------------------------------------------
// Под-нода «Модель» — подключается к агенту портом ai_model (переиспользуема)
// ------------------------------------------------------------
const noop = async () => ({ kind: 'complete' as const });

export const aiModelNode: ProcessNodeProvider = {
  descriptor: {
    type: 'ai.model',
    title: 'Модель',
    description: 'Модель ИИ (Claude/GPT) — подключается к агенту. Одну модель можно подключить к нескольким агентам.',
    category: 'ai',
    icon: '🧠',
    tier: 'standard',
    subNode: true,
    inputs: [],
    outputs: [{ key: 'model', label: '', type: 'ai_model' }],
    fields: llmFields,
    configSchema: z.object(llmConfigShape),
    auto: true,
  },
  run: noop,
};

// ------------------------------------------------------------
// Под-нода «Память» — диалоговая память по ключу сессии (Redis)
// ------------------------------------------------------------
export const aiMemoryNode: ProcessNodeProvider = {
  descriptor: {
    type: 'ai.memory',
    title: 'Память',
    description: 'Память агента по ключу сессии: помнит контекст между запусками процесса с тем же ключом (напр. id клиента из анкеты).',
    category: 'ai',
    icon: '💾',
    tier: 'standard',
    subNode: true,
    inputs: [],
    outputs: [{ key: 'memory', label: '', type: 'ai_memory' }],
    fields: [
      { key: 'sessionKey', label: 'Ключ сессии', kind: 'text', placeholder: '{{form.clientId}} (пусто = id запуска)' },
      { key: 'window', label: 'Сколько реплик помнить', kind: 'number', placeholder: '10' },
    ],
    configSchema: z.object({ sessionKey: z.string().max(200).optional(), window: z.coerce.number().int().min(1).max(50).optional() }),
    auto: true,
  },
  run: noop,
};

// ------------------------------------------------------------
// Инструменты агента 2026-06-14 (модель n8n: один узел = действие И инструмент):
// отдельные под-ноды «Инструмент: HTTP/Уведомить/Telegram» УДАЛЕНЫ — сами ноды
// «HTTP-запрос» (service.http) / «Уведомить» (notify) / «Telegram» (kz.telegram)
// теперь работают и в потоке, и как инструмент агента (выход astool → вход ai_tool).
// ------------------------------------------------------------

// ------------------------------------------------------------
// Под-нода «Структурированный ответ» — заставляет агента вернуть строгий JSON
// ------------------------------------------------------------
export const aiParserNode: ProcessNodeProvider = {
  descriptor: {
    type: 'ai.parser',
    title: 'Структурированный ответ',
    description: 'Подключается к агенту: заставляет вернуть строгий JSON с нужными полями. Результат — в output.data (поля доступны как {{steps.агент.data.поле}}).',
    category: 'ai',
    icon: '🧩',
    tier: 'standard',
    subNode: true,
    inputs: [],
    outputs: [{ key: 'parser', label: '', type: 'ai_output' }],
    fields: [
      { key: 'fields', label: 'Поля JSON (по строке «ключ: описание»)', kind: 'textarea', required: true, placeholder: 'decision: approve или reject\nreason: краткая причина\namount: число' },
    ],
    configSchema: z.object({ fields: z.string().min(1).max(4000) }),
    auto: true,
  },
  run: noop,
};

/** Построить инструкцию для LLM из описания полей парсера. */
export function parserInstruction(fieldsText: string): string {
  const lines = fieldsText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const fields = lines.map((l) => {
    const i = l.indexOf(':');
    return i > 0 ? `«${l.slice(0, i).trim()}» — ${l.slice(i + 1).trim()}` : `«${l}»`;
  });
  return `Ответь СТРОГО валидным JSON-объектом с полями: ${fields.join('; ')}. Без markdown, без пояснений вокруг — только JSON.`;
}

/** Достать JSON из ответа модели (модель иногда оборачивает его в текст/markdown). */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// «AI-Агент» — мозг. Модель/Память/Инструменты/Парсер приходят ПОРТАМИ (cluster).
// ------------------------------------------------------------

/** Выполнить агента с собранным кластером (память + tool-calling + парсер). Переиспользуется движком для под-агентов. */
export async function runAgentWithCluster(
  cluster: AgentCluster,
  userPrompt: string,
  maxIterations: number,
): Promise<{ text: string; toolCalls: number; data?: unknown }> {
  const prior = cluster.memory ? await cluster.memory.load() : '';
  const system = [cluster.systemPrompt, prior && `Предыдущий контекст диалога:\n${prior}`].filter(Boolean).join('\n\n') || undefined;
  const user = cluster.outputParser ? `${userPrompt}\n\n${cluster.outputParser.instruction}` : userPrompt;
  const result = await llmAgentLoop(
    cluster.model,
    system,
    user,
    cluster.tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema })),
    async (name, input) => {
      const tool = cluster.tools.find((t) => t.name === name);
      return tool ? tool.run(input) : `Неизвестный инструмент: ${name}`;
    },
    maxIterations,
  );
  if (cluster.memory) await cluster.memory.append(userPrompt, result.text);
  const data = cluster.outputParser ? extractJson(result.text) : undefined;
  return { text: result.text, toolCalls: result.toolCallCount, data };
}

export const aiAgentNode: ProcessNodeProvider = {
  descriptor: {
    type: 'ai.agent',
    title: 'AI-Агент',
    description:
      'Мозг-оркестратор (n8n-модель): снизу портами подключаются Модель (обязательно), Память (опц.) и Инструменты (сколько угодно). Агент сам решает, какие инструменты звать. Можно подключить как инструмент к другому агенту.',
    category: 'ai',
    icon: '🤖',
    tier: 'standard',
    io: true, // агент-цикл (LLM + инструменты) → вне инстанс-лока (P3)
    inputs: [
      { key: 'main', type: 'main' },
      { key: 'ai_model', type: 'ai_model', label: 'Модель' },
      { key: 'ai_memory', type: 'ai_memory', label: 'Память' },
      { key: 'ai_tool', type: 'ai_tool', multi: true, label: 'Инструменты' },
      { key: 'ai_output', type: 'ai_output', label: 'Парсер' },
    ],
    outputs: [
      { key: 'success', label: 'Готово', type: 'main' },
      { key: 'error', label: 'Ошибка', type: 'main' },
      { key: 'astool', label: 'как инструмент', type: 'ai_tool' },
    ],
    fields: [
      { key: 'systemPrompt', label: 'Системный промпт (роль)', kind: 'textarea', placeholder: 'Ты — диспетчер снабжения…' },
      { key: 'userPrompt', label: 'Задача', kind: 'textarea', required: true, placeholder: 'Обработай заказ {{form.orderId}}' },
      { key: 'toolDescription', label: 'Описание (когда агент = инструмент)', kind: 'text', placeholder: 'Зачем звать этого агента из другого' },
      { key: 'maxIterations', label: 'Макс. шагов агента', kind: 'number', placeholder: '5' },
    ],
    configSchema: z.object({
      systemPrompt: z.string().max(8000).optional(),
      userPrompt: z.string().min(1).max(20000),
      toolDescription: z.string().max(500).optional(),
      maxIterations: z.coerce.number().int().min(1).max(8).optional(),
    }),
    auto: true,
  },
  async run(ctx) {
    const cfg = ctx.config as { systemPrompt?: string; userPrompt: string; maxIterations?: number };
    if (!ctx.cluster) return { kind: 'complete', outputKey: 'error', output: { error: 'К агенту не подключена Модель' } };
    try {
      const cluster = { ...ctx.cluster, systemPrompt: cfg.systemPrompt ? ctx.render(cfg.systemPrompt) : ctx.cluster.systemPrompt };
      const r = await runAgentWithCluster(cluster, ctx.render(cfg.userPrompt), cfg.maxIterations ?? 5);
      return { kind: 'complete', outputKey: 'success', output: { text: r.text, toolCalls: r.toolCalls, data: r.data } };
    } catch (err) {
      return { kind: 'complete', outputKey: 'error', output: { error: (err as Error).message } };
    }
  },
};

export const AI_PROCESS_NODES: ProcessNodeProvider[] = [
  aiGenerateNode,
  aiAgentNode,
  aiModelNode,
  aiMemoryNode,
  aiParserNode,
];
