import { z } from 'zod';
import type { NodeRunContext, NodeRunResult, ProcessNodeProvider } from './process-node.types';
import { assertPublicUrlShallow, credentialKey, fetchJson, loadCredentialSecret } from './process-service-nodes';

// ============================================================
// Ф6 — коннекторы Казахстана (пресеты поверх HTTP-движка).
// Дружелюбные поля + готовый запрос к API платформы; ключ — из сейфа кредов (Ф3).
// Все ноды auto, выходы success/error (сбой не роняет процесс).
// ============================================================

const SUCCESS_ERR = [{ key: 'success' }, { key: 'error' }];

/** Унифицированный финал: успех/ошибка по HTTP-результату. */
function done(ok: boolean, output: Record<string, unknown>): NodeRunResult {
  return { kind: 'complete', outputKey: ok ? 'success' : 'error', output };
}
function fail(message: string): NodeRunResult {
  return { kind: 'complete', outputKey: 'error', output: { error: message } };
}

// ------------------------------------------------------------
// Telegram — ОДНА нода (модель n8n): отправляет сообщение в потоке И подключается к
// AI-Агенту как инструмент (выход «как инструмент»/astool — агент сам решает звать).
// ------------------------------------------------------------
/**
 * Экранирование под parse_mode:'HTML'. Текст ноды собирается подстановками, и туда
 * приходит НЕ только анкета: {{steps.<http>.body}} и вывод AI-нод санитайзер переменных
 * не видит вообще. Экранируем в самом стоке — это единственная точка, через которую
 * проходит всё, что реально уезжает в Telegram.
 */
function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTelegram(
  ctx: NodeRunContext,
  credentialId: string,
  chatId: string,
  text: string,
): Promise<{ status: number; ok: boolean; body: unknown }> {
  const { secret } = await loadCredentialSecret(ctx, credentialId);
  const token = credentialKey(secret);
  return fetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: escapeTelegramHtml(text), parse_mode: 'HTML' }),
  });
}

export const telegramNode: ProcessNodeProvider = {
  descriptor: {
    type: 'kz.telegram',
    category: 'integration',
    icon: 'telegram',
    tier: 'standard',
    io: true, // внешний API → вне инстанс-лока (P3)
    // success/error — поток; astool — подключение к AI-Агенту как инструмент (n8n: один узел = действие И инструмент).
    outputs: [...SUCCESS_ERR, { key: 'astool', type: 'ai_tool' }],
    fields: [
      { key: 'credentialId', kind: 'credential', required: true },
      { key: 'chatId', kind: 'text', required: true },
      { key: 'text', kind: 'textarea' }
    ],
    configSchema: z.object({
      credentialId: z.string().uuid(),
      chatId: z.string().min(1).max(120),
      text: z.string().max(4096).optional(),
    }),
    auto: true,
    tool: {
      name: 'send_telegram',
      description: 'Send a message to a Telegram chat (the chat id is set on the node; the agent writes the text).',
      schema: { type: 'object', properties: { text: { type: 'string', description: 'The message text' } }, required: ['text'] },
      async execute(ctx, input) {
        const cfg = ctx.config as { credentialId: string; chatId: string };
        const res = await sendTelegram(ctx, cfg.credentialId, ctx.render(cfg.chatId), String(input.text ?? ''));
        return res.ok ? 'The message was sent' : `Telegram error ${res.status}`;
      },
    },
  },
  async run(ctx) {
    const cfg = ctx.config as { credentialId: string; chatId: string; text?: string };
    const text = cfg.text ? ctx.render(cfg.text) : '';
    if (!text) return fail('the message text is empty (or connect the node to an agent as a tool)');
    try {
      const res = await sendTelegram(ctx, cfg.credentialId, ctx.render(cfg.chatId), text);
      return done(res.ok, { status: res.status, body: res.body });
    } catch (err) {
      return fail((err as Error).message);
    }
  },
};

// ------------------------------------------------------------
// WhatsApp Cloud API (Meta) — отправить текст (в 24-часовом окне)
// ------------------------------------------------------------
export const whatsappNode: ProcessNodeProvider = {
  descriptor: {
    type: 'kz.whatsapp',
    category: 'integration',
    icon: 'whatsapp',
    tier: 'standard',
    io: true, // внешний API → вне инстанс-лока (P3)
    outputs: SUCCESS_ERR,
    fields: [
      { key: 'credentialId', kind: 'credential', required: true },
      { key: 'phoneNumberId', kind: 'text', required: true },
      { key: 'to', kind: 'text', required: true },
      { key: 'text', kind: 'textarea', required: true }
    ],
    configSchema: z.object({
      credentialId: z.string().uuid(),
      phoneNumberId: z.string().min(1).max(60),
      to: z.string().min(1).max(30),
      text: z.string().min(1).max(4096),
    }),
    auto: true,
  },
  async run(ctx) {
    const cfg = ctx.config as { credentialId: string; phoneNumberId: string; to: string; text: string };
    try {
      const { secret } = await loadCredentialSecret(ctx, cfg.credentialId);
      const token = credentialKey(secret);
      const res = await fetchJson(`https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.phoneNumberId)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: ctx.render(cfg.to), type: 'text', text: { body: ctx.render(cfg.text) } }),
      });
      return done(res.ok, { status: res.status, body: res.body });
    } catch (err) {
      return fail((err as Error).message);
    }
  },
};

// ------------------------------------------------------------
// SMS Казахстан (Mobizon) — отправить SMS
// ------------------------------------------------------------
export const smsNode: ProcessNodeProvider = {
  descriptor: {
    type: 'kz.sms',
    category: 'integration',
    icon: 'sms',
    tier: 'standard',
    io: true, // внешний API → вне инстанс-лока (P3)
    outputs: SUCCESS_ERR,
    fields: [
      { key: 'credentialId', kind: 'credential', required: true },
      { key: 'recipient', kind: 'text', required: true },
      { key: 'text', kind: 'textarea', required: true },
      { key: 'from', kind: 'text' }
    ],
    configSchema: z.object({
      credentialId: z.string().uuid(),
      recipient: z.string().min(5).max(20),
      text: z.string().min(1).max(800),
      from: z.string().max(20).optional(),
    }),
    auto: true,
  },
  async run(ctx) {
    const cfg = ctx.config as { credentialId: string; recipient: string; text: string; from?: string };
    try {
      const { secret } = await loadCredentialSecret(ctx, cfg.credentialId);
      const apiKey = credentialKey(secret);
      const params = new URLSearchParams({ apiKey, recipient: ctx.render(cfg.recipient), text: ctx.render(cfg.text) });
      if (cfg.from) params.set('from', cfg.from);
      const res = await fetchJson(`https://api.mobizon.kz/service/message/sendSmsMessage?${params.toString()}`, { method: 'POST' });
      const code = (res.body as { code?: number })?.code;
      return done(res.ok && code === 0, { status: res.status, body: res.body });
    } catch (err) {
      return fail((err as Error).message);
    }
  },
};

// ------------------------------------------------------------
// Kaspi Магазин — заказы (новые / принять / завершить). X-Auth-Token из кабинета.
// ------------------------------------------------------------
const KASPI_BASE = 'https://kaspi.kz/shop/api/v2';
export const kaspiNode: ProcessNodeProvider = {
  descriptor: {
    type: 'kz.kaspi',
    category: 'integration',
    icon: 'cart',
    tier: 'standard',
    io: true, // внешний API → вне инстанс-лока (P3)
    outputs: SUCCESS_ERR,
    fields: [
      { key: 'credentialId', kind: 'credential', required: true },
      {
        key: 'operation',
        kind: 'select',
        required: true,
        options: ['new_orders', 'accept', 'complete']
      },
      { key: 'orderId', kind: 'text', showIf: { field: 'operation', in: ['accept', 'complete'] } }
    ],
    configSchema: z
      .object({
        credentialId: z.string().uuid(),
        operation: z.enum(['new_orders', 'accept', 'complete']),
        orderId: z.string().max(120).optional(),
      })
      .refine((c) => c.operation === 'new_orders' || !!c.orderId, { message: 'processes.validation.orderIdRequired', path: ['orderId'] }),
    auto: true,
  },
  async run(ctx) {
    const cfg = ctx.config as { credentialId: string; operation: 'new_orders' | 'accept' | 'complete'; orderId?: string };
    try {
      const { secret } = await loadCredentialSecret(ctx, cfg.credentialId);
      const token = credentialKey(secret);
      const headers = { 'X-Auth-Token': token, Accept: 'application/vnd.api+json', 'content-type': 'application/vnd.api+json' };
      if (cfg.operation === 'new_orders') {
        const params = new URLSearchParams({ 'page[number]': '0', 'page[size]': '20', 'filter[orders][state]': 'NEW', 'filter[orders][status]': 'APPROVED_BY_BANK' });
        const res = await fetchJson(`${KASPI_BASE}/orders?${params.toString()}`, { method: 'GET', headers });
        return done(res.ok, { status: res.status, body: res.body });
      }
      const status = cfg.operation === 'accept' ? 'ACCEPTED_BY_MERCHANT' : 'COMPLETED';
      const body = JSON.stringify({ data: { type: 'orders', id: ctx.render(cfg.orderId!), attributes: { status } } });
      const res = await fetchJson(`${KASPI_BASE}/orders`, { method: 'POST', headers, body });
      return done(res.ok, { status: res.status, body: res.body });
    } catch (err) {
      return fail((err as Error).message);
    }
  },
};

// ------------------------------------------------------------
// 1С OData — чтение/создание объектов опубликованной базы (Basic-auth)
// ------------------------------------------------------------
export const odataNode: ProcessNodeProvider = {
  descriptor: {
    type: 'kz.odata',
    category: 'integration',
    icon: 'database',
    tier: 'standard',
    io: true, // внешний API → вне инстанс-лока (P3)
    outputs: SUCCESS_ERR,
    fields: [
      { key: 'credentialId', kind: 'credential', required: true },
      { key: 'baseUrl', kind: 'text', required: true },
      { key: 'entity', kind: 'text', required: true },
      {
        key: 'operation',
        kind: 'select',
        required: true,
        options: ['list', 'create']
      },
      { key: 'filter', kind: 'text', showIf: { field: 'operation', in: ['list'] } },
      { key: 'body', kind: 'textarea', showIf: { field: 'operation', in: ['create'] } }
    ],
    configSchema: z.object({
      credentialId: z.string().uuid(),
      baseUrl: z.string().min(1).max(400),
      entity: z.string().min(1).max(120),
      operation: z.enum(['list', 'create']),
      filter: z.string().max(1000).optional(),
      body: z.string().max(20000).optional(),
    }),
    auto: true,
  },
  async run(ctx) {
    const cfg = ctx.config as { credentialId: string; baseUrl: string; entity: string; operation: 'list' | 'create'; filter?: string; body?: string };
    try {
      const { secret } = await loadCredentialSecret(ctx, cfg.credentialId);
      const auth = `Basic ${Buffer.from(`${secret.username ?? ''}:${secret.password ?? ''}`).toString('base64')}`;
      const base = ctx.render(cfg.baseUrl).replace(/\/$/, '');
      assertPublicUrlShallow(base); // SSRF: база 1С должна быть публично доступна (не внутренняя сеть)
      const headers = { authorization: auth, Accept: 'application/json', 'content-type': 'application/json' };
      if (cfg.operation === 'list') {
        const qs = new URLSearchParams({ $format: 'json' });
        if (cfg.filter) qs.set('$filter', ctx.render(cfg.filter));
        const res = await fetchJson(`${base}/${encodeURIComponent(cfg.entity)}?${qs.toString()}`, { method: 'GET', headers });
        return done(res.ok, { status: res.status, body: res.body });
      }
      const res = await fetchJson(`${base}/${encodeURIComponent(cfg.entity)}?$format=json`, { method: 'POST', headers, body: ctx.render(cfg.body ?? '{}') });
      return done(res.ok, { status: res.status, body: res.body });
    } catch (err) {
      return fail((err as Error).message);
    }
  },
};

export const KZ_PROCESS_NODES: ProcessNodeProvider[] = [telegramNode, whatsappNode, smsNode, kaspiNode, odataNode];
