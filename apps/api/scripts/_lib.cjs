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

// Язык ответов сьюты. Пиннится ЯВНЫМ заголовком выбора (`X-Locale`), а не
// `Accept-Language`: подсказку браузера сервер маршрутизирует под рынок
// (русский браузер → казахский), и 70+ русских текстовых ассертов покраснели бы
// разом. Скрипты, которые проверяют САМ перевод, шлют свои заголовки явно.
const SUITE_LOCALE = process.env.SA6_SUITE_LOCALE || 'ru';

const MUTATIONS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

async function call(method, p, token, body, headers) {
  const merged = {
    'Content-Type': 'application/json',
    'X-Locale': SUITE_LOCALE,
    // Ключ повтора (core/idempotency) — АВТОМАТИЧЕСКИ на каждой мутации: иначе
    // ручки `required` (деньги, подпись, отправка сообщения) отвечали бы сьютам
    // `400 idempotency.key_required`. Ключ свой на каждый вызов — сьюту нужны
    // РАЗНЫЕ намерения; проверку повтора скрипты делают, передавая свой заголовок.
    ...(MUTATIONS.has(String(method).toUpperCase()) ? { 'Idempotency-Key': require('crypto').randomUUID() } : {}),
    ...(token ? { Authorization: 'Bearer ' + token } : {}),
    ...(headers || {}),
  };
  // `null` у вызывающего СНИМАЕТ заголовок. Нужно скриптам, которые проверяют
  // поведение БЕЗ явного выбора языка (что увидит гость с таким браузером):
  // иначе дефолтный X-Locale сьюты перебил бы то, что они и проверяют.
  for (const k of Object.keys(merged)) if (merged[k] === null || merged[k] === undefined) delete merged[k];
  const res = await fetch(BASE + p, {
    method,
    headers: merged,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return {
    status: res.status,
    ok: res.ok,
    json,
    code: json?.details?.code ?? null,
    // Ответ собран из снимка движка идемпотентности, а не исполнен заново
    replayed: res.headers.get('idempotent-replayed') === 'true',
    shouldRetry: res.headers.get('x-should-retry'),
    retryAfter: res.headers.get('retry-after'),
  };
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

// ---- Кабинет платформы (core/platform): вход сотрудника и step-up в dev ----
// Код подтверждения берётся дев-ручкой движка verify (в production её нет).
const devCode = async (challengeId) => (await call('GET', `/verify/dev/last-code?challengeId=${challengeId}`)).json?.data?.code ?? null;

/** Полный вход в кабинет: пароль → код → токен кабинета (`aud: platform`). */
async function consoleLogin(phone, password = SUITE.password) {
  const start = await call('POST', '/platform/auth/start', null, { phone, password });
  if (!start.ok) return { start, token: null };
  const code = await devCode(start.json.data.challengeId);
  const chk = await call('POST', '/verify/check', null, { challengeId: start.json.data.challengeId, code });
  if (!chk.ok) return { start, chk, token: null };
  const res = await call('POST', '/platform/auth/login', null, { verifyToken: chk.json.data.verifyToken });
  return { start, chk, login: res, token: res.json?.data?.accessToken ?? null };
}

/** Окно sudo для команд high/critical. */
async function consoleSudo(token, password = SUITE.password) {
  const st = await call('POST', '/platform/auth/step-up/start', token, { password });
  if (!st.ok) return st;
  const code = await devCode(st.json.data.challengeId);
  const chk = await call('POST', '/verify/check', null, { challengeId: st.json.data.challengeId, code });
  if (!chk.ok) return chk;
  return call('POST', '/platform/auth/step-up/confirm', token, { verifyToken: chk.json.data.verifyToken });
}

module.exports = { BASE, SUITE, SUITE_LOCALE, call, login, makeChecker, devCode, consoleLogin, consoleSudo };
