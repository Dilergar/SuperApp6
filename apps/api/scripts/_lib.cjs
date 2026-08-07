// Общая обвязка verify-скриптов (CLAUDE.md, плейбук п.7). НЕ копировать в скрипты —
// require('./_lib.cjs'). До неё HTTP/логин/чекер/чтение .env были скопированы в
// 58 файлах в 7 разъехавшихся вариантах (3 несовместимых имени env-переменной BASE).
// Новые скрипты берут отсюда; старые мигрируют при следующей правке.
const fs = require('fs');
const path = require('path');

// .env API — тот же мини-парсер, что жил в каждом скрипте, теперь в одном месте.
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// Все три исторических имени переменной принимаются — скрипты расходились в них годами.
const BASE =
  process.env.SA6_API_BASE ||
  process.env.API_URL ||
  process.env.API_BASE ||
  'http://localhost:3001/api';

// Аккаунты СЬЮТА. НЕ tester1/2/3 (+7700123…) — те живые, в них человек работает в браузере.
const SUITE = {
  p1: '+77009990001',
  p2: '+77009990002',
  p3: '+77009990003',
  password: 'Test1234!',
};

async function call(method, p, token, body, headers) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, ok: res.ok, json, code: json?.details?.code ?? null };
}

// Логин без лишнего запроса: id берётся из `sub` самого токена (профиль логин не отдаёт).
async function login(phone, password = SUITE.password) {
  const r = await call('POST', '/auth/login', null, { phone, password });
  if (!r.ok) throw new Error(`login ${phone}: ${r.status} ${JSON.stringify(r.json)}`);
  const token = r.json.data.accessToken;
  const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  return { token, id: sub };
}

// Счётчик проверок: const { check, finish } = makeChecker();
// finish() печатает итог и выставляет exit-код (CI считает не-ноль падением).
function makeChecker() {
  let fails = 0;
  const check = (name, ok, extra) => {
    console.log(`${ok ? '✓' : '✗ FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
    if (!ok) fails += 1;
  };
  const finish = () => {
    console.log(fails === 0 ? '\n✅ ALL PASS' : `\n❌ ${fails} FAIL`);
    process.exit(fails === 0 ? 0 : 1);
  };
  return {
    check,
    finish,
    get fails() {
      return fails;
    },
  };
}

module.exports = { BASE, SUITE, call, login, makeChecker };
