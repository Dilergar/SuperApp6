/* eslint-disable */
// core/share-links — сквозная проверка движка гостевых ссылок.
//
// Аккаунты СЬЮТА (+7700999000x), не ручные tester1/2/3. Чисток deleteMany по userId
// здесь нет — только свои объекты и уборка штатным путём.
//
// ГЛАВНЫЙ ИНВАРИАНТ, который проверяется на КАЖДОМ гостевом вызове всего прогона:
// гостевая поверхность НИКОГДА не отвечает 401. У гостя нет токена платформы, а
// веб-клиент на 401 жёстко уводит на страницу входа — «ссылка истекла» превратилось
// бы в «вас разлогинило».
//
// Run (API up): node scripts/verify-share-links.cjs
const { PrismaClient } = require('@prisma/client');
const BASE = 'http://localhost:3001/api';
const P1 = '+77009990001', P2 = '+77009990002', P3 = '+77009990003', PW = 'Test1234!';
/** Зеркало SHARE_LINK_LIMITS.passwordMaxAttempts — скрипт не тянет собранный shared */
const SHARE_PASSWORD_MAX_ATTEMPTS = 5;

/**
 * Минимальный НАСТОЯЩИЙ .docx (одна строка текста). Раньше документная часть грузила
 * подделку «PK fake docx», редактор её не конвертировал, и всё, что стоит за готовым
 * PDF-отпечатком, оставалось непроверенным — в том числе выдача байтов гостю.
 */
const DOCX_MIN = Buffer.from(
  'UEsDBBQAAAAIABa+AV3IZt/Q7wAAAK8BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QvU7DMBSF9z6F5RXFDgwIoTod+BmBoTyA' +
    'Zd8kVu17LV83pG+P0pYOqDCfn+/orDdzimKCwoHQyFvVSgHoyAccjPzcvjYPUnC16G0kBCMPwHLTrdbbQwYWc4rIRo615ket2Y2Q' +
    'LCvKgHOKPZVkKysqg87W7ewA+q5t77UjrIC1qUuH7NbP0Nt9rOJlroCnIQUiS/F0Mi4sI23OMThbA6Ge0P+iNGeCKhCPHh5D5ps5' +
    'RamvEhblb8A59z5BKcGD+LClvtkERuovKl57cvsEWNX/NVd2Ut8HB5f80pYLOWAOOKSoLkqyAX/26+Pd3eobUEsDBBQAAAAIABa+' +
    'AV2mbZh9/QAAAD0BAAARAAAAd29yZC9kb2N1bWVudC54bWxFj01OhEAQhfdzik7vpdGFMQSYnSfQAyC0DEn/kO5WmB3gThfGxAt4' +
    'AxydRBnFK1TdyDQu3HwvqbxX9Spet1KQW25spVVCj4OQEq5yXVSqTOjlxfnRGSXWZarIhFY8oVtu6TpdxU1U6PxGcuVIK4WyUZPQ' +
    'jXN1xJjNN1xmNtA1V60U19rIzNlAm5I12hS10Tm3tlKlFOwkDE+ZzCpF07iJrnSx9Vp7GA+XwjPM8AYz7GDGjsA3jAR+sFsme+xg' +
    'wjviDdjjAHtvg0+CPfb4AAeY4CMg8ILDkph8eIeDXwUjPhJ4h4OXGV7xHp/gC8YgZv6up1lYL/zrxv7/Tle/UEsDBBQAAAAAABm+' +
    'AV0AAAAAAAAAAAAAAAALAAAAd29yZC9fcmVscy9QSwMEFAAAAAgAFr4BXTpJG4C0AAAAKwEAAAsAAABfcmVscy8ucmVsc43PsY7C' +
    'MBAE0J6vsLa/OFAghOLQICTaU/gAy94kFvau5fUd4e9pKABdce1o9EbTHZYU1S8WCUwG1k0LCsmxDzQZuAynrx0oqZa8jUxo4I4C' +
    'h37VfWO0NTDJHLKoJUUSA3Otea+1uBmTlYYz0pLiyCXZKg2XSWfrrnZCvWnbrS6vBvRvpjp7A+Xs16CGe8b/2DyOweGR3U9Cqn9M' +
    'fDRADbZMWA3cuHjtn3GzpAi67/TbxX71AFBLAQIUABQAAAAIABa+AV3IZt/Q7wAAAK8BAAATAAAAAAAAAAAAAAAAAAAAAABbQ29u' +
    'dGVudF9UeXBlc10ueG1sUEsBAhQAFAAAAAgAFr4BXaZtmH39AAAAPQEAABEAAAAAAAAAAAAAAAAAIAEAAHdvcmQvZG9jdW1lbnQu' +
    'eG1sUEsBAhQAFAAAAAAAGb4BXQAAAAAAAAAAAAAAAAsAAAAAAAAAAAAAAAAATAIAAHdvcmQvX3JlbHMvUEsBAhQAFAAAAAgAFr4B' +
    'XTpJG4C0AAAAKwEAAAsAAAAAAAAAAAAAAAAAdQIAAF9yZWxzLy5yZWxzUEsFBgAAAAAEAAQA8gAAAFIDAAAAAA==',
  'base64',
);

let fails = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`);
  if (!ok) fails++;
};

/** Гостевые вызовы проходят через неё же — сюда и вшит контроль «никогда 401» */
let guestCalls = 0;
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
  try { json = await res.json(); } catch {}
  const guest = p.startsWith('/share-links/guest') || p.startsWith('/drive/guest');
  if (guest) {
    guestCalls++;
    if (res.status === 401) {
      check(`ГОСТЕВОЙ 401 на ${method} ${p} — нарушен инвариант`, false, JSON.stringify(json));
    }
  }
  return { status: res.status, ok: res.ok, json, code: json?.details?.code ?? null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = async (phone) => {
  const r = await call('POST', '/auth/login', null, { phone, password: PW });
  if (!r.ok) throw new Error(`login ${phone}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data.accessToken;
};

async function upload(token, { profile = 'drive_file', name, mime, bytes }) {
  const init = await call('POST', '/files', token, { profile, name, mime, size: bytes.length });
  if (!init.ok) throw new Error(`init ${name}: ${init.status} ${JSON.stringify(init.json)}`);
  const id = init.json.data.file.id;
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: mime }), name);
  const put = await fetch(`${BASE}/files/${id}/content`, {
    method: 'PUT', headers: { Authorization: 'Bearer ' + token }, body: fd,
  });
  if (!put.ok) throw new Error(`put ${name}: ${put.status}`);
  const done = await call('POST', `/files/${id}/complete`, token, {});
  if (!done.ok) throw new Error(`complete ${name}: ${done.status} ${JSON.stringify(done.json)}`);
  return done.json.data;
}

async function ensureContact(prisma, a, b) {
  const [x, y] = a < b ? [a, b] : [b, a];
  const existing = await prisma.contactLink.findFirst({ where: { userAId: x, userBId: y } });
  if (existing) return;
  await prisma.contactLink.create({
    data: { userAId: x, userBId: y, roleAForB: 'Коллега', roleBForA: 'Коллега', initiatedBy: a },
  });
}

const TXT = (s) => Buffer.from(s, 'utf8');
const tokenOf = (url) => url.split('/s/')[1];
const SESSION_HEADER = 'x-share-session';

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2), t3 = await login(P3);
  const u1 = (await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } })).id;
  const u2 = (await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } })).id;
  const stamp = Date.now();
  const created = { nodes: [], links: [] };

  try {
    await ensureContact(prisma, u1, u2);

    // ============================================================
    // 1. Подготовка: папка A / подпапка B / файл, плюс сосед вне ссылки
    // ============================================================
    const mk = async (name, parentId) => {
      const r = await call('POST', '/drive/folders', t1, { name, ...(parentId ? { parentId } : {}) });
      if (!r.ok) throw new Error(`folder ${name}: ${r.status} ${JSON.stringify(r.json)}`);
      created.nodes.push(r.json.data.id);
      return r.json.data.id;
    };
    const folderA = await mk(`sl-A-${stamp}`);
    const folderB = await mk(`sl-B-${stamp}`, folderA);
    const outsider = await mk(`sl-outside-${stamp}`);

    const f1 = await upload(t1, { name: `sl-doc-${stamp}.txt`, mime: 'text/plain', bytes: TXT('гостевой файл') });
    const place = await call('POST', '/drive/nodes', t1, { parentId: folderB, fileId: f1.id });
    check('файл положен в подпапку', place.ok, `status ${place.status}`);
    const fileNode = place.json?.data?.id;
    if (fileNode) created.nodes.push(fileNode);

    // ============================================================
    // 2. Создание ссылки и права
    // ============================================================
    const noProvider = await call('POST', '/share-links', t1, { refType: 'nosuch', refId: folderA });
    check('незарегистрированный refType → 400', noProvider.status === 400, `status ${noProvider.status}`);

    const c1 = await call('POST', '/share-links', t1, { refType: 'drive_node', refId: folderA, label: 'Партнёр' });
    check('владелец создал ссылку на папку', c1.ok, `status ${c1.status}`);
    const linkA = c1.json?.data;
    if (linkA) created.links.push(linkA.id);
    check('ссылка содержит адрес /s/', !!linkA && linkA.url.includes('/s/'), linkA?.url);
    check('токен длинный и неугадываемый', !!linkA && tokenOf(linkA.url).length >= 32, `len ${linkA ? tokenOf(linkA.url).length : 0}`);
    check('статус новой ссылки — действует', linkA?.status === 'active', linkA?.status);
    check('счётчик открытий на старте 0', linkA?.openCount === 0, String(linkA?.openCount));

    const foreign = await call('POST', '/share-links', t3, { refType: 'drive_node', refId: folderA });
    check('посторонний не создаёт ссылку → 404', foreign.status === 404, `status ${foreign.status}`);

    // Зритель (не управляющий) тоже не имеет права раздавать наружу — но ответ ему
    // ДРУГОЙ, чем постороннему: 404 «Объект не найден» человеку, который смотрит на этот
    // объект в своём же списке, — прямая ложь. Постороннему 404 остаётся: подтверждать
    // существование чужого объекта нельзя.
    await call('POST', `/drive/nodes/${folderA}/shares`, t1, {
      principalType: 'user', principalId: u2, role: 'viewer',
    });
    const byViewer = await call('POST', '/share-links', t2, { refType: 'drive_node', refId: folderA });
    check('зритель не создаёт ссылку → 403 с причиной', byViewer.status === 403, `status ${byViewer.status}`);
    check(
      'причина названа, а не «не найдено»',
      typeof byViewer.json?.message === 'string' && !byViewer.json.message.includes('не найден'),
      byViewer.json?.message,
    );

    const chatterRow = await prisma.chatterEntry.findFirst({
      where: { refType: 'drive_node', refId: folderA, typeKey: 'share.link_created' },
    });
    check('создание записано в хронику объекта', !!chatterRow, chatterRow?.typeKey);

    // ============================================================
    // 3. Гость: peek не считает открытия
    // ============================================================
    const tokA = tokenOf(linkA.url);
    const unknown = await call('GET', '/share-links/guest/нетакого', null);
    check('неизвестный токен → 404 + код', unknown.status === 404 && unknown.code === 'share_link_not_found', `${unknown.status}/${unknown.code}`);

    const peek1 = await call('GET', `/share-links/guest/${tokA}`, null);
    check('peek живой ссылки → ready', peek1.ok && peek1.json.data.state === 'ready', peek1.json?.data?.state);
    const afterPeek = await prisma.shareLink.findUnique({ where: { id: linkA.id } });
    check('peek НЕ засчитал открытие', afterPeek.openCount === 0, String(afterPeek.openCount));

    // ============================================================
    // 4. Открытие: счётчик, журнал визитов, содержимое
    // ============================================================
    const s1 = await call('POST', `/share-links/guest/${tokA}/session`, null, {}, { 'user-agent': 'verify-suite/1.0' });
    check('гость открыл ссылку БЕЗ авторизации', s1.ok, `status ${s1.status}`);
    check('вернулась папка', s1.json?.data?.view?.kind === 'folder', s1.json?.data?.view?.kind);
    const sessA = s1.json?.data?.sessionToken;
    check('выдан пропуск', !!sessA);

    const afterOpen = await prisma.shareLink.findUnique({ where: { id: linkA.id } });
    check('открытие засчитано', afterOpen.openCount === 1, String(afterOpen.openCount));
    check('отметка времени открытия проставлена', !!afterOpen.lastOpenedAt);
    const visit = await prisma.shareLinkVisit.findFirst({ where: { linkId: linkA.id }, orderBy: { id: 'desc' } });
    check('визит записан в журнал', !!visit, visit ? `ua=${visit.userAgent}` : '');
    check('журнал сохранил user-agent', visit?.userAgent === 'verify-suite/1.0', visit?.userAgent);

    // ============================================================
    // 5. Хождение по поддереву и защита от побега
    // ============================================================
    const listRoot = await call('GET', '/drive/guest/nodes', null, null, { [SESSION_HEADER]: sessA });
    check('гость видит содержимое корня ссылки', listRoot.ok, `status ${listRoot.status}`);
    const names = (listRoot.json?.data ?? []).map((n) => n.name);
    check('в корне видна вложенная папка', names.includes(`sl-B-${stamp}`), names.join(','));

    const listB = await call('GET', `/drive/guest/nodes?parentId=${folderB}`, null, null, { [SESSION_HEADER]: sessA });
    check('гость заходит во вложенную папку', listB.ok, `status ${listB.status}`);
    const fileRow = (listB.json?.data ?? [])[0];
    check('файл виден со ссылкой на байты', !!fileRow?.file?.url && fileRow.file.available === true, fileRow?.file?.url ? 'url есть' : 'url нет');

    // Байты реально отдаются постороннему по подписанной ссылке
    if (fileRow?.file?.url) {
      const raw = await fetch(fileRow.file.url);
      check('байты файла скачиваются гостем', raw.ok, `status ${raw.status}`);
    }

    const escape1 = await call('GET', `/drive/guest/nodes?parentId=${outsider}`, null, null, { [SESSION_HEADER]: sessA });
    check('побег в соседнюю папку → 404', escape1.status === 404, `status ${escape1.status}`);
    const escape2 = await call('GET', `/drive/guest/nodes/${outsider}`, null, null, { [SESSION_HEADER]: sessA });
    check('чужой узел по прямому id → 404', escape2.status === 404, `status ${escape2.status}`);
    const noSession = await call('GET', '/drive/guest/nodes', null, null, {});
    check('без пропуска → 403 (не 401)', noSession.status === 403, `status ${noSession.status}`);
    const badSession = await call('GET', '/drive/guest/nodes', null, null, { [SESSION_HEADER]: 'v1.aaa.bbb' });
    check('подделанный пропуск → 403', badSession.status === 403, `status ${badSession.status}`);

    // ============================================================
    // 6. Повторный показ не накручивает счётчик
    // ============================================================
    const view1 = await call('GET', `/share-links/guest/${tokA}/view`, null, null, { [SESSION_HEADER]: sessA });
    check('обновление страницы отдаёт содержимое', view1.ok, `status ${view1.status}`);
    const afterView = await prisma.shareLink.findUnique({ where: { id: linkA.id } });
    check('обновление НЕ засчитано как открытие', afterView.openCount === 1, String(afterView.openCount));

    const s2 = await call('POST', `/share-links/guest/${tokA}/session`, null, {});
    check('второе открытие засчитано', s2.ok, `status ${s2.status}`);
    const after2 = await prisma.shareLink.findUnique({ where: { id: linkA.id } });
    check('счётчик стал 2', after2.openCount === 2, String(after2.openCount));

    // ============================================================
    // 7. Пароль
    // ============================================================
    const cPw = await call('POST', '/share-links', t1, { refType: 'drive_node', refId: folderA, password: 'secret7' });
    created.links.push(cPw.json.data.id);
    const tokPw = tokenOf(cPw.json.data.url);
    check('пароль наружу не отдаётся', cPw.json.data.hasPassword === true && cPw.json.data.password === undefined);

    const peekPw = await call('GET', `/share-links/guest/${tokPw}`, null);
    check('peek запароленной → password_required', peekPw.json?.data?.state === 'password_required', peekPw.json?.data?.state);

    const noPw = await call('POST', `/share-links/guest/${tokPw}/session`, null, {});
    check('без пароля → 403 + код', noPw.status === 403 && noPw.code === 'share_password_required', `${noPw.status}/${noPw.code}`);
    const wrongPw = await call('POST', `/share-links/guest/${tokPw}/session`, null, { password: 'нет' });
    check('неверный пароль → 403 + код', wrongPw.status === 403 && wrongPw.code === 'share_password_wrong', `${wrongPw.status}/${wrongPw.code}`);
    const pwRow = await prisma.shareLink.findUnique({ where: { id: cPw.json.data.id } });
    check('неверный пароль НЕ потратил открытие', pwRow.openCount === 0, String(pwRow.openCount));

    const okPw = await call('POST', `/share-links/guest/${tokPw}/session`, null, { password: 'secret7' });
    check('верный пароль открывает', okPw.ok, `status ${okPw.status}`);

    const clearPw = await call('PATCH', `/share-links/${cPw.json.data.id}`, t1, { password: null });
    check('пароль снят через PATCH', clearPw.ok && clearPw.json.data.hasPassword === false, String(clearPw.json?.data?.hasPassword));
    const afterClear = await call('POST', `/share-links/guest/${tokPw}/session`, null, {});
    check('после снятия открывается без пароля', afterClear.ok, `status ${afterClear.status}`);

    // 7б. Перебор пароля упирается в счётчик НА САМОЙ ССЫЛКЕ. Троттлер платформы
    // считает по IP, а адресов у распределённого перебора сколько угодно — на одном
    // троттлере ссылка оставалась бы подбираемой.
    const cBrute = await call('POST', '/share-links', t1, {
      refType: 'drive_node', refId: folderA, password: 'secret7',
    });
    created.links.push(cBrute.json.data.id);
    const tokBrute = tokenOf(cBrute.json.data.url);
    let lastTry = null;
    for (let i = 0; i < SHARE_PASSWORD_MAX_ATTEMPTS; i++) {
      lastTry = await call('POST', `/share-links/guest/${tokBrute}/session`, null, { password: `нет${i}` });
    }
    check('исчерпание попыток → подбор заблокирован', lastTry.status === 403 && lastTry.code === 'share_password_locked', `${lastTry.status}/${lastTry.code}`);
    check('сказано, сколько ждать', typeof lastTry.json?.details?.retryInSec === 'number', String(lastTry.json?.details?.retryInSec));
    const lockedButRight = await call('POST', `/share-links/guest/${tokBrute}/session`, null, { password: 'secret7' });
    check('под блокировкой не пускает и с ВЕРНЫМ паролем', lockedButRight.code === 'share_password_locked', lockedButRight.code);
    const bruteRow = await prisma.shareLink.findUnique({ where: { id: cBrute.json.data.id } });
    check('перебор не потратил ни одного открытия', bruteRow.openCount === 0, String(bruteRow.openCount));

    // Смена пароля владельцем снимает блокировку: иначе получатель, запертый ЧУЖИМ
    // перебором, сидел бы без доступа и владелец ничем не мог бы ему помочь.
    await call('PATCH', `/share-links/${cBrute.json.data.id}`, t1, { password: 'secret8' });
    const unlocked = await call('POST', `/share-links/guest/${tokBrute}/session`, null, { password: 'secret8' });
    check('смена пароля снимает блокировку', unlocked.ok, `status ${unlocked.status}`);
    const freshWrong = await call('POST', `/share-links/guest/${tokBrute}/session`, null, { password: 'мимо' });
    check(
      'верный пароль обнулил счёт — ошибка снова первая',
      freshWrong.json?.details?.attemptsLeft === SHARE_PASSWORD_MAX_ATTEMPTS - 1,
      String(freshWrong.json?.details?.attemptsLeft),
    );

    // ============================================================
    // 8. Лимит открытий и гонка за последний слот
    // ============================================================
    const cMax = await call('POST', '/share-links', t1, { refType: 'drive_node', refId: folderA, maxOpens: 2 });
    created.links.push(cMax.json.data.id);
    const tokMax = tokenOf(cMax.json.data.url);
    const m1 = await call('POST', `/share-links/guest/${tokMax}/session`, null, {});
    check('первое открытие лимитированной ссылки', m1.ok, `status ${m1.status}`);
    const m2 = await call('POST', `/share-links/guest/${tokMax}/session`, null, {});
    check('второе открытие лимитированной ссылки', m2.ok, `status ${m2.status}`);
    const m3 = await call('POST', `/share-links/guest/${tokMax}/session`, null, {});
    check('третье → 410 исчерпана', m3.status === 410 && m3.code === 'share_link_exhausted', `${m3.status}/${m3.code}`);
    const peekMax = await call('GET', `/share-links/guest/${tokMax}`, null);
    check('peek исчерпанной → 410', peekMax.status === 410 && peekMax.code === 'share_link_exhausted', `${peekMax.status}/${peekMax.code}`);

    // Гонка: на последний слот претендуют двое одновременно — пройти обязан ровно один
    const cRace = await call('POST', '/share-links', t1, { refType: 'drive_node', refId: folderA, maxOpens: 1 });
    created.links.push(cRace.json.data.id);
    const tokRace = tokenOf(cRace.json.data.url);
    const [r1, r2] = await Promise.all([
      call('POST', `/share-links/guest/${tokRace}/session`, null, {}),
      call('POST', `/share-links/guest/${tokRace}/session`, null, {}),
    ]);
    const winners = [r1, r2].filter((r) => r.ok).length;
    check('в гонке за последний слот победил ровно один', winners === 1, `успехов ${winners}`);
    const raceRow = await prisma.shareLink.findUnique({ where: { id: cRace.json.data.id } });
    check('счётчик не перескочил лимит', raceRow.openCount === 1, String(raceRow.openCount));

    // ============================================================
    // 9. Срок действия
    // ============================================================
    const cExp = await call('POST', '/share-links', t1, {
      refType: 'drive_node', refId: folderA, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    created.links.push(cExp.json.data.id);
    const tokExp = tokenOf(cExp.json.data.url);
    const past = await call('POST', '/share-links', t1, {
      refType: 'drive_node', refId: folderA, expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    check('срок в прошлом отвергается валидацией', past.status === 400, `status ${past.status}`);

    // Двигаем срок в прошлое напрямую — так же, как это сделает само время
    await prisma.shareLink.update({ where: { id: cExp.json.data.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expPeek = await call('GET', `/share-links/guest/${tokExp}`, null);
    check('истёкшая ссылка → 410 + код', expPeek.status === 410 && expPeek.code === 'share_link_expired', `${expPeek.status}/${expPeek.code}`);

    // ============================================================
    // 10. Отзыв гасит живую сессию немедленно
    // ============================================================
    const cRev = await call('POST', '/share-links', t1, { refType: 'drive_node', refId: folderA });
    created.links.push(cRev.json.data.id);
    const tokRev = tokenOf(cRev.json.data.url);
    const revSession = (await call('POST', `/share-links/guest/${tokRev}/session`, null, {})).json.data.sessionToken;
    const beforeRevoke = await call('GET', '/drive/guest/nodes', null, null, { [SESSION_HEADER]: revSession });
    check('до отзыва сессия работает', beforeRevoke.ok, `status ${beforeRevoke.status}`);

    const revoked = await call('POST', `/share-links/${cRev.json.data.id}/revoke`, t1);
    check('отзыв прошёл', revoked.ok && revoked.json.data.status === 'revoked', revoked.json?.data?.status);
    const afterRevoke = await call('GET', '/drive/guest/nodes', null, null, { [SESSION_HEADER]: revSession });
    check('ЖИВАЯ сессия умирает сразу после отзыва', afterRevoke.status === 410 && afterRevoke.code === 'share_link_revoked', `${afterRevoke.status}/${afterRevoke.code}`);
    const revPeek = await call('GET', `/share-links/guest/${tokRev}`, null);
    check('peek отозванной → 410', revPeek.status === 410, `status ${revPeek.status}`);
    const revTwice = await call('POST', `/share-links/${cRev.json.data.id}/revoke`, t1);
    check('повторный отзыв идемпотентен', revTwice.ok, `status ${revTwice.status}`);
    const patchRevoked = await call('PATCH', `/share-links/${cRev.json.data.id}`, t1, { label: 'поздно' });
    check('отозванную нельзя править → 400', patchRevoked.status === 400, `status ${patchRevoked.status}`);

    // ============================================================
    // 11. Корзина приостанавливает, восстановление оживляет
    // ============================================================
    const cTrash = await call('POST', '/share-links', t1, { refType: 'drive_node', refId: folderB });
    created.links.push(cTrash.json.data.id);
    const tokTrash = tokenOf(cTrash.json.data.url);
    await call('POST', '/drive/nodes/trash', t1, { ids: [folderB] });
    const trashed = await call('POST', `/share-links/guest/${tokTrash}/session`, null, {});
    check('объект в корзине → 410 refGone', trashed.status === 410 && trashed.code === 'share_ref_gone', `${trashed.status}/${trashed.code}`);
    const stillActive = await prisma.shareLink.findUnique({ where: { id: cTrash.json.data.id } });
    check('корзина НЕ отзывает ссылку', stillActive.revokedAt === null);
    await call('POST', '/drive/nodes/restore', t1, { ids: [folderB] });
    const restored = await call('POST', `/share-links/guest/${tokTrash}/session`, null, {});
    check('после восстановления ссылка снова работает', restored.ok, `status ${restored.status}`);

    // 11б. …и при этом НЕ сжигает открытие. Резолвер зовётся ДО клейма: иначе ссылка с
    // лимитом 1 на объект, уехавший в корзину, оставалась бы «исчерпанной» навсегда —
    // владелец вернул объект, а показывать его уже некому.
    const cBurn = await call('POST', '/share-links', t1, {
      refType: 'drive_node', refId: folderB, maxOpens: 1,
    });
    created.links.push(cBurn.json.data.id);
    const tokBurn = tokenOf(cBurn.json.data.url);
    await call('POST', '/drive/nodes/trash', t1, { ids: [folderB] });
    const burnTry = await call('POST', `/share-links/guest/${tokBurn}/session`, null, {});
    const burnRow = await prisma.shareLink.findUnique({ where: { id: cBurn.json.data.id } });
    check('объект в корзине не тратит открытие', burnTry.status === 410 && burnRow.openCount === 0, `${burnTry.status}/openCount ${burnRow.openCount}`);
    await call('POST', '/drive/nodes/restore', t1, { ids: [folderB] });
    const burnOk = await call('POST', `/share-links/guest/${tokBurn}/session`, null, {});
    check('единственное открытие досталось живому объекту', burnOk.ok, `status ${burnOk.status}`);

    // ============================================================
    // 12. Журнал визитов и список ссылок
    //
    // ДО удаления объекта намеренно: право на ссылки даёт сам объект (резолвер
    // потребителя), поэтому вместе с ним закрывается и доступ к его журналу.
    // ============================================================
    const visits = await call('GET', `/share-links/${linkA.id}/visits`, t1);
    check('журнал визитов доступен управляющему', visits.ok && visits.json.data.length >= 2, `визитов ${visits.json?.data?.length}`);
    check('id визита отдаётся строкой', typeof visits.json?.data?.[0]?.id === 'string', typeof visits.json?.data?.[0]?.id);
    const visitsForeign = await call('GET', `/share-links/${linkA.id}/visits`, t3);
    check('посторонний не видит журнал → 404', visitsForeign.status === 404, `status ${visitsForeign.status}`);

    const listLinks = await call('GET', `/share-links?refType=drive_node&refId=${folderA}`, t1);
    check('список ссылок объекта отдаётся', listLinks.ok && listLinks.json.data.length >= 2, `ссылок ${listLinks.json?.data?.length}`);
    check('в списке нет хэша пароля', !JSON.stringify(listLinks.json?.data ?? []).includes('passwordHash'));
    // Список обрезан потолком (отозванные не удаляются никогда), поэтому сервер обязан
    // сказать, сколько их всего: молча обрезанная история раздачи наружу читается как
    // полная — а в неё смотрят именно тогда, когда файл где-то всплыл.
    check('список говорит, сколько ссылок всего', typeof listLinks.json?.total === 'number', String(listLinks.json?.total));
    // ORDER BY revoked_at ASC в Postgres кладёт NULL в КОНЕЦ — без явного NULLS FIRST
    // действующие ссылки уезжали бы за потолок страницы, а на экране оставалась история.
    const revokedFlags = (listLinks.json?.data ?? []).map((l) => !!l.revokedAt);
    check(
      'действующие идут первыми, отозванные следом',
      revokedFlags.every((v, i) => i === 0 || !(revokedFlags[i - 1] && !v)),
      revokedFlags.map((v) => (v ? 'x' : '·')).join(''),
    );

    // ============================================================
    // 13. Окончательное удаление отзывает ссылки поддерева
    // ============================================================
    const cPurgeRoot = await call('POST', '/share-links', t1, { refType: 'drive_node', refId: folderA });
    const cPurgeChild = await call('POST', '/share-links', t1, { refType: 'drive_node', refId: folderB });
    created.links.push(cPurgeRoot.json.data.id, cPurgeChild.json.data.id);
    await call('POST', '/drive/nodes/trash', t1, { ids: [folderA] });
    const purge = await call('DELETE', '/drive/nodes', t1, { ids: [folderA] });
    check('окончательное удаление прошло', purge.ok, `status ${purge.status}`);
    const rootLink = await prisma.shareLink.findUnique({ where: { id: cPurgeRoot.json.data.id } });
    const childLink = await prisma.shareLink.findUnique({ where: { id: cPurgeChild.json.data.id } });
    check('ссылка на удалённый корень отозвана', !!rootLink?.revokedAt);
    check('ссылка на вложенную папку тоже отозвана', !!childLink?.revokedAt);
    check('системный отзыв без автора', rootLink?.revokedById === null, String(rootLink?.revokedById));
    // Узлы уже удалены — из списка уборки их убираем
    created.nodes = [];

    // ============================================================
    // 14. Лимит числа активных ссылок на объект
    // ============================================================
    const folderLim = await mk(`sl-lim-${stamp}`);
    const madeIds = [];
    for (let i = 0; i < 20; i++) {
      const r = await call('POST', '/share-links', t1, { refType: 'drive_node', refId: folderLim });
      if (r.ok) madeIds.push(r.json.data.id);
    }
    check('20 ссылок создались', madeIds.length === 20, `создано ${madeIds.length}`);
    const over = await call('POST', '/share-links', t1, { refType: 'drive_node', refId: folderLim });
    check('21-я активная → 400', over.status === 400, `status ${over.status}`);
    created.links.push(...madeIds);

    // ============================================================
    // 14б. Редактор объекта: честный отказ вместо «Объект не найден»
    //
    // На диске организации корень раздаёт роль «правит» КАЖДОМУ сотруднику, поэтому
    // «не найдено» получала вся команда — глядя на этот объект в своём же списке.
    // ============================================================
    const folderEd = await mk(`sl-editor-${stamp}`);
    await call('POST', `/drive/nodes/${folderEd}/shares`, t1, {
      principalType: 'user', principalId: u2, role: 'editor',
    });
    const byEditor = await call('POST', '/share-links', t2, { refType: 'drive_node', refId: folderEd });
    check('редактор → 403 с причиной', byEditor.status === 403, `status ${byEditor.status}`);
    const byStranger = await call('POST', '/share-links', t3, { refType: 'drive_node', refId: folderEd });
    check('посторонний по-прежнему → 404', byStranger.status === 404, `status ${byStranger.status}`);
    const listByEditor = await call('GET', `/share-links?refType=drive_node&refId=${folderEd}`, t2);
    check('чтение списка редактору тоже 403, а не 404', listByEditor.status === 403, `status ${listByEditor.status}`);

    // ============================================================
    // 14в. Байты можно показать во фрейме гостевой страницы
    //
    // helmet ставит X-Frame-Options: SAMEORIGIN на КАЖДЫЙ ответ, а веб и API стоят на
    // разных портах — PDF-отпечаток документа на /s/<токен> просто не рисовался
    // (200 OK в сети, net::ERR_BLOCKED_BY_RESPONSE и пустая рамка на экране).
    // ============================================================
    const rawHead = await fetch(`${BASE}/files/raw/00000000-0000-0000-0000-000000000000?exp=1&sig=x`);
    check('на выдаче байтов нет X-Frame-Options', !rawHead.headers.get('x-frame-options'), rawHead.headers.get('x-frame-options') || 'нет');
    check(
      'вместо него адресный frame-ancestors',
      (rawHead.headers.get('content-security-policy') || '').includes('frame-ancestors'),
      rawHead.headers.get('content-security-policy'),
    );
    const jsonHead = await fetch(`${BASE}/verify/status`);
    check('на обычных ручках фрейминг по-прежнему запрещён', jsonHead.headers.get('x-frame-options') === 'SAMEORIGIN', jsonHead.headers.get('x-frame-options'));

    // ============================================================
    // 15. Документ: ссылку создаёт только владелец
    // ============================================================
    const docsStatus = await call('GET', '/docs/status', t1);
    if (docsStatus.json?.data?.enabled) {
      const docFile = await upload(t1, {
        profile: 'document',
        name: `sl-doc-${stamp}.docx`,
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: DOCX_MIN,
      });
      const doc = await call('POST', '/docs/from-file', t1, { fileId: docFile.id });
      if (doc.ok) {
        const docId = doc.json.data.id;
        const byOther = await call('POST', '/share-links', t3, { refType: 'document', refId: docId });
        check('не-владелец не создаёт ссылку на документ → 404', byOther.status === 404, `status ${byOther.status}`);
        const cDoc = await call('POST', '/share-links', t1, { refType: 'document', refId: docId });
        check('владелец создал ссылку на документ', cDoc.ok, `status ${cDoc.status}`);
        if (cDoc.ok) {
          created.links.push(cDoc.json.data.id);
          const sDoc = await call('POST', `/share-links/guest/${tokenOf(cDoc.json.data.url)}/session`, null, {});
          check('гость документа получает вид документа', sDoc.ok && sDoc.json.data.view.kind === 'document', sDoc.json?.data?.view?.kind);
          check(
            'состояние PDF — готов либо готовится',
            ['ready', 'preparing', 'unavailable'].includes(sDoc.json?.data?.view?.state),
            sDoc.json?.data?.view?.state,
          );

          // Отпечаток считается фоном — дожидаемся его через /view (он НЕ тратит
          // открытия). Без этого всё, что стоит за ГОТОВЫМ PDF — в том числе выдача
          // байтов гостю, — оставалось бы непроверенным.
          const docTok = tokenOf(cDoc.json.data.url);
          const sess = { 'x-share-session': sDoc.json?.data?.sessionToken };
          let state = sDoc.json?.data?.view?.state;
          for (let i = 0; i < 20 && state === 'preparing'; i++) {
            await sleep(1500);
            const v = await call('GET', `/share-links/guest/${docTok}/view`, null, null, sess);
            state = v.json?.data?.view?.state;
          }
          check('PDF-отпечаток документа готов', state === 'ready', state);

          if (state === 'ready') {
            // Заражённый файл — это «показать не можем», а не служебная ошибка. Раньше
            // отсюда наружу летел голый 403 движка файлов: без машинного кода, так что
            // страница обещала «попробуйте через минуту», и заодно подтверждала
            // постороннему человеку, что файл заражён.
            await prisma.fileObject.update({ where: { id: docFile.id }, data: { scanStatus: 'infected' } });
            const infected = await call('GET', `/share-links/guest/${docTok}/view`, null, null, sess);
            check(
              'заражённый документ → честное «недоступен», а не 403',
              infected.ok && infected.json?.data?.view?.state === 'unavailable',
              `${infected.status}/${infected.json?.data?.view?.state}`,
            );
            await prisma.fileObject.update({ where: { id: docFile.id }, data: { scanStatus: 'clean' } });
          }
          // Закрытие документа отзывает его гостевые ссылки
          await call('DELETE', `/docs/${docId}`, t1);
          const afterArchive = await prisma.shareLink.findUnique({ where: { id: cDoc.json.data.id } });
          check('закрытие документа отозвало ссылку', !!afterArchive?.revokedAt);
        }
      } else {
        console.log('~ SKIP документная часть: оживление файла не прошло', doc.status);
      }
    } else {
      console.log('~ SKIP документная часть: редактор документов не подключён');
    }

    // ============================================================
    // 16. Заражённый файл не отдаётся гостю
    // ============================================================
    const infFolder = await mk(`sl-inf-${stamp}`);
    const infFile = await upload(t1, { name: `sl-inf-${stamp}.txt`, mime: 'text/plain', bytes: TXT('заражённый') });
    const infNode = await call('POST', '/drive/nodes', t1, { parentId: infFolder, fileId: infFile.id });
    created.nodes.push(infFolder, infNode.json.data.id);
    await prisma.fileObject.update({ where: { id: infFile.id }, data: { scanStatus: 'infected' } });
    const cInf = await call('POST', '/share-links', t1, { refType: 'drive_node', refId: infFolder });
    created.links.push(cInf.json.data.id);
    const sInf = await call('POST', `/share-links/guest/${tokenOf(cInf.json.data.url)}/session`, null, {});
    const infList = await call('GET', '/drive/guest/nodes', null, null, { [SESSION_HEADER]: sInf.json.data.sessionToken });
    const infRow = (infList.json?.data ?? []).find((n) => n.file);
    check('заражённый файл помечен недоступным', infRow?.file?.available === false, String(infRow?.file?.available));
    check('ссылки на байты заражённого нет', infRow?.file?.url === null, String(infRow?.file?.url));

    console.log(`\nгостевых вызовов за прогон: ${guestCalls} (ни одного 401 — инвариант держится)`);
  } finally {
    // Уборка: только свои объекты и штатным путём
    for (const id of created.nodes) {
      await call('POST', '/drive/nodes/trash', t1, { ids: [id] }).catch(() => {});
      await call('DELETE', '/drive/nodes', t1, { ids: [id] }).catch(() => {});
    }
    await prisma.shareLink.deleteMany({ where: { id: { in: created.links } } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
