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

// Устройство сьюты для журнала безопасности (core/audit, заголовок `X-Device-Id`). ОДНО и то же
// во всех прогонах: первое устройство аккаунта доверено сразу, поэтому cooling новой сессии
// (24 ч до завершения чужих сессий и смены пароля) не ломает сьюты, а «вход с нового
// устройства» не спамит уведомлениями. Сьюта, проверяющая именно новое устройство
// (verify-audit), шлёт свой заголовок явно.
const SUITE_DEVICE_ID = process.env.SA6_SUITE_DEVICE_ID || '5a6e5a6e-5a6e-4a6e-8a6e-5a6e5a6e0001';

async function call(method, p, token, body, headers) {
  const merged = {
    'Content-Type': 'application/json',
    'X-Locale': SUITE_LOCALE,
    'X-Device-Id': SUITE_DEVICE_ID,
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
    // Эхо id запроса (core/audit): тот же id — в `details.requestId` отказа и в событиях журнала
    requestId: res.headers.get('x-request-id'),
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

// ---- Организации сьюта (потолок `workspaces.maxOwned`) ----
// У владельца потолок — 20 ЖИВЫХ организаций (архивные не считаются). Сьют, который
// заводит организацию на каждый прогон и не убирает её, через 20 прогонов роняет ЧУЖИЕ
// сьюты: `402 entitlement.limit_reached` на POST /workspaces у скрипта, который ни в чём
// не виноват. Поэтому организацию сьют берёт ТОЛЬКО одним из двух хелперов:
//   ensureSuiteWorkspace(token, name)   — одна стабильная организация на все прогоны
//                                         (данные внутри копятся — годится, если сьют их не считает);
//   createSuiteWorkspace(token, prefix) — свежая на каждый прогон. В архив её отправляет
//                                         штатный DELETE /workspaces/:id в finish()/crash()
//                                         (скрипт со своим process.exit зовёт archiveSuiteWorkspaces()
//                                         в finally), а хвост упавшего прошлого прогона с тем же
//                                         префиксом уходит в архив ДО создания новой.
//                                         `{ purge: true }` — после архива удалить насовсем
//                                         штатным каскадом (`purgeWorkspace` через дев-ручку
//                                         `POST /workspaces/dev/purge-archives`), а не сырым Prisma:
//                                         для сьютов, чьи чаты/встречи не должны висеть у людей 90 дней.
// Повторный архив сервер не исполняет (переход status-guarded), уже удалённая (404) — не утечка.
// Имя — только с префиксом `Сьют-`: его знает gc-test-workspaces.cjs. Два параллельных
// прогона ОДНОГО сьюта архивируют организации друг друга (CI гоняет сьюты по очереди).
const SUITE_WS_PREFIX = 'Сьют-';
const runWorkspaces = []; // { id, token, purge } — организации ЭТОГО прогона в порядке создания

const subOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
// «Сьют-Объекты 1727…» — прогон префикса «Сьют-Объекты»; «Сьют-Объекты-Чужая …» — уже нет
const isRunOf = (name, prefix) => name === prefix || String(name ?? '').startsWith(prefix + ' ');

function assertSuiteName(name) {
  if (!String(name).startsWith(SUITE_WS_PREFIX)) {
    throw new Error(`suite workspace name must start with "${SUITE_WS_PREFIX}" (gc-test-workspaces.cjs knows it): ${name}`);
  }
}

/** Живые организации префикса, которыми ВЛАДЕЕТ обладатель токена. */
async function ownedRuns(token, prefix) {
  const me = subOf(token);
  const r = await call('GET', '/workspaces', token);
  if (!r.ok) throw new Error(`GET /workspaces: ${r.status} ${r.code ?? ''}`);
  return (r.json?.data ?? []).filter((w) => w.ownerId === me && isRunOf(w.name, prefix));
}

async function archiveOne(token, id, purge = false) {
  const r = await call('DELETE', `/workspaces/${id}`, token).catch((e) => ({ ok: false, status: 0, code: e.message }));
  // 404 — сьют сам удалил её насовсем (проверка ретеншна): слот свободен, утечки нет
  if (r.status === 404) return true;
  if (!r.ok) {
    console.log(`✗ FAIL  организация сьюта ${id} не ушла в архив (${r.status} ${r.code ?? ''}) — её уберёт следующий прогон или gc-test-workspaces.cjs`);
    return false;
  }
  if (!purge) return true;
  // Вне development/test дев-ручки нет (404) — тогда организация остаётся в архиве: слот свободен
  const pr = await call('POST', '/workspaces/dev/purge-archives', token, { workspaceId: id }).catch((e) => ({ ok: false, status: 0, code: e.message }));
  if (!pr.ok && pr.status !== 404) {
    console.log(`✗ FAIL  организация сьюта ${id} в архиве, но не удалена насовсем (${pr.status} ${pr.code ?? ''})`);
    return false;
  }
  return true;
}

/**
 * Одна организация на все прогоны: берётся живая по имени/префиксу, иначе создаётся.
 * Возвращает саму организацию (`json.data`), не ответ call().
 */
async function ensureSuiteWorkspace(token, name) {
  assertSuiteName(name);
  const [found] = await ownedRuns(token, name);
  if (found) return found;
  const created = await call('POST', '/workspaces', token, { name });
  if (!created.ok) throw new Error(`suite workspace not created: ${created.status} ${created.code ?? ''}`);
  return created.json.data;
}

/**
 * Свежая организация прогона `«<prefix> <метка>»`. Возвращает ответ call() — как голый
 * POST /workspaces, поэтому проверки `ws.ok` / `ws.json.data` в скриптах не меняются.
 * `body` — прочие поля создания (например, `consents`).
 */
async function createSuiteWorkspace(token, prefix, body = {}, { purge = false } = {}) {
  await sweepSuiteWorkspaces(token, prefix, { purge });
  const r = await call('POST', '/workspaces', token, { ...body, name: `${prefix} ${Date.now()}` });
  if (r.ok && r.json?.data?.id) runWorkspaces.push({ id: r.json.data.id, token, purge });
  return r;
}

/**
 * Хвосты прошлых прогонов префикса (упал до уборки, убит Ctrl+C) — в архив. Свои
 * организации ЭТОГО прогона не трогает: сьют может завести несколько с одним префиксом.
 * Зовётся из createSuiteWorkspace; отдельно — когда сьют меряет счётчик организаций
 * ДО создания (иначе уборка хвоста внутри создания сдвинула бы замер).
 */
async function sweepSuiteWorkspaces(token, prefix, { purge = false } = {}) {
  assertSuiteName(prefix);
  for (const w of await ownedRuns(token, prefix)) {
    if (!runWorkspaces.some((x) => x.id === w.id)) await archiveOne(token, w.id, purge);
  }
}

/** В архив раньше конца прогона (освободить слот, проверить поведение после архива). */
async function archiveSuiteWorkspace(id) {
  const i = runWorkspaces.findIndex((w) => w.id === id);
  if (i < 0) return true;
  const [{ token, purge }] = runWorkspaces.splice(i, 1);
  return archiveOne(token, id, purge);
}

/**
 * Все организации прогона — в архив (последняя созданная первой). Возвращает число неудач.
 * `token` — если токен создателя к концу прогона отозван, архивировать другим токеном владельца.
 */
async function archiveSuiteWorkspaces(token) {
  let failed = 0;
  while (runWorkspaces.length) {
    const w = runWorkspaces.pop();
    if (!(await archiveOne(token ?? w.token, w.id, w.purge))) failed += 1;
  }
  return failed;
}

/** Обработчик падения: `main().catch(crash)` — организации прогона в архив, выход 1. */
async function crash(e) {
  console.error('CRASH', e);
  await archiveSuiteWorkspaces().catch(() => undefined);
  process.exit(1);
}

// Счётчик проверок: const { check, finish } = makeChecker();
// finish() отправляет организации прогона в архив (process.exit не ждёт finally),
// печатает итог и выставляет exit-код (CI считает не-ноль падением).
function makeChecker() {
  let fails = 0;
  const check = (name, ok, extra) => {
    console.log(`${ok ? '✓' : '✗ FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
    if (!ok) fails += 1;
  };
  const exit = () => {
    console.log(fails === 0 ? '\n✅ ALL PASS' : `\n❌ ${fails} FAIL`);
    process.exit(fails === 0 ? 0 : 1);
  };
  const finish = () => {
    if (runWorkspaces.length === 0) return exit();
    // Незаархивированная организация — такое же падение, как проверка: она роняет чужие сьюты
    return archiveSuiteWorkspaces().then((failed) => {
      fails += failed;
      exit();
    });
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

module.exports = {
  BASE, SUITE, SUITE_LOCALE, SUITE_DEVICE_ID, call, login, makeChecker, devCode, consoleLogin, consoleSudo,
  ensureSuiteWorkspace, createSuiteWorkspace, sweepSuiteWorkspaces, archiveSuiteWorkspace, archiveSuiteWorkspaces, crash,
};
