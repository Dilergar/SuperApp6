/**
 * ДВЕРЬ №1 наружу: адрес пришёл ИЗ ДАННЫХ (конфиг ноды Процессов, настройка
 * организации, ввод человека) — то есть его выбирает не оператор, а пользователь.
 * Такой адрес обязан пройти SSRF-щит: приватные сети, метаданные облака и
 * DNS-rebinding закрыты, редиректы проходятся вручную с реперепроверкой хопа.
 *
 * Для сидекаров из .env (редактор документов, Gotenberg, NCANode, whisper, SMS-шлюз)
 * эта дверь НЕ ГОДИТСЯ: их адреса приватны по построению (localhost:9980,
 * host.docker.internal), и щит отверг бы их первым же условием. Им — дверь №2,
 * `trustedFetch` в соседнем файле.
 *
 * Правило платформы: голый `fetch` в apps/api запрещён линтером; исключений ровно
 * два — внутренности этих двух дверей. Поэтому «кто ходит наружу» — это один поиск
 * по двум именам, а не вычитывание всей кодовой базы.
 */
import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';

// ============================================================
// SSRF-защита (A12). Регекс по хосту обходится: DNS-rebinding, 302→metadata,
// octal/hex/decimal-IPv4 (http://2130706433, http://0x7f000001, http://127.1),
// IPv6-mapped (::ffff:127.0.0.1). Здесь: (1) числовой разбор IP во ВСЕХ формах +
// классификация приватных диапазонов, (2) резолв DNS и проверка КАЖДОГО адреса до
// соединения, (3) ручной follow редиректов с реперепроверкой каждого хопа и снятием
// Authorization при кросс-хост редиректе. Пин соединения к валидному IP (полное
// закрытие TOCTOU) потребовал бы undici-диспетчера — вне scope P0; окно rebind узкое.
// ============================================================

/** IPv4 (uint32) во внутренней сети/зарезервирован (loopback/link-local/metadata/приватные). */
function isPrivateIpv4Num(n: number): boolean {
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && ((n >>> 8) & 0xff) === 0) return true; // 192.0.0/24
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return false;
}

/** inet_aton-разбор: 1–4 части, каждая dec / 0oct / 0xhex (так резолвят браузеры и curl). */
function parseLooseIpv4(host: string): number | null {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const vals: number[] = [];
  for (const p of parts) {
    if (!/^(0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*|0)$/i.test(p)) return null;
    const v = /^0x/i.test(p) ? parseInt(p, 16) : /^0[0-7]+$/.test(p) ? parseInt(p, 8) : parseInt(p, 10);
    if (!Number.isFinite(v) || v < 0) return null;
    vals.push(v);
  }
  const n = vals.length;
  let result: number;
  if (n === 1) {
    if (vals[0] > 0xffffffff) return null;
    result = vals[0];
  } else if (n === 2) {
    if (vals[0] > 0xff || vals[1] > 0xffffff) return null;
    result = vals[0] * 0x1000000 + vals[1];
  } else if (n === 3) {
    if (vals[0] > 0xff || vals[1] > 0xff || vals[2] > 0xffff) return null;
    result = vals[0] * 0x1000000 + vals[1] * 0x10000 + vals[2];
  } else {
    if (vals.some((v) => v > 0xff)) return null;
    result = vals[0] * 0x1000000 + vals[1] * 0x10000 + vals[2] * 0x100 + vals[3];
  }
  return result >>> 0;
}

/** IPv6-литерал во внутренней сети (loopback/ULA/link-local/multicast/IPv4-mapped). */
function isPrivateIpv6(raw: string): boolean {
  const s = raw.replace(/^\[|\]$/g, '').toLowerCase();
  if (s === '::1' || s === '::') return true;
  const mapped = s.match(/^::ffff:(.+)$/i);
  if (mapped) {
    const tail = mapped[1];
    if (tail.includes('.')) {
      const n = parseLooseIpv4(tail);
      return n === null ? true : isPrivateIpv4Num(n);
    }
    return true; // hex-embedded ::ffff:7f00:1 — считаем приватным консервативно
  }
  if (/^fe[89ab]/.test(s)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(s)) return true; // fc00::/7 ULA
  if (/^ff/.test(s)) return true; // ff00::/8 multicast
  return false;
}

/** Хост — литерал IP во внутренней сети? null = это имя хоста (нужен DNS-резолв). */
function literalHostIsPrivate(host: string): boolean | null {
  const h = host.replace(/^\[|\]$/g, '');
  if (isIP(h) === 6 || h.includes(':')) return isPrivateIpv6(h);
  const n = parseLooseIpv4(h);
  if (n !== null) return isPrivateIpv4Num(n);
  return null; // не IP-литерал → имя хоста
}

/**
 * ПОВЕРХНОСТНАЯ (синхронная) SSRF-проверка URL: протокол + литеральный IP/явно-внутреннее имя.
 *
 * ⚠️ САМА ПО СЕБЕ НИЧЕГО НЕ ГАРАНТИРУЕТ и дверью не является. Имя хоста она не резолвит:
 * `http://evil.example.com` с A-записью на 169.254.169.254 проходит её насквозь
 * (`literalHostIsPrivate` возвращает для имени null). Это ровно та неполная проверка, из-за
 * которой случился SSRF, найденный ревью 2026-07-25.
 *
 * Законное применение ровно одно: дешёвый предварительный отказ ПЕРЕД `safeFetch`/`fetchJson`
 * — чтобы человеку, вписавшему `http://localhost` в конфиг ноды, ответить сразу и понятно.
 * Настоящую защиту (DNS-резолв каждого адреса, реперепроверка каждого хопа редиректа) делает
 * `safeFetch`. Связка «эта проверка + `trustedFetch`» защитой НЕ является: у `trustedFetch`
 * щита нет по определению.
 */
export function assertPublicUrlShallow(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Некорректный URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Разрешены только http/https');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('Запрещён адрес внутренней сети');
  }
  if (literalHostIsPrivate(u.hostname) === true) throw new Error('Запрещён адрес внутренней сети');
  return u;
}

/** Проверка резолвленного имени: КАЖДЫЙ адрес должен быть публичным (ловит имена → приватный IP + metadata). */
async function assertResolvedPublic(hostname: string): Promise<void> {
  if (literalHostIsPrivate(hostname) !== null) return; // литерал IP уже проверен синхронно
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dnsPromises.lookup(hostname, { all: true });
  } catch {
    throw new Error('Не удалось разрешить имя хоста');
  }
  if (addrs.length === 0) throw new Error('Имя хоста не разрешается');
  for (const a of addrs) {
    const priv =
      a.family === 6
        ? isPrivateIpv6(a.address)
        : ((): boolean => {
            const n = parseLooseIpv4(a.address);
            return n === null ? true : isPrivateIpv4Num(n);
          })();
    if (priv) throw new Error('Хост указывает во внутреннюю сеть');
  }
}

/** Нормализовать заголовки к mutable-объекту (для снятия Authorization при кросс-хост редиректе). */
function toHeaderRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) h.forEach((v, k) => (out[k] = v));
  else if (Array.isArray(h)) for (const [k, v] of h) out[k] = v;
  else Object.assign(out, h);
  return out;
}

/**
 * SSRF-безопасный fetch: валидирует URL и все резолвленные IP до соединения, вручную
 * следует редиректам с реперепроверкой каждого хопа, снимает Authorization при уходе на
 * другой хост. Единый выход наружу для всех процесс-нод (HTTP/1С/агентский http_get/KZ).
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number; maxRedirects?: number } = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = assertPublicUrlShallow(rawUrl);
    await assertResolvedPublic(url.hostname);
    let method = (init.method ?? 'GET').toUpperCase();
    let body = init.body;
    let headers = toHeaderRecord(init.headers);
    for (let hop = 0; ; hop++) {
      // eslint-disable-next-line no-restricted-globals -- внутренности двери: тот самый один законный fetch
      const res = await fetch(url.toString(), { ...init, method, body, headers, redirect: 'manual', signal: controller.signal });
      const isRedirect = res.status >= 301 && res.status <= 308 && res.status !== 304 && res.status !== 305 && res.status !== 306;
      if (!isRedirect) return res;
      const loc = res.headers.get('location');
      if (!loc) return res; // редирект без Location — отдаём как есть
      if (hop >= maxRedirects) throw new Error('Слишком много редиректов');
      const prevHost = url.host;
      const next = assertPublicUrlShallow(new URL(loc, url).toString());
      await assertResolvedPublic(next.hostname);
      if (next.host !== prevHost) {
        // кросс-хост: не утекаем креды на новый хост (как браузеры).
        // x-api-key — ключ Anthropic (process-ai-client шлёт его именно так): без него
        // в списке подставной редирект уводил бы ключ организации на чужой хост.
        for (const k of Object.keys(headers)) {
          if (/^authorization$/i.test(k) || /^cookie$/i.test(k) || /^x-api-key$/i.test(k)) delete headers[k];
        }
      }
      // 303 и 301/302-для-не-GET → GET без тела; 307/308 сохраняют метод/тело
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET';
        body = undefined;
      }
      url = next;
    }
  } finally {
    clearTimeout(timer);
  }
}

/** fetch с таймаутом + лимитом размера ответа; парсит JSON если можно. SSRF-безопасен (safeFetch). */
export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = 15_000,
): Promise<{ status: number; ok: boolean; body: unknown }> {
  const res = await safeFetch(url, init, { timeoutMs });
  const text = (await res.text()).slice(0, 100_000);
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* не JSON */
  }
  return { status: res.status, ok: res.ok, body };
}
