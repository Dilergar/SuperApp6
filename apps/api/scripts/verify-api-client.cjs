// Транспорт границы (@superapp/api-client) против ЖИВОГО API. До этого скрипта самая
// дорогая логика клиентов — single-flight ротация refresh — проверялась только глазами
// в браузере. Здесь: подстановка токена, восстановление после протухшего access,
// РОВНО ОДНА ротация на пачку параллельных 401, onAuthFailure при мёртвом refresh,
// доставка X-Workspace-Id (инъекция getWorkspaceId). Заодно закрывает единственную
// ручку, которую не покрывал ни один сьют, — GET /wallet/history (форма CursorPage
// цельной страницей + `scale` на каждой строке).
//
// Требует собранного пакета: pnpm --filter @superapp/api-client build (CI собирает
// его до старта API — см. .github/workflows/ci.yml).
const { BASE, SUITE, makeChecker } = require('./_lib.cjs');
const {
  createApiClient,
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
} = require('../../../packages/api-client/dist/index.js');

const { check, finish } = makeChecker();

// Хранилище в памяти со счётчиками записей: single-flight доказывается тем, что на
// пачку параллельных 401 access-токен ПЕРЕЗАПИСАН ровно один раз.
function memStorage() {
  const m = new Map();
  const writes = { access: 0, refresh: 0 };
  return {
    map: m,
    writes,
    storage: {
      get: (k) => m.get(k) ?? null,
      set: (k, v) => {
        if (k === ACCESS_TOKEN_KEY) writes.access += 1;
        if (k === REFRESH_TOKEN_KEY) writes.refresh += 1;
        m.set(k, v);
      },
      remove: (k) => {
        m.delete(k);
      },
    },
  };
}

async function main() {
  console.log('== verify-api-client (транспорт границы) ==');

  // --- 1. Логин и подстановка токена ---
  let authFailed = false;
  const st = memStorage();
  const client = createApiClient({
    baseURL: BASE,
    storage: st.storage,
    onAuthFailure: () => {
      authFailed = true;
    },
  });

  const tokens = await client.apiPost('/auth/login', { phone: SUITE.p1, password: SUITE.password });
  check('логин отдал пару токенов', !!tokens?.accessToken && !!tokens?.refreshToken);
  st.map.set(ACCESS_TOKEN_KEY, tokens.accessToken);
  st.map.set(REFRESH_TOKEN_KEY, tokens.refreshToken);

  const me = await client.apiGet('/users/me');
  check('apiGet<T> распаковал конверт (профиль с id)', typeof me?.id === 'string', me?.id);
  check('токен подставлен (профиль — суточный аккаунт сьюта)', me?.phone === SUITE.p1, me?.phone);

  // --- 2. GET /wallet/history: страница ЦЕЛЬНАЯ + scale на строке ---
  // Тест-пополнение кошелька скинов гарантирует хотя бы одну проводку в журнале.
  await client.apiPost('/card-skins/wallet/topup', { amount: 5 });
  const history = await client.apiGet('/wallet/history');
  check('история кошелька — страница {items, nextCursor} цельной', Array.isArray(history?.items) && 'nextCursor' in (history ?? {}));
  check('в истории есть хотя бы одна строка', (history?.items?.length ?? 0) >= 1);
  const row = history?.items?.[0];
  check('строка: id строкой (BigInt на проводе)', typeof row?.id === 'string');
  check('строка: amount числом', typeof row?.amount === 'number');
  check('строка: scale числом (масштаб валюты доехал)', typeof row?.scale === 'number', `scale=${row?.scale}`);

  // --- 3. Single-flight: пачка параллельных 401 → ровно одна ротация ---
  st.map.set(ACCESS_TOKEN_KEY, 'broken-access-token');
  st.writes.access = 0;
  st.writes.refresh = 0;
  const [r1, r2, r3] = await Promise.all([
    client.apiGet('/users/me'),
    client.apiGet('/users/me'),
    client.apiGet('/users/me'),
  ]);
  check('все три запроса пережили протухший access', !!r1?.id && !!r2?.id && !!r3?.id);
  check('ротация refresh прошла РОВНО один раз (single-flight)', st.writes.access === 1 && st.writes.refresh === 1, `access=${st.writes.access} refresh=${st.writes.refresh}`);
  check('refresh-токен действительно ротирован', st.map.get(REFRESH_TOKEN_KEY) !== tokens.refreshToken);
  check('onAuthFailure НЕ звался на живой сессии', authFailed === false);

  // --- 4. Мёртвый refresh → onAuthFailure + токены стёрты ---
  const rotatedRefresh = st.map.get(REFRESH_TOKEN_KEY); // погасим штатно в уборке
  st.map.set(ACCESS_TOKEN_KEY, 'broken-access-token');
  st.map.set(REFRESH_TOKEN_KEY, 'broken-refresh-token');
  let threw = false;
  try {
    await client.apiGet('/users/me');
  } catch {
    threw = true;
  }
  check('запрос с мёртвой парой токенов честно упал', threw);
  check('onAuthFailure вызван', authFailed === true);
  check('транспорт стёр оба токена', !st.map.has(ACCESS_TOKEN_KEY) && !st.map.has(REFRESH_TOKEN_KEY));

  // --- 5. getWorkspaceId → заголовок X-Workspace-Id реально едет ---
  // Чужой (несуществующий) id организации: chokepoint fail-closed отвечает 403 на
  // ЛЮБОЙ запрос с заголовком — это и доказывает, что заголовок доставлен.
  const st2 = memStorage();
  const wsClient = createApiClient({
    baseURL: BASE,
    storage: st2.storage,
    getWorkspaceId: () => '00000000-0000-4000-8000-0000000000ff',
  });
  const tokens2 = await client.apiPost('/auth/login', { phone: SUITE.p1, password: SUITE.password });
  st2.map.set(ACCESS_TOKEN_KEY, tokens2.accessToken);
  st2.map.set(REFRESH_TOKEN_KEY, tokens2.refreshToken);
  let wsStatus = null;
  try {
    await wsClient.apiGet('/users/me');
  } catch (e) {
    wsStatus = e?.response?.status ?? null;
  }
  check('X-Workspace-Id доставлен (fail-closed 403 на чужой организации)', wsStatus === 403, `status=${wsStatus}`);

  // --- Уборка: выданные пары гасим штатно (сессии сьюта не копим) ---
  st2.map.set(ACCESS_TOKEN_KEY, tokens2.accessToken); // логаут под живым токеном, без ws-заголовка
  st.map.set(ACCESS_TOKEN_KEY, tokens2.accessToken);
  if (rotatedRefresh) await client.apiPost('/auth/logout', { refreshToken: rotatedRefresh }).catch(() => undefined);
  await client.apiPost('/auth/logout', { refreshToken: tokens2.refreshToken }).catch(() => undefined);

  finish();
}

main().catch((e) => {
  console.error('FATAL', e?.response?.status ?? '', e?.message ?? e);
  process.exit(1);
});
