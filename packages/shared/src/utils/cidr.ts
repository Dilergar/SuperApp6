// ============================================================
// IP-allowlist ключей (core/keys): разбор CIDR и проверка вхождения адреса
// ============================================================
// Общий для API (проверка при обращении ключом) и клиентов (валидация формы):
// одна реализация — одно понимание «что такое допустимая запись».

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseV4(s: string): bigint | null {
  const m = V4.exec(s);
  if (!m) return null;
  let out = 0n;
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8n) | BigInt(n);
  }
  return out;
}

function parseV6(s: string): bigint | null {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || s.indexOf(':') < 0) return null;
  // IPv4-mapped хвост (::ffff:1.2.3.4) — разворачиваем в два хекстета
  let str = s;
  const lastColon = str.lastIndexOf(':');
  if (str.indexOf('.') >= 0) {
    const v4 = parseV4(str.slice(lastColon + 1));
    if (v4 === null) return null;
    str = `${str.slice(0, lastColon)}:${((v4 >> 16n) & 0xffffn).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tail.length > 7) return null;
  const groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out = (out << 16n) | BigInt(parseInt(g, 16));
  }
  return out;
}

export interface ParsedCidr {
  family: 4 | 6;
  base: bigint;
  bits: number;
}

/** `1.2.3.4`, `1.2.3.0/24`, `2001:db8::/32` → структура; иначе null. */
export function parseCidr(entry: string): ParsedCidr | null {
  const raw = entry.trim();
  if (!raw) return null;
  const slash = raw.indexOf('/');
  const addr = slash >= 0 ? raw.slice(0, slash) : raw;
  const prefix = slash >= 0 ? raw.slice(slash + 1) : null;
  const v4 = parseV4(addr);
  const family: 4 | 6 | null = v4 !== null ? 4 : parseV6(addr) !== null ? 6 : null;
  if (!family) return null;
  const max = family === 4 ? 32 : 128;
  let bits = max;
  if (prefix !== null) {
    if (!/^\d{1,3}$/.test(prefix)) return null;
    bits = Number(prefix);
    if (bits < 0 || bits > max) return null;
  }
  const value = family === 4 ? v4! : parseV6(addr)!;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits);
  return { family, base: value & mask, bits };
}

export function isValidCidr(entry: string): boolean {
  return parseCidr(entry) !== null;
}

/** Входит ли адрес (как его видит `req.ip`) в запись allowlist. IPv4-mapped IPv6 сравнивается как IPv4. */
export function ipInCidr(ip: string, entry: string | ParsedCidr): boolean {
  const cidr = typeof entry === 'string' ? parseCidr(entry) : entry;
  if (!cidr) return false;
  let addr = ip.trim();
  if (addr.startsWith('::ffff:') && addr.indexOf('.') > 0) addr = addr.slice(7);
  const v4 = parseV4(addr);
  const family: 4 | 6 | null = v4 !== null ? 4 : parseV6(addr) !== null ? 6 : null;
  if (!family || family !== cidr.family) return false;
  const value = family === 4 ? v4! : parseV6(addr)!;
  const max = family === 4 ? 32 : 128;
  const mask = cidr.bits === 0 ? 0n : ((1n << BigInt(cidr.bits)) - 1n) << BigInt(max - cidr.bits);
  return (value & mask) === cidr.base;
}

/** Есть ли адрес хотя бы в одной записи списка (пустой список = список не задан → true). */
export function ipAllowed(ip: string | null | undefined, allowlist: readonly string[] | null | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  if (!ip) return false;
  return allowlist.some((e) => ipInCidr(ip, e));
}
