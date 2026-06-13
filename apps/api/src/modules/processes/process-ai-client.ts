import { assertPublicUrl } from './process-service-nodes';

// ============================================================
// LLM-клиент Ф4 — чистый fetch к Anthropic Messages / OpenAI Chat
// (без SDK-зависимостей). Текст и tool-calling. Anthropic — основной
// провайдер (Claude); openai/openai-compatible — по base URL.
// ============================================================

export type LlmProvider = 'anthropic' | 'openai' | 'openai-compatible';

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl?: string; // для openai-compatible
  temperature?: number;
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

const LLM_TIMEOUT_MS = 40_000;

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; json: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 1000) };
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function openaiBase(cfg: LlmConfig): string {
  if (cfg.provider === 'openai') return 'https://api.openai.com/v1';
  const b = (cfg.baseUrl || '').replace(/\/$/, '');
  assertPublicUrl(b); // SSRF-защита для своего base URL
  return b;
}

// ---------- Простая генерация текста (без инструментов) ----------

export async function llmGenerateText(cfg: LlmConfig, system: string | undefined, user: string): Promise<string> {
  if (cfg.provider === 'anthropic') {
    const { status, json } = await postJson(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      { model: cfg.model, max_tokens: cfg.maxTokens ?? 1024, temperature: cfg.temperature, system, messages: [{ role: 'user', content: user }] },
    );
    if (status >= 400) throw new Error(`Anthropic ${status}: ${json?.error?.message ?? 'ошибка'}`);
    return (json.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
  }
  const base = openaiBase(cfg);
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }];
  const { status, json } = await postJson(`${base}/chat/completions`, { authorization: `Bearer ${cfg.apiKey}` }, {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens ?? 1024,
  });
  if (status >= 400) throw new Error(`OpenAI ${status}: ${json?.error?.message ?? 'ошибка'}`);
  return (json.choices?.[0]?.message?.content ?? '').trim();
}

// ---------- Агент с инструментами (tool-calling loop) ----------

export type ToolExecutor = (name: string, input: Record<string, unknown>) => Promise<string>;

export interface AgentResult {
  text: string;
  /** Сколько инструментов агент вызвал (для аудита). */
  toolCallCount: number;
}

/** Прогон агента: модель сама решает, какие инструменты звать; движок их исполняет. */
export async function llmAgentLoop(
  cfg: LlmConfig,
  system: string | undefined,
  user: string,
  tools: LlmTool[],
  execute: ToolExecutor,
  maxIterations: number,
): Promise<AgentResult> {
  return cfg.provider === 'anthropic'
    ? anthropicAgent(cfg, system, user, tools, execute, maxIterations)
    : openaiAgent(cfg, system, user, tools, execute, maxIterations);
}

async function anthropicAgent(cfg: LlmConfig, system: string | undefined, user: string, tools: LlmTool[], execute: ToolExecutor, maxIter: number): Promise<AgentResult> {
  const apiTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
  const messages: any[] = [{ role: 'user', content: user }];
  let toolCallCount = 0;
  for (let i = 0; i < maxIter; i++) {
    const { status, json } = await postJson(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      { model: cfg.model, max_tokens: cfg.maxTokens ?? 1024, temperature: cfg.temperature, system, messages, tools: apiTools.length ? apiTools : undefined },
    );
    if (status >= 400) throw new Error(`Anthropic ${status}: ${json?.error?.message ?? 'ошибка'}`);
    const content = json.content ?? [];
    const toolUses = content.filter((b: any) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      return { text: content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim(), toolCallCount };
    }
    messages.push({ role: 'assistant', content });
    const results: any[] = [];
    for (const tu of toolUses) {
      toolCallCount++;
      let out: string;
      try {
        out = await execute(tu.name, tu.input ?? {});
      } catch (err) {
        out = `Ошибка инструмента: ${(err as Error).message}`;
      }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.slice(0, 8000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { text: '(достигнут лимит шагов агента)', toolCallCount };
}

async function openaiAgent(cfg: LlmConfig, system: string | undefined, user: string, tools: LlmTool[], execute: ToolExecutor, maxIter: number): Promise<AgentResult> {
  const base = openaiBase(cfg);
  const apiTools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
  const messages: any[] = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }];
  let toolCallCount = 0;
  for (let i = 0; i < maxIter; i++) {
    const { status, json } = await postJson(`${base}/chat/completions`, { authorization: `Bearer ${cfg.apiKey}` }, {
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens ?? 1024,
      tools: apiTools.length ? apiTools : undefined,
    });
    if (status >= 400) throw new Error(`OpenAI ${status}: ${json?.error?.message ?? 'ошибка'}`);
    const msg = json.choices?.[0]?.message;
    const calls = msg?.tool_calls ?? [];
    if (calls.length === 0) return { text: (msg?.content ?? '').trim(), toolCallCount };
    messages.push(msg);
    for (const c of calls) {
      toolCallCount++;
      let out: string;
      try {
        const args = JSON.parse(c.function.arguments || '{}');
        out = await execute(c.function.name, args);
      } catch (err) {
        out = `Ошибка инструмента: ${(err as Error).message}`;
      }
      messages.push({ role: 'tool', tool_call_id: c.id, content: out.slice(0, 8000) });
    }
  }
  return { text: '(достигнут лимит шагов агента)', toolCallCount };
}
