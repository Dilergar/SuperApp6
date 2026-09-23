import { isIP } from 'node:net';
import { redactSecrets } from '../../shared/utils/redact';

// ============================================================
// core/audit — нормализация всего, что попадает в журнал (инъекции в логи, секреты)
// ============================================================
// Журнал читают люди глазами и SIEM парсерами. Строка с CR/LF подделывает соседнюю запись,
// ESC-последовательность перекрашивает терминал, bidi-переопределение переворачивает текст
// (CVE-2021-42574), NUL ломает драйверы. Детали — allow-list Zod (коды и числа), но
// подписи-снимки (`target_label`) и обоснования админов — текст: он проходит здесь.

// Управляющие C0/C1 (кроме пробела), разделители строк и абзацев Unicode (U+2028/U+2029 — перевод
// строки для JS, JSON-парсеров и части просмотрщиков логов), ESC-последовательности ANSI,
// bidi-переопределения, нулевой ширины
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const BIDI_RE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** Текст для журнала: NFKC, без управляющих и bidi, секреты по образцу — масками, длина — потолком. */
export function normalizeAuditText(value: string, max = 500): string {
  const clean = value.normalize('NFKC').replace(ANSI_RE, '').replace(CONTROL_RE, ' ').replace(BIDI_RE, '').replace(/\s{2,}/g, ' ').trim();
  const redacted = redactSecrets(clean);
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

/**
 * Глубокая нормализация значения деталей: строки — `normalizeAuditText`, объекты и массивы —
 * рекурсивно (глубина ≤ 6, ≤ 200 ключей на уровень), прототипные ключи выбрасываются.
 * Снимки Кабинета (`input/before/after`) УЖЕ замаскированы декларацией команды — это
 * второй пояс: секрет по образцу (ключ API, JWT, пароль в поле) маскируется и здесь.
 */
export function normalizeAuditValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return normalizeAuditText(value, 2_000);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (depth >= 6) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => normalizeAuditValue(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (n++ >= 200) break;
      out[normalizeAuditText(k, 64)] = normalizeAuditValue(v, depth + 1);
    }
    return out;
  }
  return null;
}

/**
 * Сеть адреса: IPv4 → /24, IPv6 → /48 (адрес, отображённый в IPv6 `::ffff:a.b.c.d`, — как IPv4).
 * Сеть — то, что можно показать сотруднику безопасности без раскрытия адреса человека,
 * и то, по чему видна атака «со всей подсети» (CGNAT в РК: один /24 — тысячи людей).
 */
export function ipNetOf(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const raw = ip.trim().replace(/^::ffff:/i, '');
  const kind = isIP(raw);
  if (kind === 4) {
    const p = raw.split('.');
    return `${p[0]}.${p[1]}.${p[2]}.0/24`;
  }
  if (kind === 6) {
    const groups = expandIpv6(raw);
    return groups ? `${groups.slice(0, 3).join(':')}::/48` : null;
  }
  return null;
}

/** Нормальная форма IP для HMAC-псевдонима (один адрес — один псевдоним в любой записи). */
export function canonicalIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const raw = ip.trim().replace(/^::ffff:/i, '');
  const kind = isIP(raw);
  if (kind === 4) return raw;
  if (kind === 6) return expandIpv6(raw)?.join(':') ?? null;
  return null;
}

function expandIpv6(ip: string): string[] | null {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  if (tail === undefined && h.length !== 8) return null;
  const missing = 8 - h.length - t.length;
  if (missing < 0) return null;
  const all = [...h, ...Array(tail !== undefined ? missing : 0).fill('0'), ...t];
  return all.length === 8 ? all.map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')) : null;
}

/**
 * Подпись адреса (вебхук) для журнала: схема, хост, порт и путь — без userinfo, query и
 * фрагмента (там живут токены и подписи). Неразборчивая строка — нормализованный текст.
 */
export function urlLabel(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return normalizeAuditText(`${u.protocol}//${u.host}${u.pathname}`, 300);
  } catch {
    return normalizeAuditText(url.split(/[?#]/)[0] ?? '', 300);
  }
}
