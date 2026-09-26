import { AsyncLocalStorage } from 'node:async_hooks';
import { assertPublicUrlShallow, safeFetch } from './process-service-nodes';

// ============================================================
// LLM-клиент Ф4 — чистый fetch к Anthropic Messages / OpenAI Chat
// (без SDK-зависимостей). Текст и tool-calling. Anthropic — основной
// провайдер (Claude); openai/openai-compatible — по base URL.
// ============================================================

export type LlmProvider = 'anthropic' | 'openai' | 'openai-compatible';

/** Глубина размышлений Claude (`output_config.effort`); пусто = умолчание модели. */
export type LlmEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl?: string; // для openai-compatible
  /** Только openai/openai-compatible: Claude 4.7+ / Sonnet 5 / Opus 5 отвечают 400 на не-дефолтный sampling. */
  temperature?: number;
  /** Только anthropic. */
  effort?: LlmEffort;
  maxTokens?: number;
}

export interface LlmTool {
  name: string;
  description: string;
  schema: Record<string, unknown>; // JSON Schema входных параметров
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Реплика из памяти агента: вопрос человека и ответ агента. */
export interface LlmTurn {
  user: string;
  assistant: string;
}

/** Расход токенов (у агента — сумма по итерациям): учёт стоимости AI-нод. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmTextResult {
  text: string;
  usage: LlmUsage;
}

/** Потолок ожидания одного ответа модели. */
const LLM_CALL_TIMEOUT_MS = 120_000;

/**
 * Весь прогон агента (итерации, инструменты, под-агенты) обязан уложиться в аренду
 * I/O-шага движка (STEP_LEASE_MS = 200 с) с запасом на коммит: истёкшую аренду крон
 * переисполняет, и отправки сообщений агентом задвоятся.
 */
const AGENT_DEADLINE_MS = 170_000;

/** У Claude в max_tokens входят и размышления (у текущих моделей они включены по умолчанию). */
const DEFAULT_MAX_TOKENS: Record<LlmProvider, number> = { anthropic: 16_000, openai: 1024, 'openai-compatible': 1024 };

/** Дедлайн прогона; под-агент (вызванный инструментом внутри прогона) наследует остаток. */
const agentDeadline = new AsyncLocalStorage<number>();

function callTimeoutMs(): number {
  const deadline = agentDeadline.getStore();
  if (deadline === undefined) return LLM_CALL_TIMEOUT_MS;
  const left = deadline - Date.now();
  if (left < 1_000) throw new Error('the agent ran out of time');
  return Math.min(LLM_CALL_TIMEOUT_MS, left);
}

/**
 * ВСЕ исходящие вызовы модуля идут через safeFetch — единственную защищённую точку
 * выхода. Здесь раньше стоял голый fetch, и это была дыра SSRF:
 *  - assertPublicUrlShallow проверяет только СТРОКУ хоста (literalHostIsPrivate возвращает null
 *    для любого не-IP-литерала), поэтому домен с A-записью 169.254.169.254 проходил;
 *  - реальный DNS-чек assertResolvedPublic живёт внутри safeFetch и сюда не доставал;
 *  - голый fetch следует редиректам по умолчанию, так что 302 на внутренний адрес
 *    отрабатывал молча — и уносил с собой заголовок с ключом.
 * safeFetch даёт DNS-резолв каждого хопа, ручные редиректы и срезание кредов.
 */
async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; json: any }> {
  const res = await safeFetch(
    url,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
    { timeoutMs: callTimeoutMs() },
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 1000) };
  }
  return { status: res.status, json };
}

function openaiBase(cfg: LlmConfig): string {
  if (cfg.provider === 'openai') return 'https://api.openai.com/v1';
  const b = (cfg.baseUrl || '').replace(/\/$/, '');
  assertPublicUrlShallow(b); // SSRF-защита для своего base URL
  return b;
}

function emptyUsage(): LlmUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

/** Память — отдельными ходами диалога (пустые реплики API отвергает). */
function historyMessages(history: LlmTurn[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return history
    .filter((t) => t.user.trim() && t.assistant.trim())
    .flatMap((t) => [
      { role: 'user' as const, content: t.user },
      { role: 'assistant' as const, content: t.assistant },
    ]);
}

// ---------- Anthropic ----------

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function anthropicHeaders(cfg: LlmConfig): Record<string, string> {
  return { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' };
}

/**
 * Тело запроса к Claude. temperature не отправляется НИКОГДА (400 на текущих моделях) —
 * глубину задаёт effort. thinking не настраиваем: у текущих моделей адаптивное по умолчанию.
 */
function anthropicBody(
  cfg: LlmConfig,
  system: string | undefined,
  messages: unknown[],
  extra: { tools?: unknown[]; schema?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const outputConfig: Record<string, unknown> = {};
  if (cfg.effort) outputConfig.effort = cfg.effort;
  if (extra.schema) outputConfig.format = { type: 'json_schema', schema: extra.schema };
  return {
    model: cfg.model,
    max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS.anthropic,
    system,
    messages,
    tools: extra.tools?.length ? extra.tools : undefined,
    output_config: Object.keys(outputConfig).length ? outputConfig : undefined,
  };
}

/** Отказ и обрезка по max_tokens — ошибка ноды, а не «успех» с пустым или оборванным текстом. */
function assertAnthropicStop(json: any): void {
  if (json.stop_reason === 'refusal') {
    const category = json.stop_details?.category;
    throw new Error(`the model declined the request${category ? ` (${category})` : ''}`);
  }
  if (json.stop_reason === 'max_tokens') {
    throw new Error('the answer hit the token limit (thinking counts toward it): raise the limit or lower the effort');
  }
}

function anthropicText(content: any[]): string {
  return content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
}

function addAnthropicUsage(acc: LlmUsage, u: any): void {
  if (!u) return;
  acc.inputTokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  acc.outputTokens += u.output_tokens ?? 0;
}

function addOpenaiUsage(acc: LlmUsage, u: any): void {
  if (!u) return;
  acc.inputTokens += u.prompt_tokens ?? 0;
  acc.outputTokens += u.completion_tokens ?? 0;
}

// ---------- Простая генерация текста (без инструментов) ----------

export async function llmGenerateText(cfg: LlmConfig, system: string | undefined, user: string): Promise<LlmTextResult> {
  const usage = emptyUsage();
  if (cfg.provider === 'anthropic') {
    const { status, json } = await postJson(ANTHROPIC_URL, anthropicHeaders(cfg), anthropicBody(cfg, system, [{ role: 'user', content: user }]));
    if (status >= 400) throw new Error(`Anthropic ${status}: ${json?.error?.message ?? 'error'}`);
    addAnthropicUsage(usage, json.usage);
    assertAnthropicStop(json);
    return { text: anthropicText(json.content ?? []), usage };
  }
  const base = openaiBase(cfg);
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }];
  const { status, json } = await postJson(`${base}/chat/completions`, { authorization: `Bearer ${cfg.apiKey}` }, {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS[cfg.provider],
  });
  if (status >= 400) throw new Error(`OpenAI ${status}: ${json?.error?.message ?? 'error'}`);
  addOpenaiUsage(usage, json.usage);
  return { text: (json.choices?.[0]?.message?.content ?? '').trim(), usage };
}

// ---------- Агент с инструментами (tool-calling loop) ----------

/** Исполнитель инструмента. Отказ — throw: модель получит ошибку как ошибку, а не как данные. */
export type ToolExecutor = (name: string, input: Record<string, unknown>) => Promise<string>;

export interface AgentRequest {
  system?: string;
  /** Память — ходами диалога перед текущим, НЕ в system: прошлый ввод людей не получает полномочий оператора, а system остаётся стабильным префиксом. */
  history: LlmTurn[];
  user: string;
  tools: LlmTool[];
  execute: ToolExecutor;
  maxIterations: number;
  /** JSON Schema финального ответа (под-нода «Структурированный ответ»); только anthropic — structured outputs. */
  outputSchema?: Record<string, unknown>;
}

export interface AgentResult {
  text: string;
  /** Сколько инструментов агент вызвал (для аудита). */
  toolCallCount: number;
  usage: LlmUsage;
}

/** Прогон агента: модель сама решает, какие инструменты звать; движок их исполняет. */
export async function llmAgentLoop(cfg: LlmConfig, req: AgentRequest): Promise<AgentResult> {
  const deadline = Math.min(agentDeadline.getStore() ?? Number.POSITIVE_INFINITY, Date.now() + AGENT_DEADLINE_MS);
  return agentDeadline.run(deadline, () => (cfg.provider === 'anthropic' ? anthropicAgent(cfg, req) : openaiAgent(cfg, req)));
}

async function anthropicAgent(cfg: LlmConfig, req: AgentRequest): Promise<AgentResult> {
  const apiTools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
  const messages: any[] = [...historyMessages(req.history), { role: 'user', content: req.user }];
  const usage = emptyUsage();
  let toolCallCount = 0;
  for (let i = 0; i < req.maxIterations; i++) {
    const { status, json } = await postJson(ANTHROPIC_URL, anthropicHeaders(cfg), anthropicBody(cfg, req.system, messages, { tools: apiTools, schema: req.outputSchema }));
    if (status >= 400) throw new Error(`Anthropic ${status}: ${json?.error?.message ?? 'error'}`);
    addAnthropicUsage(usage, json.usage);
    assertAnthropicStop(json); // обрезанный tool_use не исполняем
    const content = json.content ?? [];
    const toolUses = content.filter((b: any) => b.type === 'tool_use');
    if (toolUses.length === 0) return { text: anthropicText(content), toolCallCount, usage };
    // Ответ целиком (с блоками размышлений) — обратно без правок: история только дописывается.
    messages.push({ role: 'assistant', content });
    const results: any[] = [];
    for (const tu of toolUses) {
      toolCallCount++;
      try {
        const out = await req.execute(tu.name, tu.input ?? {});
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.slice(0, 8000) });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: (err as Error).message.slice(0, 8000), is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { text: '(the agent step limit was reached)', toolCallCount, usage };
}

async function openaiAgent(cfg: LlmConfig, req: AgentRequest): Promise<AgentResult> {
  const base = openaiBase(cfg);
  const apiTools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
  const messages: any[] = [
    ...(req.system ? [{ role: 'system', content: req.system }] : []),
    ...historyMessages(req.history),
    { role: 'user', content: req.user },
  ];
  const usage = emptyUsage();
  let toolCallCount = 0;
  for (let i = 0; i < req.maxIterations; i++) {
    const { status, json } = await postJson(`${base}/chat/completions`, { authorization: `Bearer ${cfg.apiKey}` }, {
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS[cfg.provider],
      tools: apiTools.length ? apiTools : undefined,
    });
    if (status >= 400) throw new Error(`OpenAI ${status}: ${json?.error?.message ?? 'error'}`);
    addOpenaiUsage(usage, json.usage);
    const msg = json.choices?.[0]?.message;
    const calls = msg?.tool_calls ?? [];
    if (calls.length === 0) return { text: (msg?.content ?? '').trim(), toolCallCount, usage };
    messages.push(msg);
    for (const c of calls) {
      toolCallCount++;
      let out: string;
      try {
        const args = JSON.parse(c.function.arguments || '{}');
        out = await req.execute(c.function.name, args);
      } catch (err) {
        out = `Tool error: ${(err as Error).message}`;
      }
      messages.push({ role: 'tool', tool_call_id: c.id, content: out.slice(0, 8000) });
    }
  }
  return { text: '(the agent step limit was reached)', toolCallCount, usage };
}
