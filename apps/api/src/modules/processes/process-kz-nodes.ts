import { z } from 'zod';
import type { NodeRunContext, NodeRunResult, ProcessNodeProvider } from './process-node.types';
import { assertPublicUrl, credentialKey, fetchJson, loadCredentialSecret } from './process-service-nodes';

// ============================================================
// Ф6 — коннекторы Казахстана (пресеты поверх HTTP-движка).
// Дружелюбные поля + готовый запрос к API платформы; ключ — из сейфа кредов (Ф3).
// Все ноды auto, выходы success/error (сбой не роняет процесс).
// ============================================================

const SUCCESS_ERR = [
  { key: 'success', label: 'Успех' },
  { key: 'error', label: 'Ошибка' },
];

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
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

export const telegramNode: ProcessNodeProvider = {
  descriptor: {
    type: 'kz.telegram',
    title: 'Telegram',
    description:
      'Отправляет сообщение через Telegram-бота (токен @BotFather в кредах). В потоке шлёт заданный текст; если подключить выход «как инструмент» к AI-Агенту — агент сам решает, когда писать, и придумывает текст. Подстановки {{form.x}}/{{steps.x}}.',
    category: 'integration',
    icon: '✈️',
    tier: 'standard',
    io: true, // внешний API → вне инстанс-лока (P3)
    // success/error — поток; astool — подключение к AI-Агенту как инструмент (n8n: один узел = действие И инструмент).
    outputs: [...SUCCESS_ERR, { key: 'astool', label: 'как инструмент', type: 'ai_tool' }],
    fields: [
      { key: 'credentialId', label: 'Токен бота (кред)', kind: 'credential', required: true },
      { key: 'chatId', label: 'Chat ID / @канал', kind: 'text', required: true, placeholder: '{{form.chatId}}, 123456789 или @mychannel' },
      { key: 'text', label: 'Текст', kind: 'textarea', help: 'Для обычной ноды — обязательно. Если нода подключена к агенту как инструмент, текст придумывает агент.' },
    ],
    configSchema: z.object({
      credentialId: z.string().uuid(),
      chatId: z.string().min(1).max(120),
      text: z.string().max(4096).optional(),
    }),
    auto: true,
    tool: {
      name: 'send_telegram',
      description: 'Отправить сообщение в Telegram-чат (chat id задан в ноде; текст придумывает агент).',
      schema: { type: 'object', properties: { text: { type: 'string', description: 'Текст сообщения' } }, required: ['text'] },
      async execute(ctx, input) {
        const cfg = ctx.config as { credentialId: string; chatId: string };
        const res = await sendTelegram(ctx, cfg.credentialId, ctx.render(cfg.chatId), String(input.text ?? ''));
        return res.ok ? 'Сообщение отправлено' : `Ошибка Telegram ${res.status}`;
      },
    },
  },
  async run(ctx) {
    const cfg = ctx.config as { credentialId: string; chatId: string; text?: string };
    const text = cfg.text ? ctx.render(cfg.text) : '';
    if (!text) return fail('Заполните текст сообщения (или подключите ноду к агенту как инструмент)');
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
    title: 'WhatsApp',
    description: 'Отправляет сообщение через WhatsApp Cloud API (access-токен в кредах; шаблоны — вне 24ч-окна). Подстановки.',
    category: 'integration',
    icon: '🟢',
    tier: 'standard',
    io: true, // внешний API → вне инстанс-лока (P3)
    outputs: SUCCESS_ERR,
    fields: [
      { key: 'credentialId', label: 'Access-токен (кред)', kind: 'credential', required: true },
      { key: 'phoneNumberId', label: 'Phone Number ID', kind: 'text', required: true },
      { key: 'to', label: 'Кому (телефон)', kind: 'text', required: true, placeholder: '77001234567' },
      { key: 'text', label: 'Текст', kind: 'textarea', required: true },
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
    title: 'SMS (Mobizon)',
    description: 'Отправляет SMS через Mobizon.kz (apiKey в кредах). Альфа-имя отправителя регистрируется заранее.',
    category: 'integration',
    icon: '📨',
    tier: 'standard',
    io: true, // внешний API → вне инстанс-лока (P3)
    outputs: SUCCESS_ERR,
    fields: [
      { key: 'credentialId', label: 'API-ключ Mobizon (кред)', kind: 'credential', required: true },
      { key: 'recipient', label: 'Получатель (телефон)', kind: 'text', required: true, placeholder: '7700...' },
      { key: 'text', label: 'Текст', kind: 'textarea', required: true },
      { key: 'from', label: 'Альфа-имя (необяз.)', kind: 'text' },
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
    title: 'Kaspi Магазин',
    description: 'Заказы Kaspi Магазина: получить новые / принять / завершить (токен из кабинета продавца). Вебхуков у Kaspi нет — опрашивайте по расписанию.',
    category: 'integration',
    icon: '🛒',
    tier: 'standard',
    io: true, // внешний API → вне инстанс-лока (P3)
    outputs: SUCCESS_ERR,
    fields: [
      { key: 'credentialId', label: 'X-Auth-Token (кред)', kind: 'credential', required: true },
      {
        key: 'operation',
        label: 'Операция',
        kind: 'select',
        required: true,
        options: [
          { value: 'new_orders', label: 'Получить новые заказы' },
          { value: 'accept', label: 'Принять заказ' },
          { value: 'complete', label: 'Завершить заказ' },
        ],
      },
      { key: 'orderId', label: 'ID заказа', kind: 'text', showIf: { field: 'operation', in: ['accept', 'complete'] } },
    ],
    configSchema: z
      .object({
        credentialId: z.string().uuid(),
        operation: z.enum(['new_orders', 'accept', 'complete']),
        orderId: z.string().max(120).optional(),
      })
      .refine((c) => c.operation === 'new_orders' || !!c.orderId, { message: 'Укажите ID заказа', path: ['orderId'] }),
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
    title: '1С (OData)',
    description: 'Запрос к опубликованной базе 1С через стандартный OData (Basic-auth в кредах). База должна быть доступна публично.',
    category: 'integration',
    icon: '🟡',
    tier: 'standard',
    io: true, // внешний API → вне инстанс-лока (P3)
    outputs: SUCCESS_ERR,
    fields: [
      { key: 'credentialId', label: 'Логин/пароль 1С (basic-кред)', kind: 'credential', required: true },
      { key: 'baseUrl', label: 'OData base URL', kind: 'text', required: true, placeholder: 'https://1c.company.kz/base/odata/standard.odata' },
      { key: 'entity', label: 'Объект', kind: 'text', required: true, placeholder: 'Catalog_Номенклатура' },
      {
        key: 'operation',
        label: 'Операция',
        kind: 'select',
        required: true,
        options: [
          { value: 'list', label: 'Прочитать (список)' },
          { value: 'create', label: 'Создать' },
        ],
      },
      { key: 'filter', label: 'Фильтр ($filter)', kind: 'text', showIf: { field: 'operation', in: ['list'] }, placeholder: "Description eq 'Хлеб'" },
      { key: 'body', label: 'Данные (JSON)', kind: 'textarea', showIf: { field: 'operation', in: ['create'] } },
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
      assertPublicUrl(base); // SSRF: база 1С должна быть публично доступна (не внутренняя сеть)
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
