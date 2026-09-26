import { z } from 'zod';
import type { NodeRunContext, ProcessNodeProvider } from './process-node.types';
import { decryptCredential } from './process-crypto';
// Обе двери наружу живут в shared/http (общая инфраструктура): их импортируют и
// движки core/*, а движок не имеет права зависеть от фичи. Реэкспорт — чтобы у
// соседей по модулю Процессов не менялся путь импорта.
export { assertPublicUrlShallow, fetchJson, safeFetch } from '../../shared/http';
import { assertPublicUrlShallow, safeFetch } from '../../shared/http';

/** Достать расшифрованный секрет креда из сейфа организации (для коннекторов). */
export async function loadCredentialSecret(
  ctx: NodeRunContext,
  credentialId: string,
): Promise<{ type: string; secret: Record<string, string> }> {
  const cred = await ctx.deps.db.processCredential.findUnique({ where: { id: credentialId } });
  if (!cred || cred.workspaceId !== ctx.workspaceId) throw new Error('the credential is not in the safe');
  return { type: cred.type, secret: JSON.parse(await decryptCredential(ctx.deps.keys, cred)) as Record<string, string> };
}

/** Любое поле-ключ из креда (token у bearer, headerValue у header, password у basic). */
export function credentialKey(secret: Record<string, string>): string {
  const key = secret.token ?? secret.headerValue ?? secret.password;
  if (!key) throw new Error('the credential carries no token or key');
  return key;
}

// ============================================================
// Сервисные ноды Ф3 — интеграции с внешним миром.
// HTTP-нода: универсальный коннектор (база для Kaspi/1С/любых REST API).
// ============================================================

/** HTTP-запрос наружу. Опциональные креды из сейфа организации. Подстановки {{form.x}}. */
export const httpNode: ProcessNodeProvider = {
  descriptor: {
    type: 'service.http',
    category: 'integration',
    icon: 'globe',
    tier: 'standard',
    io: true, // внешний HTTP → исполняется вне инстанс-лока (P3)
    // success/error — поток; astool — подключение к AI-Агенту как инструмент (один узел = действие И инструмент, модель n8n).
    outputs: [
      { key: 'success' },
      { key: 'error' },
      { key: 'astool', type: 'ai_tool' }
    ],
    fields: [
      { key: 'method', kind: 'select', required: true, options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { key: 'url', kind: 'text' },
      { key: 'headers', kind: 'textarea' },
      { key: 'body', kind: 'textarea' },
      { key: 'credentialId', kind: 'credential' }
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
      // Описание инструмента читает МОДЕЛЬ, а не человек — оно остаётся английским
      // (тот же довод, что у промптов: язык модели не следует за языком зрителя).
      description:
        'Read a public web page or API over HTTPS with a GET request; nothing is sent or changed. ' +
        'Use it when the task needs data from the internet. Only https:// addresses on the public internet work: ' +
        'internal and private addresses are refused, up to 5 redirects are followed, the wait is 15 seconds. ' +
        'Returns the HTTP status on the first line, then the response body as text, cut at 8000 characters. ' +
        'It cannot send headers, cookies or a request body.',
      schema: { type: 'object', properties: { url: { type: 'string', description: 'A full https:// URL, with the query string if the API needs one' } }, required: ['url'] },
      async execute(_ctx, input) {
        // URL выбирает LLM (prompt-injectable) → жёсткая SSRF-проверка обязательна.
        const url = String(input.url ?? '');
        if (!/^https:\/\//i.test(url)) throw new Error('only https:// URLs are allowed');
        const res = await safeFetch(url, { headers: { 'User-Agent': 'SuperApp6-Processes/1' } }, { timeoutMs: 15_000 });
        return `HTTP ${res.status}\n${(await res.text()).slice(0, 8000)}`;
      },
    },
  },
  async run(ctx) {
    const cfg = ctx.config as { method: string; url?: string; headers?: string; body?: string; credentialId?: string };
    try {
      if (!cfg.url) return { kind: 'complete', outputKey: 'error', output: { error: 'the URL is missing' } };
      const url = assertPublicUrlShallow(ctx.render(cfg.url));
      const headers: Record<string, string> = { 'User-Agent': 'SuperApp6-Processes/1' };
      if (cfg.headers) {
        try {
          const parsed = JSON.parse(ctx.render(cfg.headers));
          if (parsed && typeof parsed === 'object') {
            for (const [k, v] of Object.entries(parsed)) headers[k] = String(v);
          }
        } catch {
          throw new Error('the headers must be JSON');
        }
      }

      // Креды из сейфа организации.
      if (cfg.credentialId) {
        const cred = await ctx.deps.db.processCredential.findUnique({ where: { id: cfg.credentialId } });
        if (!cred || cred.workspaceId !== ctx.workspaceId) throw new Error('the credential was not found');
        const secret = JSON.parse(await decryptCredential(ctx.deps.keys, cred)) as Record<string, string>;
        if (cred.type === 'bearer') headers['Authorization'] = `Bearer ${secret.token}`;
        else if (cred.type === 'basic') headers['Authorization'] = `Basic ${Buffer.from(`${secret.username}:${secret.password}`).toString('base64')}`;
        else if (cred.type === 'header') headers[secret.headerName] = secret.headerValue;
      }

      const hasBody = cfg.method !== 'GET' && cfg.method !== 'DELETE' && cfg.body;
      if (hasBody && !headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';

      const res = await safeFetch(
        url.toString(),
        { method: cfg.method, headers, body: hasBody ? ctx.render(cfg.body!) : undefined },
        { timeoutMs: 15_000 },
      );
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
