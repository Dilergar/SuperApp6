import { z } from 'zod';
import type { NodeRunContext, ProcessNodeProvider } from './process-node.types';
import { decryptSecret } from './process-crypto';

/** Достать расшифрованный секрет креда из сейфа организации (для коннекторов). */
export async function loadCredentialSecret(
  ctx: NodeRunContext,
  credentialId: string,
): Promise<{ type: string; secret: Record<string, string> }> {
  const cred = await ctx.deps.db.processCredential.findUnique({ where: { id: credentialId } });
  if (!cred || cred.workspaceId !== ctx.workspaceId) throw new Error('Креды не найдены в сейфе');
  return { type: cred.type, secret: JSON.parse(decryptSecret(cred.data)) as Record<string, string> };
}

/** Любое поле-ключ из креда (token у bearer, headerValue у header, password у basic). */
export function credentialKey(secret: Record<string, string>): string {
  const key = secret.token ?? secret.headerValue ?? secret.password;
  if (!key) throw new Error('В кредах нет токена/ключа');
  return key;
}

/** fetch с таймаутом + лимитом размера ответа; парсит JSON если можно. */
export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = 15_000,
): Promise<{ status: number; ok: boolean; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
    const text = (await res.text()).slice(0, 100_000);
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* не JSON */
    }
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// Сервисные ноды Ф3 — интеграции с внешним миром.
// HTTP-нода: универсальный коннектор (база для Kaspi/1С/любых REST API).
// ============================================================

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?|metadata\.google\.internal)/i;

/** Базовая SSRF-защита: не пускаем процессы стучаться во внутреннюю сеть/метаданные. */
export function assertPublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Некорректный URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Разрешены только http/https');
  if (PRIVATE_HOST.test(u.hostname)) throw new Error('Запрещён адрес внутренней сети');
  return u;
}

/** HTTP-запрос наружу. Опциональные креды из сейфа организации. Подстановки {{form.x}}. */
export const httpNode: ProcessNodeProvider = {
  descriptor: {
    type: 'service.http',
    title: 'HTTP-запрос',
    description:
      'Вызывает внешний API (Kaspi, 1С, любой REST). Поддерживает подстановки {{form.поле}} в URL/теле, заголовки и креды из сейфа. Ответ доступен следующим шагам.',
    category: 'integration',
    icon: '🌐',
    tier: 'standard',
    // success/error — поток; astool — подключение к AI-Агенту как инструмент (один узел = действие И инструмент, модель n8n).
    outputs: [
      { key: 'success', label: 'Успех' },
      { key: 'error', label: 'Ошибка' },
      { key: 'astool', label: 'как инструмент', type: 'ai_tool' },
    ],
    fields: [
      {
        key: 'method',
        label: 'Метод',
        kind: 'select',
        required: true,
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m })),
      },
      { key: 'url', label: 'URL', kind: 'text', placeholder: 'https://api.example.kz/orders?since={{form.date}}', help: 'Для обычной ноды — обязательно. Как инструмент агента: URL подставляет сам агент (GET, чтение).' },
      { key: 'headers', label: 'Заголовки (JSON)', kind: 'textarea', placeholder: '{"Accept": "application/json"}' },
      { key: 'body', label: 'Тело запроса', kind: 'textarea', placeholder: '{"sum": {{form.sum}}}' },
      { key: 'credentialId', label: 'Креды (из сейфа)', kind: 'credential' },
    ],
    configSchema: z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      url: z.string().max(2000).optional(),
      headers: z.string().max(4000).optional(),
      body: z.string().max(20000).optional(),
      credentialId: z.string().uuid().optional(),
    }),
    auto: true,
    tool: {
      name: 'http_get',
      description: 'Получить данные по публичному HTTPS-URL (GET, только чтение). Возвращает тело ответа.',
      schema: { type: 'object', properties: { url: { type: 'string', description: 'Полный https URL' } }, required: ['url'] },
      async execute(_ctx, input) {
        const u = assertPublicUrl(String(input.url ?? ''));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const res = await fetch(u.toString(), { signal: controller.signal, headers: { 'User-Agent': 'SuperApp6-Processes/1' } });
          return (await res.text()).slice(0, 8000);
        } finally {
          clearTimeout(timer);
        }
      },
    },
  },
  async run(ctx) {
    const cfg = ctx.config as { method: string; url?: string; headers?: string; body?: string; credentialId?: string };
    try {
      if (!cfg.url) return { kind: 'complete', outputKey: 'error', output: { error: 'Укажите URL' } };
      const url = assertPublicUrl(ctx.render(cfg.url));
      const headers: Record<string, string> = { 'User-Agent': 'SuperApp6-Processes/1' };
      if (cfg.headers) {
        try {
          const parsed = JSON.parse(ctx.render(cfg.headers));
          if (parsed && typeof parsed === 'object') {
            for (const [k, v] of Object.entries(parsed)) headers[k] = String(v);
          }
        } catch {
          throw new Error('Заголовки должны быть JSON');
        }
      }

      // Креды из сейфа организации.
      if (cfg.credentialId) {
        const cred = await ctx.deps.db.processCredential.findUnique({ where: { id: cfg.credentialId } });
        if (!cred || cred.workspaceId !== ctx.workspaceId) throw new Error('Креды не найдены');
        const secret = JSON.parse(decryptSecret(cred.data)) as Record<string, string>;
        if (cred.type === 'bearer') headers['Authorization'] = `Bearer ${secret.token}`;
        else if (cred.type === 'basic') headers['Authorization'] = `Basic ${Buffer.from(`${secret.username}:${secret.password}`).toString('base64')}`;
        else if (cred.type === 'header') headers[secret.headerName] = secret.headerValue;
      }

      const hasBody = cfg.method !== 'GET' && cfg.method !== 'DELETE' && cfg.body;
      if (hasBody && !headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      let res: Response;
      try {
        res = await fetch(url.toString(), {
          method: cfg.method,
          headers,
          body: hasBody ? ctx.render(cfg.body!) : undefined,
          signal: controller.signal,
          redirect: 'follow',
        });
      } finally {
        clearTimeout(timer);
      }
      const text = (await res.text()).slice(0, 100_000); // защита от гигантских ответов
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* не JSON — оставляем текст */
      }
      return {
        kind: 'complete',
        outputKey: res.ok ? 'success' : 'error',
        output: { status: res.status, ok: res.ok, body: parsed },
      };
    } catch (err) {
      return { kind: 'complete', outputKey: 'error', output: { error: (err as Error).message } };
    }
  },
};

export const SERVICE_PROCESS_NODES: ProcessNodeProvider[] = [httpNode];
