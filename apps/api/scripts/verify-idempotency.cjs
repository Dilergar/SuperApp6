/* eslint-disable */
// ============================================================
// verify-idempotency.cjs — сьют движка идемпотентности повторов (core/idempotency).
//
//   node apps/api/scripts/verify-idempotency.cjs      (при запущенном API, dev)
//
// Аккаунты СЬЮТА (suite1–3), база НЕ чистится: дев-полигон движка убирает за собой
// сам (`/idempotency/dev/reset`). Эффект — строка-маркер в `idempotency_inbox`,
// сьют считает их: два маркера на один ключ означают двойной эффект.
// ============================================================
const { randomUUID } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { SUITE, call, login, makeChecker, createSuiteWorkspace, archiveSuiteWorkspace, crash } = require('./_lib.cjs');

const prisma = new PrismaClient();
const { check, finish } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Заголовки одного НАМЕРЕНИЯ: тот же ключ повтора на всех попытках. */
const withKey = (key, extra) => ({ 'Idempotency-Key': key, ...(extra || {}) });
/** Явно БЕЗ ключа (наш `call` ставит его сам на каждой мутации). */
const noKey = { 'Idempotency-Key': null };

const effects = async (token, tag) => (await call('GET', `/idempotency/dev/effects?tag=${tag}`, token)).json?.data?.count ?? -1;

async function main() {
  const u1 = await login(SUITE.p1);
  const u2 = await login(SUITE.p2);
  await call('POST', '/idempotency/dev/reset', u1.token, {});
  await call('POST', '/idempotency/dev/reset', u2.token, {});

  // ---------- 1. Форма ключа и обязательность ----------
  {
    const r = await call('POST', '/idempotency/dev/required', u1.token, { tag: 'x-' + randomUUID().slice(0, 8) }, noKey);
    check('required без ключа → 400 idempotency.key_required', r.status === 400 && r.code === 'idempotency.key_required', `${r.status} ${r.code}`);
  }
  {
    const r = await call('POST', '/idempotency/dev/required', u1.token, { tag: 'short' }, withKey('short'));
    check('ключ не той формы → 400 idempotency.key_invalid', r.status === 400 && r.code === 'idempotency.key_invalid', `${r.status} ${r.code}`);
  }
  {
    // Два заголовка = двусмысленность. fetch склеивает повтор через запятую —
    // сервер обязан увидеть форму «uuid, uuid» и отвергнуть её.
    const key = randomUUID();
    const r = await call('POST', '/idempotency/dev/required', u1.token, { tag: 'dbl' }, { 'Idempotency-Key': `${key}, ${randomUUID()}` });
    check('два ключа в заголовке → 400', r.status === 400 && r.code === 'idempotency.key_invalid', `${r.status} ${r.code}`);
  }

  // ---------- 2. Двадцать параллельных с ОДНИМ ключом ----------
  {
    const tag = 'par-' + randomUUID().slice(0, 8);
    const key = randomUUID();
    const rs = await Promise.all(
      Array.from({ length: 20 }, () => call('POST', '/idempotency/dev/required', u1.token, { tag }, withKey(key))),
    );
    const n = await effects(u1.token, tag);
    const ok201 = rs.filter((r) => r.status === 201).length;
    const inflight = rs.filter((r) => r.code === 'idempotency.in_flight');
    const done = rs.filter((r) => r.code === 'idempotency.already_completed').length;
    check('20 параллельных с одним ключом → ровно ОДИН эффект', n === 1, `эффектов ${n}`);
    // Три законных исхода параллельной волны: исполнение/реплей (201), «первая ещё
    // идёт» (in_flight) и «эффект уже закоммичен, ответа ещё нет» (already_completed)
    check('остальные — 201, in_flight либо already_completed', ok201 + inflight.length + done === 20, `201:${ok201} in_flight:${inflight.length} done:${done}`);
    check('409 in_flight несёт Retry-After и X-Should-Retry: true', inflight.every((r) => r.retryAfter && r.shouldRetry === 'true'), `${inflight.length}`);
    // Последовательный повтор УЖЕ завершённого — реплей со снимком
    const replay = await call('POST', '/idempotency/dev/required', u1.token, { tag }, withKey(key));
    check('повтор после завершения — реплей (Idempotent-Replayed: true)', replay.replayed === true && replay.status === 201, `${replay.status} replayed=${replay.replayed}`);
    check('и второго эффекта он не создал', (await effects(u1.token, tag)) === 1, '');
  }

  // ---------- 3. Тот же ключ с ДРУГИМ телом ----------
  {
    const key = randomUUID();
    const tag = 'fp-' + randomUUID().slice(0, 8);
    await call('POST', '/idempotency/dev/required', u1.token, { tag }, withKey(key));
    const r = await call('POST', '/idempotency/dev/required', u1.token, { tag: tag + '-other' }, withKey(key));
    check('тот же ключ с другим телом → 422 key_reused', r.status === 422 && r.code === 'idempotency.key_reused', `${r.status} ${r.code}`);
    check('422 говорит «повторять бессмысленно»', r.shouldRetry === 'false', String(r.shouldRetry));
  }

  // ---------- 4. Скоуп ключа: человек, организация, ручка ----------
  {
    const key = randomUUID();
    const tag1 = 'sc1-' + randomUUID().slice(0, 8);
    const tag2 = 'sc2-' + randomUUID().slice(0, 8);
    const a = await call('POST', '/idempotency/dev/required', u1.token, { tag: tag1 }, withKey(key));
    const b = await call('POST', '/idempotency/dev/required', u2.token, { tag: tag2 }, withKey(key));
    check('тот же ключ у ДРУГОГО человека — независимое исполнение', a.status === 201 && b.status === 201 && !b.replayed, `${a.status}/${b.status}`);
    check('и у каждого свой эффект', (await effects(u1.token, tag1)) === 1 && (await effects(u2.token, tag2)) === 1, '');

    const c = await call('POST', '/idempotency/dev/atomic', u1.token, { tag: tag1 }, withKey(key));
    check('тот же ключ на ДРУГОЙ ручке — независимое исполнение', c.status === 201 && !c.replayed, `${c.status}`);
  }

  // ---------- 5. Реплей после обновления токена (sid меняется) ----------
  {
    const key = randomUUID();
    const tag = 'refresh-' + randomUUID().slice(0, 8);
    const first = await call('POST', '/idempotency/dev/required', u1.token, { tag }, withKey(key));
    const rt = await call('POST', '/auth/login', null, { phone: SUITE.p1, password: SUITE.password });
    const fresh = rt.json?.data?.accessToken;
    const again = await call('POST', '/idempotency/dev/required', fresh, { tag }, withKey(key));
    check('новая сессия + тот же ключ → РЕПЛЕЙ (скоуп не завязан на sid)', first.status === 201 && again.replayed === true, `${again.status} replayed=${again.replayed}`);
    check('эффект по-прежнему один', (await effects(u1.token, tag)) === 1, '');
  }

  // ---------- 6. Язык реплея ----------
  {
    const key = randomUUID();
    const tag = 'loc-' + randomUUID().slice(0, 8);
    await call('POST', '/idempotency/dev/fail?after=commit', u1.token, { tag }, withKey(key, { 'X-Locale': 'ru' }));
    const ru = await call('POST', '/idempotency/dev/fail?after=commit', u1.token, { tag }, withKey(key, { 'X-Locale': 'ru' }));
    const kk = await call('POST', '/idempotency/dev/fail?after=commit', u1.token, { tag }, withKey(key, { 'X-Locale': 'kk' }));
    check('отказ после коммита эффекта становится ФИНАЛЬНЫМ', ru.status === 409 && ru.code === 'dev.simulatedFailure', `${ru.status} ${ru.code}`);
    check('реплей отказа: тот же код в любом языке', kk.code === ru.code, `${kk.code}`);
    check('реплей отказа: ТЕКСТ в языке ЭТОГО запроса', typeof kk.json?.message === 'string' && kk.json.message !== ru.json?.message, `${kk.json?.message}`);
    check('эффект отказавшей ручки случился РОВНО один раз', (await effects(u1.token, tag)) === 1, '');
  }

  // ---------- 7. Отказ БЕЗ коммита: ключ свободен ----------
  {
    const key = randomUUID();
    const tag = 'nocommit-' + randomUUID().slice(0, 8);
    const bad = await call('POST', '/idempotency/dev/fail', u1.token, { tag }, withKey(key));
    check('отказ до эффекта → обычный 409, не финал', bad.status === 409, `${bad.status}`);
    // Тем же ключом, но ИСПРАВЛЕННЫМ телом — законно: эффекта не было
    const fixed = await call('POST', '/idempotency/dev/required', u1.token, { tag }, withKey(key));
    check('повтор с ИСПРАВЛЕННЫМ телом после отказа без эффекта проходит', fixed.status === 201 && !fixed.replayed, `${fixed.status}`);
  }

  // ---------- 8. Read-only POST: ключ отпускается ----------
  {
    const key = randomUUID();
    const a = await call('POST', '/idempotency/dev/readonly', u1.token, {}, withKey(key));
    const row = await keyRow(u1.id, '/idempotency/dev/readonly');
    check('read-only POST → ключ released, снимка нет', a.status === 200 && row?.state === 'released' && row?.response_id === null, `${row?.state}`);
    // Отпущенная строка ничего не защищает — её срок короткий (сутки, а не неделя):
    // клиент ставит ключ на КАЖДУЮ мутацию, и без этого они составляли бы таблицу
    const ttl = await prisma.$queryRawUnsafe(
      `SELECT (expires_at < (now() AT TIME ZONE 'UTC') + interval '25 hours') AS short
       FROM idem.keys WHERE user_id = $1::uuid AND route LIKE '%/idempotency/dev/readonly' ORDER BY created_at DESC LIMIT 1`,
      u1.id,
    );
    check('released-строка живёт сутки, а не неделю', ttl[0]?.short === true, JSON.stringify(ttl[0]));
  }
  {
    // Аноним на публичной ручке: случайный токен + случайный ключ. Заявка заводится
    // (принципал есть), ручка отвечает 404 — и строка обязана ИСЧЕЗНУТЬ: иначе любой
    // растил бы `idem.keys` без аутентификации, на неделю каждая строка.
    const key = randomUUID();
    const bogus = 'x' + randomUUID().replace(/-/g, '');
    const r = await call('POST', `/processes/webhook/${bogus}`, null, { a: 1 }, withKey(key));
    const left = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM idem.keys WHERE key_hash = $1`,
      require('crypto').createHash('sha256').update(key, 'utf8').digest(),
    );
    check('аноним с мусорным токеном: 404 и НИ ОДНОЙ строки в idem.keys', r.status === 404 && Number(left[0]?.n) === 0, `${r.status}, строк ${left[0]?.n}`);
  }

  // ---------- 9. Горячая ручка вне движка ----------
  {
    const before = await rows(u1.id, '/notifications/seen');
    await call('POST', '/notifications/seen', u1.token, { ids: [] }, withKey(randomUUID()));
    const after = await rows(u1.id, '/notifications/seen');
    check('@SkipIdempotency-ручка не пишет НИ ОДНОЙ строки в idem.keys', before === 0 && after === 0, `${before}→${after}`);
  }

  // ---------- 10. Секрет в ответе не хранится ----------
  {
    const key = randomUUID();
    const tag = 'secret-' + randomUUID().slice(0, 8);
    const first = await call('POST', '/idempotency/dev/secret', u1.token, { tag }, withKey(key));
    const again = await call('POST', '/idempotency/dev/secret', u1.token, { tag }, withKey(key));
    const secret = first.json?.data?.secret ?? '';
    const found = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM idem.responses WHERE body_enc LIKE $1`, `%${secret}%`);
    check('store:none → повтор отдаёт 409 already_completed без тела', again.status === 409 && again.code === 'idempotency.already_completed', `${again.status} ${again.code}`);
    check('секрета нет в idem.responses', Number(found[0]?.n ?? -1) === 0, '');
    check('409 already_completed несёт ссылку на созданное', typeof again.json?.details?.resourceId === 'string', '');
  }

  // ---------- 11. Снимок — конверт, а не открытый текст ----------
  {
    const key = randomUUID();
    const tag = 'env-' + randomUUID().slice(0, 8);
    await call('POST', '/idempotency/dev/required', u1.token, { tag }, withKey(key));
    const r = await prisma.$queryRawUnsafe(
      `SELECT r.body_enc FROM idem.responses r ORDER BY r.at DESC LIMIT 5`,
    );
    const allEnvelopes = r.length > 0 && r.every((x) => String(x.body_enc).startsWith('sa6e:'));
    const anyPlain = r.some((x) => String(x.body_enc).includes('"success"'));
    check('снимок лежит конвертом sa6e: (envelope core/keys)', allEnvelopes, `${r.length} строк`);
    check('открытого текста в снимке нет', !anyPlain, '');
  }

  // ---------- 12. Тело больше потолка ----------
  {
    const key = randomUUID();
    const tag = 'big-' + randomUUID().slice(0, 8);
    const a = await call('POST', '/idempotency/dev/big', u1.token, { tag }, withKey(key));
    const b = await call('POST', '/idempotency/dev/big', u1.token, { tag }, withKey(key));
    check('ответ > потолка снимка → повтор без тела (409 already_completed)', a.status === 201 && b.status === 409 && b.code === 'idempotency.already_completed', `${b.status} ${b.code}`);
    check('эффект всё равно один', (await effects(u1.token, tag)) === 1, '');
  }

  // ---------- 13. Смерть процесса ПОСЛЕ заявки ----------
  {
    // Не-atomic ручка: пере-исполнять нельзя — исход неизвестен
    const key = randomUUID();
    const tag = 'died-' + randomUUID().slice(0, 8);
    await call('POST', '/idempotency/dev/reset', u1.token, {});
    await call('POST', '/idempotency/dev/required', u1.token, { tag }, withKey(key));
    await call('POST', '/idempotency/dev/simulate', u1.token, { state: 'in_progress', lease: 'expire' });
    const r = await call('POST', '/idempotency/dev/required', u1.token, { tag }, withKey(key));
    check('умер после заявки (не atomic) → 409 outcome_unknown', r.status === 409 && r.code === 'idempotency.outcome_unknown', `${r.status} ${r.code}`);
    check('outcome_unknown говорит «повторять не надо»', r.shouldRetry === 'false', String(r.shouldRetry));
  }
  {
    // atomic-ручка обещала ровно одну транзакцию — её можно пере-исполнить
    const key = randomUUID();
    const tag = 'atomic-' + randomUUID().slice(0, 8);
    await call('POST', '/idempotency/dev/reset', u1.token, {});
    await call('POST', '/idempotency/dev/atomic', u1.token, { tag }, withKey(key));
    await call('POST', '/idempotency/dev/simulate', u1.token, { state: 'in_progress', lease: 'expire' });
    const r = await call('POST', '/idempotency/dev/atomic', u1.token, { tag }, withKey(key));
    check('умер после заявки (atomic) → ПЕРЕ-ИСПОЛНЕНИЕ, а не отказ', r.status === 201 && !r.replayed, `${r.status}`);
  }

  // ---------- 14. Смерть ПОСЛЕ коммита эффекта, до ответа ----------
  {
    const key = randomUUID();
    const tag = 'ack-' + randomUUID().slice(0, 8);
    await call('POST', '/idempotency/dev/reset', u1.token, {});
    await call('POST', '/idempotency/dev/required', u1.token, { tag }, withKey(key));
    await call('POST', '/idempotency/dev/simulate', u1.token, { state: 'committed', lease: 'expire' });
    const r = await call('POST', '/idempotency/dev/required', u1.token, { tag }, withKey(key));
    check('эффект закоммичен, ответ потерян → 409 already_completed', r.status === 409 && r.code === 'idempotency.already_completed', `${r.status} ${r.code}`);
    check('и эффект ОДИН, а не два', (await effects(u1.token, tag)) === 1, '');
  }

  // ---------- 15. Устаревшая попытка (fencing) ----------
  {
    const key = randomUUID();
    const tag = 'fence-' + randomUUID().slice(0, 8);
    await call('POST', '/idempotency/dev/reset', u1.token, {});
    await call('POST', '/idempotency/dev/required', u1.token, { tag }, withKey(key));
    // Сдвигаем номер попытки: прошлая стала устаревшей, состояние — «в полёте»
    // Аренда ПРОДЛЕНА: строка выглядит как живая попытка нового номера
    await call('POST', '/idempotency/dev/simulate', u1.token, { state: 'in_progress', lease: 'extend', bumpAttempt: true });
    const r = await call('POST', '/idempotency/dev/required', u1.token, { tag }, withKey(key));
    check('живая аренда новой попытки → 409 in_flight', r.status === 409 && r.code === 'idempotency.in_flight', `${r.status} ${r.code}`);
    check('второго эффекта не появилось', (await effects(u1.token, tag)) === 1, '');
  }

  {
    // Настоящий fencing: попытку перехватили, ПОКА обработчик ещё не писал. Его
    // транзакция обязана откатиться целиком — эффекта устаревшей попытки быть не может.
    const key = randomUUID();
    const tag = 'fence2-' + randomUUID().slice(0, 8);
    await call('POST', '/idempotency/dev/reset', u1.token, {});
    const stale = call('POST', '/idempotency/dev/slow?ms=2500', u1.token, { tag }, withKey(key));
    await sleep(800);
    await call('POST', '/idempotency/dev/simulate', u1.token, { state: 'in_progress', lease: 'extend', bumpAttempt: true });
    const r = await stale;
    check('перехваченная попытка: транзакция откатилась → 409 in_flight', r.status === 409 && r.code === 'idempotency.in_flight', `${r.status} ${r.code}`);
    check('и эффекта устаревшей попытки НЕТ', (await effects(u1.token, tag)) === 0, `${await effects(u1.token, tag)}`);
  }
  {
    // То же, но сервис ГЛОТАЕТ ошибки своих записей (`.catch(() => …)` внутри транзакции):
    // отказ отметки не вправе потеряться — иначе устаревшая попытка закоммитила бы эффект
    const key = randomUUID();
    const tag = 'fence3-' + randomUUID().slice(0, 8);
    await call('POST', '/idempotency/dev/reset', u1.token, {});
    const stale = call('POST', '/idempotency/dev/slow?ms=2500&swallow=1', u1.token, { tag }, withKey(key));
    await sleep(800);
    await call('POST', '/idempotency/dev/simulate', u1.token, { state: 'in_progress', lease: 'extend', bumpAttempt: true });
    const r = await stale;
    check('fencing не глотается сервисом: всё равно 409 in_flight', r.status === 409 && r.code === 'idempotency.in_flight', `${r.status} ${r.code}`);
    check('и проглоченная запись устаревшей попытки НЕ закоммичена', (await effects(u1.token, tag)) === 0, `${await effects(u1.token, tag)}`);
  }

  // ---------- 15b. Повтор не висит на строке, которую держит живая транзакция ----------
  {
    const key = randomUUID();
    const tag = 'hold-' + randomUUID().slice(0, 8);
    const first = call('POST', '/idempotency/dev/hold?ms=4000', u1.token, { tag }, withKey(key));
    await sleep(1000);
    const t0 = Date.now();
    const during = await call('POST', '/idempotency/dev/hold?ms=4000', u1.token, { tag }, withKey(key));
    const took = Date.now() - t0;
    check('повтор при живой транзакции первой попытки → 409 in_flight', during.status === 409 && during.code === 'idempotency.in_flight', `${during.status} ${during.code}`);
    check('и отвечает СРАЗУ, а не ждёт её коммита (соединение пула не занято)', took < 1500, `${took}мс`);
    const r = await first;
    check('первая попытка спокойно завершилась', r.status === 201, `${r.status}`);
    check('эффект один', (await effects(u1.token, tag)) === 1, '');
  }

  // ---------- 15c. Эффект закоммичен, обработчик ещё жив ----------
  {
    const key = randomUUID();
    const tag = 'alive-' + randomUUID().slice(0, 8);
    await call('POST', '/idempotency/dev/reset', u1.token, {});
    await call('POST', '/idempotency/dev/required', u1.token, { tag }, withKey(key));
    await call('POST', '/idempotency/dev/simulate', u1.token, { state: 'committed', lease: 'extend' });
    const r = await call('POST', '/idempotency/dev/required', u1.token, { tag }, withKey(key));
    check('committed + ЖИВАЯ аренда → 409 in_flight (ответ вот-вот будет), а не «готово, тела нет»', r.status === 409 && r.code === 'idempotency.in_flight' && r.shouldRetry === 'true', `${r.status} ${r.code}`);
  }

  // ---------- 16. Вложенная и параллельные транзакции ----------
  {
    const key = randomUUID();
    const tag = 'nested-' + randomUUID().slice(0, 8);
    const r = await call('POST', '/idempotency/dev/nested', u1.token, { tag }, withKey(key));
    check('вложенная + параллельные транзакции: без дедлока', r.status === 201, `${r.status}`);
    const again = await call('POST', '/idempotency/dev/nested', u1.token, { tag }, withKey(key));
    check('повтор такой ручки — реплей, а не второе исполнение', again.replayed === true, `${again.status}`);
    check('эффект основной транзакции один', (await effects(u1.token, tag)) === 1, '');
  }

  // ---------- 17. Долгая ручка: heartbeat держит аренду ----------
  {
    const key = randomUUID();
    const tag = 'slow-' + randomUUID().slice(0, 8);
    const started = Date.now();
    const slow = call('POST', '/idempotency/dev/slow?ms=12000', u1.token, { tag }, withKey(key));
    await sleep(4000);
    // ТОТ ЖЕ адрес и тело: другой `ms` был бы другой ФОРМОЙ запроса и честно дал бы 422
    const during = await call('POST', '/idempotency/dev/slow?ms=12000', u1.token, { tag }, withKey(key));
    const r = await slow;
    check('долгая ручка отработала', r.status === 201, `${r.status} за ${Date.now() - started}мс`);
    check('пока она шла, повтор видел живую аренду (409 in_flight)', during.status === 409 && during.code === 'idempotency.in_flight', `${during.status} ${during.code}`);
    check('эффект один', (await effects(u1.token, tag)) === 1, '');
  }

  // ---------- 18. Второй ремень денег: производный ключ ----------
  {
    const me = await call('GET', '/wallet/currency', u1.token);
    if (!me.json?.data) await call('POST', '/wallet/currency', u1.token, { name: 'Suite coin', icon: '🪙' });
    const key = randomUUID();
    const before = await ledgerMintCount(u1.id);
    const a = await call('POST', '/wallet/currency/mint', u1.token, { amount: 7 }, withKey(key));
    // Строку заявки сносим РУКАМИ — как если бы прошла неделя и её смела чистка
    await prisma.$executeRawUnsafe(`DELETE FROM idem.keys WHERE user_id = $1::uuid AND route = '/api/wallet/currency/mint'`, u1.id);
    const b = await call('POST', '/wallet/currency/mint', u1.token, { amount: 7 }, withKey(key));
    const after = await ledgerMintCount(u1.id);
    check('чеканка прошла', a.status === 201, `${a.status}`);
    check('повтор без строки заявки ответил успехом', b.status === 201, `${b.status}`);
    check('строки заявки нет, но ВТОРОЙ проводки не появилось (производный ключ стабилен)', after - before === 1, `проводок +${after - before}`);
  }

  // ---------- 19. Отзыв доступа между попытками ----------
  {
    // Реплей проходит ПОСЛЕ гардов: удалённый аккаунт/отозванный токен получит 401,
    // а не сохранённый ответ. Проверяем тем, что реплей с мусорным токеном — 401.
    const key = randomUUID();
    const tag = 'guard-' + randomUUID().slice(0, 8);
    await call('POST', '/idempotency/dev/required', u1.token, { tag }, withKey(key));
    const r = await call('POST', '/idempotency/dev/required', 'not-a-token', { tag }, withKey(key));
    check('реплей проходит гарды: без действующего токена — 401, а не снимок', r.status === 401, `${r.status}`);
  }
  {
    // Токен ЖИВОЙ, а членства в организации больше нет. Это другой случай, чем 401:
    // человек по-прежнему тот же самый, скоуп ключа сходится побайтово — и если бы
    // движок отдавал снимок до chokepoint'а, исключённый сотрудник забирал бы ответы
    // организации сколько угодно. Интерцептор движка стоит ПОСЛЕДНИМ из глобальных
    // именно поэтому: проверка членства отрабатывает заново на КАЖДОМ повторе.
    const ws = await createSuiteWorkspace(u1.token, 'Сьют-Идемпотентность');
    check('организация для проверки отзыва создана', ws.ok, `${ws.status} ${ws.json?.message ?? ''}`);
    const wsId = ws.json?.data?.id ?? null;
    if (wsId) {
      const WS = { 'X-Workspace-Id': wsId };
      const inv = await call('POST', `/workspaces/${wsId}/invitations`, u1.token, { phone: SUITE.p2 });
      const incoming = await call('GET', '/workspaces/invitations/incoming', u2.token);
      const mine = (incoming.json?.data ?? []).find((i) => i.workspaceId === wsId || i.workspace?.id === wsId);
      const acc = mine ? await call('POST', `/workspaces/invitations/${mine.id}/accept`, u2.token) : { ok: false, status: 0 };
      check('сотрудник принят в организацию', inv.ok && acc.ok, `inv ${inv.status} / accept ${acc.status}`);

      const key = randomUUID();
      const tag = 'revoke-' + randomUUID().slice(0, 8);
      const first = await call('POST', '/idempotency/dev/required', u2.token, { tag }, withKey(key, WS));
      check('сотрудник исполнил мутацию в организации', first.status === 201, `${first.status}`);

      const kicked = await call('DELETE', `/workspaces/${wsId}/members/${u2.id}`, u1.token);
      check('сотрудник исключён из организации', kicked.ok, `${kicked.status} ${kicked.json?.message ?? ''}`);

      const replay = await call('POST', '/idempotency/dev/required', u2.token, { tag }, withKey(key, WS));
      check(
        'повтор тем же ключом после исключения → 403, а не сохранённый ответ',
        replay.status === 403,
        `${replay.status} ${replay.code ?? ''}`,
      );
      check('и заголовка реплея на таком ответе нет', replay.replayed === false, `replayed=${replay.replayed}`);
      // Эффект остался ОДИН: отказ гарда не исполняет ручку заново
      check('второго эффекта отказ не создал', (await effects(u2.token, tag)) === 1, '');

      // Прибираем за собой сразу: организация уходит в архив (полная чистка — gc-test-workspaces.cjs)
      await archiveSuiteWorkspace(wsId);
    }
  }

  // ---------- 19b. Реплей ПО ССЫЛКЕ (IdempotencyReplayRegistry) ----------
  {
    // У карточки со статусом снимок 72-часовой давности ВРЁТ: за это время задачу
    // успели взять в работу. Владелец данных зарегистрировал рендерер — и повтор
    // отдаёт свежую сущность под правами ЭТОГО запроса, а не снимок первой попытки.
    const key = randomUUID();
    const title = 'Сьют-идемпотентность ' + randomUUID().slice(0, 8);
    const created = await call('POST', '/tasks', u1.token, { title }, withKey(key));
    check('задача создана', created.status === 201, `${created.status} ${created.json?.message ?? ''}`);
    const taskId = created.json?.data?.id ?? null;
    if (taskId) {
      const moved = await call('PATCH', `/tasks/${taskId}`, u1.token, { status: 'in_progress' });
      check('статус задачи изменился между попытками', moved.ok, `${moved.status}`);

      const replay = await call('POST', '/tasks', u1.token, { title }, withKey(key));
      check('повтор — реплей (Idempotent-Replayed: true)', replay.replayed === true, `replayed=${replay.replayed}`);
      check(
        'реплей отдал СВЕЖИЙ статус, а не снимок первой попытки',
        replay.json?.data?.status === 'in_progress',
        `status=${replay.json?.data?.status}`,
      );
      check('и той же задачи, а не второй', replay.json?.data?.id === taskId, `${replay.json?.data?.id}`);
      // Поиском по уникальному названию, а не первой страницей: инбокс сортирует по
      // приоритету и сроку, и свежая задача без срока у накопленного аккаунта на неё не попадает
      const mine = await call('GET', `/tasks?search=${encodeURIComponent(title)}`, u1.token);
      const same = (mine.json?.data?.items ?? []).filter((t) => t.title === title).length;
      check('второй задачи не появилось', same === 1, `задач с этим названием: ${same}`);

      await call('DELETE', `/tasks/${taskId}`, u1.token);
    }
  }

  // ---------- 20. Входящий ящик ----------
  {
    const fake = randomUUID();
    const r = await call('POST', '/calls/livekit/webhook', null, { event: 'room_finished', id: fake, room: { name: 'ghost' } });
    const inbox = await prisma.idempotencyInbox.count({ where: { source: 'livekit', eventId: fake } });
    check('поддельный вебхук без подписи отвергнут', r.status === 400 || r.status === 401, `${r.status}`);
    check('и строки в ящике не оставил (ящик не травится)', inbox === 0, `${inbox}`);
  }
  {
    // Примитив ящика: два одинаковых (source, account, eventId) → одна строка
    const account = 'suite-' + randomUUID().slice(0, 8);
    const eventId = randomUUID();
    const insert = () =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "idempotency_inbox" ("source","account","event_id") VALUES ('suite',$1,$2) ON CONFLICT DO NOTHING`,
        account,
        eventId,
      );
    const a = await insert();
    const b = await insert();
    check('ящик: повторное событие источника не создаёт второй строки', a === 1 && b === 0, `${a}/${b}`);
    await prisma.$executeRawUnsafe(`DELETE FROM "idempotency_inbox" WHERE "source"='suite' AND "account"=$1`, account);
  }

  {
    // Аренда обработки: приёмник, чья работа не помещается в одну транзакцию
    const op = async (o, eventId) => (await call('POST', '/idempotency/dev/inbox', u1.token, { op: o, eventId })).json?.data;
    const e1 = 'ev-' + randomUUID().slice(0, 12);
    const first = await op('begin', e1);
    const during = await op('begin', e1);
    check('ящик: первая доставка → first', first?.verdict === 'first', JSON.stringify(first));
    check('ящик: редоставка, пока первая В РАБОТЕ → in_flight (источнику не-2xx: пусть придёт ещё)', during?.verdict === 'in_flight', JSON.stringify(during));
    await op('done', e1);
    check('ящик: редоставка после done → duplicate', (await op('begin', e1))?.verdict === 'duplicate', '');
    check('ящик: forget НЕ снимает уже обработанное событие', (await op('forget', e1))?.rows === 0 && (await op('begin', e1))?.verdict === 'duplicate', '');

    // Обработчик УМЕР посреди работы (деплой, OOM): forget он уже не позовёт.
    // Без аренды событие осталось бы помеченным навсегда и редоставка гасилась бы как дубль.
    const e2 = 'ev-' + randomUUID().slice(0, 12);
    await op('begin', e2);
    await op('expire', e2);
    check('ящик: обработчик умер (аренда истекла) → редоставка ЗАБИРАЕТ событие', (await op('begin', e2))?.verdict === 'first', '');

    const e3 = 'ev-' + randomUUID().slice(0, 12);
    await op('begin', e3);
    await op('forget', e3);
    check('ящик: обработка упала (forget) → редоставка проходит как первая', (await op('begin', e3))?.verdict === 'first', '');
  }

  // ---------- 21. Партиции снимков ----------
  {
    const parts = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM pg_inherits i
       JOIN pg_class p ON p.oid = i.inhparent
       JOIN pg_namespace ns ON ns.oid = p.relnamespace
       WHERE ns.nspname='idem' AND p.relname='responses'`,
    );
    const keyParts = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM pg_inherits i
       JOIN pg_class p ON p.oid = i.inhparent
       JOIN pg_namespace ns ON ns.oid = p.relnamespace
       WHERE ns.nspname='idem' AND p.relname='keys'`,
    );
    check('партиции снимков созданы вперёд', Number(parts[0]?.n ?? 0) >= 3, `${parts[0]?.n}`);
    // Поиск поддержки идёт по ОДНОМУ key_hash — он обязан быть ведущей колонкой индекса,
    // иначе команда кабинета последовательно читала бы все 16 партиций
    const pk = await prisma.$queryRawUnsafe(
      `SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = 'idem' AND c.relname = 'keys' AND i.indisprimary`,
    );
    check('первичный ключ idem.keys начинается с key_hash (поиск по сырому ключу — по индексу)', /\(key_hash, scope_hash\)/.test(pk[0]?.def ?? ''), pk[0]?.def);
    check('idem.keys разбит на 16 хэш-партиций (уникальность ключа глобальна)', Number(keyParts[0]?.n ?? 0) === 16, `${keyParts[0]?.n}`);
  }

  await call('POST', '/idempotency/dev/reset', u1.token, {});
  await call('POST', '/idempotency/dev/reset', u2.token, {});
  await prisma.$disconnect();
  finish();
}

/** Строка заявки человека по маршруту (последняя). */
async function keyRow(userId, routeSuffix) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT state, response_id FROM idem.keys WHERE user_id = $1::uuid AND route LIKE $2 ORDER BY created_at DESC LIMIT 1`,
    userId,
    `%${routeSuffix}`,
  );
  return rows[0] ?? null;
}

async function rows(userId, routeSuffix) {
  const r = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM idem.keys WHERE user_id = $1::uuid AND route LIKE $2`,
    userId,
    `%${routeSuffix}`,
  );
  return Number(r[0]?.n ?? -1);
}

/** Сколько проводок чеканки у человека (второй ремень денег). */
async function ledgerMintCount(userId) {
  const r = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM ledger_transfers t
     JOIN accounts a ON a.id = t.credit_account_id
     WHERE a.owner_type = 'user' AND a.owner_id = $1 AND t.memo = 'mint'`,
    userId,
  );
  return Number(r[0]?.n ?? 0);
}

main().catch(async (e) => {
  await prisma.$disconnect().catch(() => undefined);
  await crash(e);
});
