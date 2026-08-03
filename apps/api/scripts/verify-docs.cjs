/* eslint-disable */
// Docs Engine (core/docs, 12-й платформенный) — e2e: оживление файла в документ,
// права (место даёт правку, объединение привязок — только просмотр), WOPI-хост
// (CheckFileInfo/GetFile/PutFile/семейство блокировок), мутация ЖИВОГО файла на месте
// (вложение отдаёт актуальное содержимое — п.6 грилла), вехи-версии + ретеншн,
// заражённый файл, отзыв токенов бампом эпохи, алиас /api/v1.
//
// Гейт: движок выключен (нет DOCS_EDITOR_URL) → проверяем ИНЕРТНОСТЬ и выходим SKIP.
// Run (API up, docker compose --profile docs up -d): node scripts/verify-docs.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const { dropFromDrive } = require('./drive-test-helpers.cjs');
const crypto = require('crypto');
const zlib = require('zlib');
// Адрес API переопределяется переменной окружения: два экземпляра на одной машине
// (например, когда :3001 занят чужим дев-сервером) — обычная ситуация при проверке правок.
const BASE = process.env.SA6_API_BASE || 'http://localhost:3001/api';
const P1 = '+77009990001', P2 = '+77009990002', P3 = '+77009990003', PW = 'Test1234!';

let fails = 0, skipped = 0;
const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };
const skip = (n) => { console.log(`○ SKIP  ${n}`); skipped++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, p, token, body, headers) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => {
  const r = await call('POST', '/auth/login', null, { phone, password: PW });
  if (!r.ok) throw new Error(`login ${phone}: ${r.status}`);
  return r.json.data.accessToken;
};

// ---------- минимальный, но НАСТОЯЩИЙ .xlsx (zip stored) ----------
// Нужен именно zip: сниффер magic-bytes движка файлов сверяет сигнатуру с заявленным
// OOXML-типом, и «просто текст» под видом .xlsx был бы отвергнут при загрузке.
function zipFile(entries) {
  const chunks = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Полноценная (пусть и минимальная) книга: цепочка rels обязана быть на месте, иначе
// редактор её не откроет и не сконвертирует — а конвертацию мы здесь проверяем.
const B = (s) => Buffer.from(s, 'utf8');
const xlsx = (cell) => zipFile([
  { name: '[Content_Types].xml', data: B('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>') },
  { name: '_rels/.rels', data: B('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
  { name: 'xl/workbook.xml', data: B('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>') },
  { name: 'xl/_rels/workbook.xml.rels', data: B('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>') },
  { name: 'xl/worksheets/sheet1.xml', data: B(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${cell}</t></is></c></row></sheetData></worksheet>`) },
]);

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function uploadFile(token, bytes, name, mime, profile) {
  const init = await call('POST', '/files', token, { profile, name, mime, size: bytes.length });
  if (!init.ok) throw new Error(`init: ${init.status} ${JSON.stringify(init.json)}`);
  const id = init.json.data.file.id;
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: mime }), name);
  const put = await fetch(`${BASE}/files/${id}/content`, { method: 'PUT', headers: { Authorization: 'Bearer ' + token }, body: fd });
  if (!put.ok) throw new Error(`put content: ${put.status}`);
  const done = await call('POST', `/files/${id}/complete`, token, {});
  if (!done.ok) throw new Error(`complete: ${done.status} ${JSON.stringify(done.json)}`);
  return done.json.data;
}

// ---------- играем роль WOPI-клиента (редактора) ----------
const wopi = {
  info: (docId, token, prefix = '/api') =>
    fetch(`http://localhost:3001${prefix}/wopi/files/${docId}?access_token=${encodeURIComponent(token)}`),
  get: (docId, token) =>
    fetch(`${BASE}/wopi/files/${docId}/contents?access_token=${encodeURIComponent(token)}`),
  put: (docId, token, bytes, headers) =>
    fetch(`${BASE}/wopi/files/${docId}/contents?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...(headers || {}) },
      body: bytes,
    }),
  op: (docId, token, override, headers) =>
    fetch(`${BASE}/wopi/files/${docId}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'X-WOPI-Override': override, ...(headers || {}) },
    }),
};

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2), t3 = await login(P3);
  const uid = async (p) => (await prisma.user.findUnique({ where: { phone: p }, select: { id: true } })).id;
  const u1 = await uid(P1), u2 = await uid(P2), u3 = await uid(P3);

  // ===== Гейт движка =====
  const status = await call('GET', '/docs/status', t1);
  check('GET /docs/status отвечает', status.ok, `status ${status.status}`);
  if (!status.json?.data?.enabled) {
    console.log('\n— движок документов выключен (DOCS_EDITOR_URL пуст): проверяем инертность —');
    const bogus = '11111111-1111-1111-1111-111111111111';
    const info = await wopi.info(bogus, 'garbage');
    check('инертность: WOPI CheckFileInfo → 404', info.status === 404, `status ${info.status}`);
    const put = await wopi.put(bogus, 'garbage', Buffer.from('x'));
    check('инертность: WOPI PutFile → 404 (и тело не роняет парсер)', put.status === 404, `status ${put.status}`);
    const file = await uploadFile(t1, xlsx('нет редактора'), 'смета.xlsx', XLSX_MIME, 'document');
    const doc = await call('POST', '/docs/from-file', t1, { fileId: file.id });
    check('инертность: оживление файла отклонено', doc.status === 400, `status ${doc.status}`);
    await prisma.fileObject.deleteMany({ where: { id: file.id } });
    skip('остальные проверки (нужен поднятый редактор: docker compose --profile docs up -d)');
    await prisma.$disconnect();
    console.log(`\n${fails === 0 ? '✅ ВСЁ ЗЕЛЁНОЕ' : `❌ ПРОВАЛОВ: ${fails}`} (пропущено: ${skipped})`);
    process.exit(fails === 0 ? 0 : 1);
  }

  // ===== Подготовка: задача с исполнителем + вложение =====
  const [a, b] = u1 < u2 ? [u1, u2] : [u2, u1];
  await prisma.contactLink.upsert({
    where: { userAId_userBId: { userAId: a, userBId: b } },
    update: {},
    create: { userAId: a, userBId: b, roleAForB: 'Коллега', roleBForA: 'Коллега', initiatedBy: u1 },
  });

  let docId = null, taskId = null, fileId = null, doc2Id = null, file2Id = null;
  const ORIGINAL = xlsx('дни рождения');
  try {
    const task = await call('POST', '/tasks', t1, { title: 'Внесите свои дни рождения', executorId: u2 });
    check('задача создана (исполнитель t2)', task.ok, `status ${task.status}`);
    taskId = task.json.data.id;

    const file = await uploadFile(t1, ORIGINAL, 'дни рождения.xlsx', XLSX_MIME, 'document');
    fileId = file.id;
    const attach = await call('POST', `/tasks/${taskId}/attachments`, t1, { fileId });
    check('файл прикреплён к задаче', attach.ok, `status ${attach.status}`);

    // ===== Оживление файла в документ =====
    const created = await call('POST', '/docs/from-file', t1, { fileId, refType: 'task', refId: taskId });
    check('оживление файла в документ', created.ok, `status ${created.status} ${JSON.stringify(created.json?.message ?? '')}`);
    docId = created.json?.data?.id;
    check('документ ссылается на ТОТ ЖЕ файл', created.json?.data?.fileId === fileId);
    check('формат определён (xlsx → calc)', created.json?.data?.ext === 'xlsx' && created.json?.data?.editorKind === 'calc');
    check('автор получил права правки', created.json?.data?.access === 'edit');

    const again = await call('POST', '/docs/from-file', t1, { fileId, refType: 'task', refId: taskId });
    check('повторное оживление идемпотентно (тот же документ)', again.ok && again.json?.data?.id === docId);

    // ===== Права =====
    const asExecutor = await call('GET', `/docs/${docId}?refType=task&refId=${taskId}`, t2);
    check('исполнитель задачи правит документ (право от МЕСТА)', asExecutor.ok && asExecutor.json?.data?.access === 'edit', `access ${asExecutor.json?.data?.access}`);
    const withoutCtx = await call('GET', `/docs/${docId}`, t2);
    check('без места — только просмотр (правка не объединяется по привязкам)', withoutCtx.ok && withoutCtx.json?.data?.access === 'view', `access ${withoutCtx.json?.data?.access}`);
    const stranger = await call('GET', `/docs/${docId}`, t3);
    check('посторонний → 403', stranger.status === 403, `status ${stranger.status}`);

    // ===== Запуск редактора =====
    const open = await call('POST', `/docs/${docId}/open`, t1, { refType: 'task', refId: taskId });
    check('open отдаёт адрес редактора', open.ok, `status ${open.status} ${JSON.stringify(open.json?.message ?? '')}`);
    const editorUrl = open.json?.data?.editorUrl ?? '';
    check('editorUrl содержит WOPISrc', editorUrl.includes('WOPISrc='), editorUrl.slice(0, 90));
    check('WOPISrc указывает на наш API (адрес для контейнера)', decodeURIComponent(editorUrl).includes(`/api/wopi/files/${docId}`));
    check('режима НЕТ в WOPISrc (иначе два брокера на документ)', !decodeURIComponent(editorUrl).includes('mode='));
    check('access_token_ttl — метка времени, а не длительность', Number(open.json?.data?.accessTokenTtl) > Date.now());
    const tokenWrite = open.json.data.accessToken;

    const openRo = await call('POST', `/docs/${docId}/open`, t1, { refType: 'task', refId: taskId, readonly: true });
    check('«Открыть» (readonly) выдаёт токен только на чтение', openRo.ok && openRo.json?.data?.mode === 'view');
    const tokenRead = openRo.json.data.accessToken;

    const openStranger = await call('POST', `/docs/${docId}/open`, t3, {});
    check('посторонний не получает токен', openStranger.status === 403, `status ${openStranger.status}`);

    // ===== WOPI: CheckFileInfo =====
    const infoRes = await wopi.info(docId, tokenWrite);
    const info = await infoRes.json();
    check('CheckFileInfo: 200', infoRes.status === 200, `status ${infoRes.status}`);
    check('BaseFileName содержит расширение (иначе документ не откроется)', String(info.BaseFileName).endsWith('.xlsx'), info.BaseFileName);
    check('Size = размер файла', info.Size === ORIGINAL.length, `${info.Size} vs ${ORIGINAL.length}`);
    check('UserCanWrite=true по токену правки', info.UserCanWrite === true);
    check('UserFriendlyName заполнен (имя у курсора соредактора)', typeof info.UserFriendlyName === 'string' && info.UserFriendlyName.length > 0, info.UserFriendlyName);
    check('PostMessageOrigin задан (иначе postMessage не работает вовсе)', typeof info.PostMessageOrigin === 'string' && info.PostMessageOrigin.startsWith('http'));
    check('UserCanNotWriteRelative=true («Сохранить как» убрано)', info.UserCanNotWriteRelative === true);
    check('SupportsLocks/GetLock объявлены', info.SupportsLocks === true && info.SupportsGetLock === true);

    const infoRo = await (await wopi.info(docId, tokenRead)).json();
    check('UserCanWrite=false по токену чтения', infoRo.UserCanWrite === false && infoRo.ReadOnly === true);

    const infoV1 = await wopi.info(docId, tokenWrite, '/api/v1');
    check('регрессия алиаса: /api/v1/wopi/... работает', infoV1.status === 200, `status ${infoV1.status}`);

    const badToken = await wopi.info(docId, tokenWrite.slice(0, -3) + 'zzz');
    check('подделанная подпись токена → 401', badToken.status === 401, `status ${badToken.status}`);

    // ===== WOPI: GetFile =====
    const getRes = await wopi.get(docId, tokenWrite);
    const gotBytes = Buffer.from(await getRes.arrayBuffer());
    check('GetFile отдаёт исходные байты', getRes.status === 200 && gotBytes.equals(ORIGINAL), `${gotBytes.length} байт`);

    // ===== WOPI: блокировки =====
    const lockA = await wopi.op(docId, tokenWrite, 'LOCK', { 'X-WOPI-Lock': 'LOCK-A' });
    check('LOCK: блокировка взята', lockA.status === 200, `status ${lockA.status}`);
    const lockB = await wopi.op(docId, tokenWrite, 'LOCK', { 'X-WOPI-Lock': 'LOCK-B' });
    check('LOCK чужой строкой → 409', lockB.status === 409, `status ${lockB.status}`);
    check('409 несёт X-WOPI-Lock с текущей строкой', lockB.headers.get('x-wopi-lock') === 'LOCK-A', lockB.headers.get('x-wopi-lock'));
    const getLock = await wopi.op(docId, tokenWrite, 'GET_LOCK');
    check('GET_LOCK возвращает текущую блокировку', getLock.headers.get('x-wopi-lock') === 'LOCK-A');
    const refresh = await wopi.op(docId, tokenWrite, 'REFRESH_LOCK', { 'X-WOPI-Lock': 'LOCK-A' });
    check('REFRESH_LOCK продлевает', refresh.status === 200, `status ${refresh.status}`);
    const relative = await wopi.op(docId, tokenWrite, 'PUT_RELATIVE', { 'X-WOPI-Lock': 'LOCK-A' });
    check('PutRelativeFile не реализован → 501', relative.status === 501, `status ${relative.status}`);

    // ===== WOPI: PutFile =====
    const EDITED = xlsx('дни рождения + Диана 12.04');
    const putWrongLock = await wopi.put(docId, tokenWrite, EDITED, { 'X-WOPI-Lock': 'LOCK-B' });
    check('PutFile с чужой блокировкой → 409 + заголовок', putWrongLock.status === 409 && putWrongLock.headers.get('x-wopi-lock') === 'LOCK-A', `status ${putWrongLock.status}`);

    const putRo = await wopi.put(docId, tokenRead, EDITED, { 'X-WOPI-Lock': 'LOCK-A' });
    check('PutFile токеном «только чтение» → 403', putRo.status === 403, `status ${putRo.status}`);

    // Клиент присылает ту метку, которую видел в CheckFileInfo — конфликта быть не должно
    const putOk = await wopi.put(docId, tokenWrite, EDITED, { 'X-WOPI-Lock': 'LOCK-A', 'X-COOL-WOPI-Timestamp': info.LastModifiedTime });
    check('PutFile принят (метка клиента совпадает — ложного конфликта нет)', putOk.status === 200, `status ${putOk.status}`);
    check('ответ несёт новую LastModifiedTime (клиент обновит свою метку)', typeof (await putOk.clone().json()).LastModifiedTime === 'string');
    const staleTs = new Date(Date.parse(info.LastModifiedTime) - 60000).toISOString();

    const savedFile = await prisma.fileObject.findUnique({ where: { id: fileId } });
    check('РЕГРЕССИЯ п.6: id файла не изменился (вложение живо)', !!savedFile && savedFile.status === 'ready');
    check('размер файла обновился на новые байты', Number(savedFile.size) === EDITED.length, `${savedFile.size} vs ${EDITED.length}`);
    check('sha256 пересчитан', savedFile.sha256 === crypto.createHash('sha256').update(EDITED).digest('hex'));
    // 'skipped' — офисные документы антивирус не гоняет (решение продукта): их правит
    // наш же редактор, и полный скан на каждое автосохранение стоил бы дорого впустую.
    check(
      'вердикт антивируса пересчитан (байты новые)',
      ['none', 'pending', 'skipped'].includes(savedFile.scanStatus),
      savedFile.scanStatus,
    );

    const afterPut = await wopi.get(docId, tokenWrite);
    check('GetFile отдаёт уже новое содержимое', Buffer.from(await afterPut.arrayBuffer()).equals(EDITED));

    // Вложение задачи отдаёт актуальное содержимое (тот же fileId)
    const dl = await call('GET', `/files/${fileId}/download`, t2);
    check('вложение задачи скачивается участником', dl.ok, `status ${dl.status}`);
    const dlBytes = Buffer.from(await (await fetch(dl.json.data.url)).arrayBuffer());
    check('РЕГРЕССИЯ п.6: скачанное вложение = правки редактора', dlBytes.equals(EDITED), `${dlBytes.length} байт`);

    // Внеполосное изменение: теперь наша метка НОВЕЕ клиентской → 1010
    const conflict = await wopi.put(docId, tokenWrite, xlsx('конфликт'), { 'X-WOPI-Lock': 'LOCK-A', 'X-COOL-WOPI-Timestamp': staleTs });
    check('внеполосное изменение → 409 + COOLStatusCode 1010', conflict.status === 409 && (await conflict.json()).COOLStatusCode === 1010, `status ${conflict.status}`);

    // ===== Веха на Unlock =====
    const unlock = await wopi.op(docId, tokenWrite, 'UNLOCK', { 'X-WOPI-Lock': 'LOCK-A' });
    check('UNLOCK: блокировка снята', unlock.status === 200, `status ${unlock.status}`);
    check('сессия правки закрыта', (await prisma.documentSession.count({ where: { documentId: docId, status: 'open' } })) === 0);

    let versions = [];
    for (let i = 0; i < 25; i++) {
      const r = await call('GET', `/docs/${docId}/versions`, t1);
      versions = r.json?.data ?? [];
      if (versions.length && versions[0].status === 'ready') break;
      await sleep(1000);
    }
    check('Unlock нарезал веху (джоб материализовал снимок)', versions.length === 1 && versions[0].status === 'ready', JSON.stringify(versions.map((v) => v.status)));
    check('веха помнит участников правки', (versions[0]?.authorIds ?? []).length > 0);
    check('веха хранит СНИМОК содержимого на момент закрытия', versions[0]?.sha256 === crypto.createHash('sha256').update(EDITED).digest('hex') && versions[0]?.size === EDITED.length, `${versions[0]?.size} байт`);

    // Повторный цикл БЕЗ правок — вехи не плодим
    await wopi.op(docId, tokenWrite, 'LOCK', { 'X-WOPI-Lock': 'LOCK-C' });
    await wopi.op(docId, tokenWrite, 'UNLOCK', { 'X-WOPI-Lock': 'LOCK-C' });
    await sleep(1500);
    const versionsAgain = (await call('GET', `/docs/${docId}/versions`, t1)).json?.data ?? [];
    check('правка без изменений не создаёт новую веху', versionsAgain.length === 1, `версий ${versionsAgain.length}`);

    // ===== РЕВЬЮ: протокол и неаутентифицированный путь =====
    const gvRes = await wopi.get(docId, tokenWrite);
    await gvRes.arrayBuffer();
    const gvInfo = await (await wopi.info(docId, tokenWrite)).json();
    check(
      'X-WOPI-ItemVersion в GetFile совпадает с Version из CheckFileInfo',
      gvRes.headers.get('x-wopi-itemversion') === gvInfo.Version,
      `${gvRes.headers.get('x-wopi-itemversion')} vs ${gvInfo.Version}`,
    );

    await wopi.op(docId, tokenWrite, 'LOCK', { 'X-WOPI-Lock': 'LOCK-G' });
    const putNoLock = await wopi.put(docId, tokenWrite, xlsx('без блокировки'));
    check(
      'PutFile БЕЗ блокировки при живой блокировке → 409 + X-WOPI-Lock',
      putNoLock.status === 409 && putNoLock.headers.get('x-wopi-lock') === 'LOCK-G',
      `status ${putNoLock.status}`,
    );
    await wopi.op(docId, tokenWrite, 'UNLOCK', { 'X-WOPI-Lock': 'LOCK-G' });

    const putBadToken = await wopi.put(docId, 'v1.bXVzb3I.cG9kcGlz', xlsx('мусор'));
    check('PutFile с недействительным токеном → 401 (тело на диск не пишется)', putBadToken.status === 401, `status ${putBadToken.status}`);

    // ===== Заражённый файл =====
    await prisma.fileObject.update({ where: { id: fileId }, data: { scanStatus: 'infected' } });
    const infected = await wopi.get(docId, tokenWrite);
    check('заражённый файл не отдаётся редактору', infected.status === 403, `status ${infected.status}`);
    await prisma.fileObject.update({ where: { id: fileId }, data: { scanStatus: 'clean' } });

    // ===== Отзыв токенов бампом эпохи («только чтение») =====
    const freeze = await call('PATCH', `/docs/${docId}`, t1, { mode: 'readonly' });
    check('владелец переводит документ в «только чтение»', freeze.ok && freeze.json?.data?.mode === 'readonly', `status ${freeze.status}`);
    const revoked = await wopi.info(docId, tokenWrite);
    check('выданные токены погашены бампом эпохи → 401', revoked.status === 401, `status ${revoked.status}`);
    const roView = await call('GET', `/docs/${docId}?refType=task&refId=${taskId}`, t2);
    check('в режиме «только чтение» участник видит, но не правит', roView.ok && roView.json?.data?.access === 'view', `access ${roView.json?.data?.access}`);
    await call('PATCH', `/docs/${docId}`, t1, { mode: 'edit' });

    // ===== Ленивая конвертация (PDF-отпечаток под печать и будущую ЭЦП) =====
    const rendition = await call('POST', `/docs/${docId}/rendition`, t1, { target: 'pdf' });
    check('заказ PDF-отпечатка принят', rendition.ok, `status ${rendition.status}`);
    let pdfVariant = null;
    for (let i = 0; i < 30; i++) {
      pdfVariant = await prisma.fileVariant.findUnique({ where: { fileId_kind: { fileId, kind: 'pdf' } } });
      if (pdfVariant) break;
      await sleep(1000);
    }
    check('PDF-отпечаток посчитан редактором', !!pdfVariant && pdfVariant.mime === 'application/pdf', pdfVariant ? `${pdfVariant.size} байт` : 'нет варианта');
    if (pdfVariant) {
      const pdfUrl = await call('GET', `/files/${fileId}/download?variant=pdf`, t1);
      const pdfBytes = Buffer.from(await (await fetch(pdfUrl.json.data.url)).arrayBuffer());
      check('PDF отдаётся ссылкой варианта', pdfBytes.subarray(0, 5).toString() === '%PDF-', pdfBytes.subarray(0, 5).toString());
    }
    const again2 = await call('POST', `/docs/${docId}/rendition`, t1, { target: 'pdf' });
    check('повторный заказ видит готовую производную', again2.json?.data?.ready === true);

    // ===== Ретеншн: 20 последних + подписанные =====
    const bulk = [];
    for (let n = 2; n <= 26; n++) {
      bulk.push({
        documentId: docId, versionNo: n, status: 'ready', reason: 'manual',
        sha256: crypto.createHash('sha256').update(`fake-${n}`).digest('hex'),
        size: BigInt(10), signed: n === 2,
      });
    }
    await prisma.documentVersion.createMany({ data: bulk });
    await prisma.document.update({ where: { id: docId }, data: { lastVersionNo: 26 } });

    const reopen = await call('POST', `/docs/${docId}/open`, t1, { refType: 'task', refId: taskId });
    const tokenFresh = reopen.json.data.accessToken;
    await wopi.op(docId, tokenFresh, 'LOCK', { 'X-WOPI-Lock': 'LOCK-D' });
    await wopi.put(docId, tokenFresh, xlsx('ретеншн'), { 'X-WOPI-Lock': 'LOCK-D' });
    await wopi.op(docId, tokenFresh, 'UNLOCK', { 'X-WOPI-Lock': 'LOCK-D' });

    let ready = 0, signedAlive = 0;
    for (let i = 0; i < 25; i++) {
      ready = await prisma.documentVersion.count({ where: { documentId: docId, status: 'ready' } });
      signedAlive = await prisma.documentVersion.count({ where: { documentId: docId, signed: true } });
      if (ready === 11) break;
      await sleep(1000);
    }
    check('ретеншн держит потолок числа версий', ready === 11, `готовых версий ${ready} (10 + подписанная)`);
    check('подписанная веха переживает ретеншн (на неё сошлётся ЭЦП)', signedAlive === 1);

    // Бюджет места: у ТЯЖЁЛЫХ версий счёт идёт не по числу, а по занятому месту —
    // 10 копий по 150 МБ съели бы полторы гигабайта квоты владельца.
    await prisma.documentVersion.updateMany({
      where: { documentId: docId, status: 'ready', signed: false },
      data: { size: BigInt(150 * 1024 * 1024) },
    });
    await wopi.op(docId, tokenFresh, 'LOCK', { 'X-WOPI-Lock': 'LOCK-F' });
    await wopi.put(docId, tokenFresh, xlsx('бюджет'), { 'X-WOPI-Lock': 'LOCK-F' });
    await wopi.op(docId, tokenFresh, 'UNLOCK', { 'X-WOPI-Lock': 'LOCK-F' });
    let heavy = 99;
    for (let i = 0; i < 25; i++) {
      heavy = await prisma.documentVersion.count({ where: { documentId: docId, status: 'ready', signed: false } });
      if (heavy <= 2) break;
      await sleep(1000);
    }
    check('тяжёлые версии режутся по бюджету места, а не по числу', heavy === 2, `осталось ${heavy} (минимум 2)`);
    check('подписанная переживает и бюджет', (await prisma.documentVersion.count({ where: { documentId: docId, signed: true } })) === 1);

    // ===== Жнец брошенной блокировки =====
    await wopi.op(docId, tokenFresh, 'LOCK', { 'X-WOPI-Lock': 'LOCK-E' });
    await prisma.documentSession.updateMany({
      where: { documentId: docId, status: 'open' },
      data: { expiresAt: new Date(Date.now() - 60000) },
    });
    const staleLock = await wopi.op(docId, tokenFresh, 'GET_LOCK');
    check('протухшая блокировка не держит документ', staleLock.headers.get('x-wopi-lock') === '', `«${staleLock.headers.get('x-wopi-lock')}»`);

    // =========================================================================
    // РЕВЬЮ: владение, отзыв прав на лету, «неудобный» MIME, конец жизни
    // Отдельный документ: файл льёт t1, а ОЖИВЛЯЕТ его t2 (участник задачи) — и
    // MIME у файла тот, что реально шлют браузеры на офисных файлах.
    // =========================================================================
    const file2 = await uploadFile(t1, xlsx('второй'), 'смета.xlsx', 'application/octet-stream', 'chat_attachment');
    file2Id = file2.id;
    await call('POST', `/tasks/${taskId}/attachments`, t1, { fileId: file2Id });

    const foreign = await call('POST', '/tasks', t2, { title: 'Своя задача t2' });
    const foreignTaskId = foreign.json?.data?.id;
    const steal = await call('POST', `/tasks/${foreignTaskId}/attachments`, t2, { fileId: file2Id });
    check('чужой файл нельзя прицепить к своей задаче (иначе место = самовыдача прав)', !steal.ok, `status ${steal.status}`);
    await call('DELETE', `/tasks/${foreignTaskId}`, t2);

    const doc2res = await call('POST', '/docs/from-file', t2, { fileId: file2Id, refType: 'task', refId: taskId });
    check('участник оживляет вложение коллеги', doc2res.ok, `status ${doc2res.status} ${JSON.stringify(doc2res.json?.message ?? '')}`);
    doc2Id = doc2res.json?.data?.id;
    check('MIME документа канонический, а не octet-stream клиента', doc2res.json?.data?.mime === XLSX_MIME, doc2res.json?.data?.mime);
    check('ВЛАДЕЛЕЦ документа — владелец файла, а не тот, кто нажал «Редактировать»', doc2res.json?.data?.createdById === u1, `createdById ${doc2res.json?.data?.createdById === u2 ? 't2' : doc2res.json?.data?.createdById}`);

    const rename2 = await call('PATCH', `/docs/${doc2Id}`, t2, { title: 'Захват' });
    check('ожививший НЕ управляет чужим документом (не запрёт автора в его же файле)', rename2.status === 403, `status ${rename2.status}`);
    const rename1 = await call('PATCH', `/docs/${doc2Id}`, t1, { title: 'Смета' });
    check('владелец файла управляет документом, хотя оживил не он', rename1.ok, `status ${rename1.status}`);

    // Правка исполнителем + веха: до фикса снимок падал на белом списке MIME профиля
    const open2 = await call('POST', `/docs/${doc2Id}/open`, t2, { refType: 'task', refId: taskId });
    check('исполнитель получает токен на правку', open2.ok && open2.json?.data?.mode === 'edit', `mode ${open2.json?.data?.mode}`);
    const token2 = open2.json.data.accessToken;
    await wopi.op(doc2Id, token2, 'LOCK', { 'X-WOPI-Lock': 'LOCK-2' });
    const put2 = await wopi.put(doc2Id, token2, xlsx('правка исполнителя'), { 'X-WOPI-Lock': 'LOCK-2' });
    check('исполнитель сохраняет правки', put2.status === 200, `status ${put2.status}`);
    const noPlaceVersion = await call('POST', `/docs/${doc2Id}/versions`, t2, { reason: 'manual' });
    check('«Сохранить версию» без места — 403 (право правки по привязкам не объединяется)', noPlaceVersion.status === 403, `status ${noPlaceVersion.status}`);
    const placeVersion = await call('POST', `/docs/${doc2Id}/versions`, t2, { reason: 'manual', refType: 'task', refId: taskId });
    check('…и работает, когда место передано (иначе кнопка 403 у того, кто прямо сейчас правит)', placeVersion.ok, `status ${placeVersion.status}`);
    const [vA, vB] = await Promise.all([
      call('POST', `/docs/${doc2Id}/versions`, t2, { reason: 'manual', refType: 'task', refId: taskId }),
      call('POST', `/docs/${doc2Id}/versions`, t2, { reason: 'manual', refType: 'task', refId: taskId }),
    ]);
    check('две одновременные «Сохранить версию» не дают 500 (номер вехи атомарен)', vA.status < 500 && vB.status < 500, `${vA.status}/${vB.status}`);
    await wopi.op(doc2Id, token2, 'UNLOCK', { 'X-WOPI-Lock': 'LOCK-2' });

    let v2 = [];
    for (let i = 0; i < 25; i++) {
      v2 = await prisma.documentVersion.findMany({ where: { documentId: doc2Id } });
      if (v2.some((v) => v.status === 'ready')) break;
      await sleep(1000);
    }
    check('веха режется и у файла с «неудобным» MIME', v2.some((v) => v.status === 'ready'), JSON.stringify(v2.map((v) => v.status)));
    check('ни одна веха не ушла в failed', !v2.some((v) => v.status === 'failed'), JSON.stringify(v2.map((v) => v.status)));

    // ===== Версию видно, можно скачать и вернуть =====
    const vList = (await call('GET', `/docs/${doc2Id}/versions?refType=task&refId=${taskId}`, t2)).json?.data ?? [];
    const snapshot = vList.find((v) => v.status === 'ready');
    check('версия отдаёт fileId (иначе список — витрина без содержимого)', !!snapshot?.fileId, JSON.stringify(vList.map((v) => v.status)));
    if (snapshot?.fileId) {
      const dlV = await call('GET', `/files/${snapshot.fileId}/download`, t2);
      const vBytes = Buffer.from(await (await fetch(dlV.json.data.url)).arrayBuffer());
      check('версию можно скачать', dlV.ok && vBytes.length > 0, `${vBytes.length} байт`);
    }

    // Меняем содержимое поверх версии — и возвращаем версию как текущую
    const openT1 = await call('POST', `/docs/${doc2Id}/open`, t1, {});
    const tok1 = openT1.json.data.accessToken;
    await wopi.op(doc2Id, tok1, 'LOCK', { 'X-WOPI-Lock': 'LOCK-3' });
    await wopi.put(doc2Id, tok1, xlsx('поверх версии'), { 'X-WOPI-Lock': 'LOCK-3' });
    const restoreBusy = await call('POST', `/docs/${doc2Id}/versions/${snapshot?.id}/restore`, t1, {});
    check('вернуть версию при открытом редакторе нельзя (409)', restoreBusy.status === 409, `status ${restoreBusy.status}`);
    await wopi.op(doc2Id, tok1, 'UNLOCK', { 'X-WOPI-Lock': 'LOCK-3' });

    const restored = await call('POST', `/docs/${doc2Id}/versions/${snapshot?.id}/restore`, t1, {});
    check('версия возвращена как текущая', restored.ok, `status ${restored.status} ${JSON.stringify(restored.json?.message ?? '')}`);
    const liveDl = await call('GET', `/files/${file2Id}/download`, t1);
    const liveBytes = Buffer.from(await (await fetch(liveDl.json.data.url)).arrayBuffer());
    check('содержимое файла = содержимое возвращённой версии', liveBytes.equals(xlsx('правка исполнителя')), `${liveBytes.length} байт`);
    check(
      'нынешнее содержимое перед возвратом уехало в историю (возврат отменяем)',
      (await prisma.documentVersion.count({ where: { documentId: doc2Id, status: 'ready' } })) >= 2,
    );

    // ===== Хроника: кто когда правил =====
    const docChron = await prisma.chatterEntry.findFirst({
      where: { refType: 'document', refId: doc2Id, typeKey: 'document.edited' },
    });
    check('заход правки записан в хронику документа', !!docChron, docChron ? String(docChron.payload?.period ?? '') : 'нет записи');
    check('запись несёт промежуток времени', !!docChron?.payload?.period);
    const placeChron = await prisma.chatterEntry.findFirst({
      where: { refType: 'task', refId: taskId, typeKey: 'task.document_edited' },
    });
    check('и в хронику МЕСТА (оттуда плашка в чат задачи)', !!placeChron);
    // Склейка: у ПЕРВОГО документа было три захода с сохранениями (LOCK-A, LOCK-D,
    // LOCK-F) — и все от одного человека. В чат должна уйти ОДНА плашка, иначе он
    // превратится в ленту «правил… правил… правил…». Записи по другому документу или
    // от другого человека склеиваться не должны — это разные факты.
    const glued = await prisma.chatterEntry.count({
      where: {
        refType: 'task',
        refId: taskId,
        typeKey: 'task.document_edited',
        payload: { path: ['documentId'], equals: docId },
      },
    });
    check('повторные заходы одного человека дают ОДНУ плашку в чат', glued === 1, `записей ${glued}`);
    check(
      'возврат версии тоже попал в историю',
      !!(await prisma.chatterEntry.findFirst({ where: { refType: 'document', refId: doc2Id, typeKey: 'document.restored' } })),
    );

    // ===== Потолок размера: белого прямоугольника вместо документа не будет =====
    const hugeId = crypto.randomUUID();
    await prisma.fileObject.create({
      data: {
        id: hugeId, ownerType: 'user', ownerId: u1, uploaderId: u1, profile: 'chat_attachment',
        kind: 'document', name: 'огромная.xlsx', mime: XLSX_MIME, size: BigInt(90 * 1024 * 1024),
        status: 'ready', visibility: 'private', storageDriver: 'local', storageKey: `zz/zz/${hugeId}`,
      },
    });
    const huge = await call('POST', '/docs/from-file', t1, { fileId: hugeId });
    check('файл больше потолка не оживляется в документ', huge.status === 400, `status ${huge.status}`);
    check('…и отказ объясняет, что делать', String(huge.json?.message ?? '').includes('скачайте'), huge.json?.message);
    await prisma.fileObject.deleteMany({ where: { id: hugeId } });

    // ===== Отзыв доступа на лету: выданный токен перестаёт работать сразу =====
    const infoBefore = await wopi.info(doc2Id, token2);
    check('до отзыва токен исполнителя работает', infoBefore.status === 200, `status ${infoBefore.status}`);
    // Снимаем через API: доменная мутация ещё и пересобирает проекцию ролей в core/access
    // (прямая правка таблицы оставила бы устаревший тапл и проверяла бы не то).
    const reassign = await call('PATCH', `/tasks/${taskId}`, t1, { executorId: u1 });
    check('исполнитель заменён (t2 больше не участник)', reassign.ok, `status ${reassign.status}`);
    const infoAfter = await wopi.info(doc2Id, token2);
    check('сняли с задачи → выданный WOPI-токен мёртв немедленно', infoAfter.status === 401, `status ${infoAfter.status}`);
    const putAfter = await wopi.put(doc2Id, token2, xlsx('после отзыва'), { 'X-WOPI-Lock': 'LOCK-2' });
    check('и записать он уже ничего не может', putAfter.status === 401, `status ${putAfter.status}`);
    const openOwner = await call('POST', `/docs/${doc2Id}/open`, t1, {});
    check('отзыв точечный: владелец продолжает работать', openOwner.ok && (await wopi.info(doc2Id, openOwner.json.data.accessToken)).status === 200);

    // ===== Место удалили → документ закрыт, байты и квота возвращены =====
    // Диск — тоже МЕСТО: свои загрузки складываются туда сами, и пока дом есть, файл
    // сиротой не считается (это задумано). Убираем дом, чтобы посылка «мест не
    // осталось» стала правдой и проверялась именно уборка движка.
    await dropFromDrive(prisma, file2Id);
    const detach = await call('DELETE', `/tasks/${taskId}/attachments/${file2Id}`, t1);
    check('вложение снято с задачи', detach.ok, `status ${detach.status}`);
    let doc2row = null, file2row = null;
    for (let i = 0; i < 10; i++) {
      doc2row = await prisma.document.findUnique({ where: { id: doc2Id } });
      file2row = await prisma.fileObject.findUnique({ where: { id: file2Id } });
      if (doc2row?.status === 'archived' && file2row?.status === 'deleted') break;
      await sleep(500);
    }
    check('места не осталось → документ закрыт', doc2row?.status === 'archived', `status ${doc2row?.status}`);
    check('…и файл больше не висит вечно якорем документа (квота вернулась)', file2row?.status === 'deleted', `status ${file2row?.status}`);
    check('закрытый документ недоступен', (await call('GET', `/docs/${doc2Id}`, t1)).status === 404);

    // ===== Кнопка владельца «закрыть документ» (файл-вложение остаётся жить) =====
    const killByStranger = await call('DELETE', `/docs/${docId}`, t2);
    check('закрыть документ может только владелец', killByStranger.status === 403, `status ${killByStranger.status}`);
    const kill = await call('DELETE', `/docs/${docId}`, t1);
    check('владелец закрывает документ', kill.ok, `status ${kill.status}`);
    check('закрытие документа НЕ уносит вложение задачи', (await prisma.fileObject.findUnique({ where: { id: fileId } }))?.status === 'ready');
  } finally {
    // Уборка: документы (каскадом версии/сессии) + вложения + задача
    for (const id of [docId, doc2Id].filter(Boolean)) {
      const versionIds = (await prisma.documentVersion.findMany({ where: { documentId: id }, select: { id: true } })).map((v) => v.id);
      const snapshotIds = (await prisma.fileLink.findMany({ where: { refType: 'document_version', refId: { in: versionIds } }, select: { fileId: true } })).map((l) => l.fileId);
      await prisma.document.delete({ where: { id } }).catch(() => {});
      await prisma.fileObject.deleteMany({ where: { id: { in: snapshotIds } } });
      await prisma.relationTuple.deleteMany({ where: { resourceType: 'document', resourceId: id } });
      // Хроника FK-free (переживает сущность) — чистим сами, иначе повторный прогон
      // считал бы записи прошлого
      await prisma.chatterEntry.deleteMany({ where: { refType: 'document', refId: id } });
    }
    if (taskId) {
      await prisma.chatterEntry.deleteMany({ where: { refType: 'task', refId: taskId } });
    }
    for (const id of [fileId, file2Id].filter(Boolean)) {
      await prisma.fileObject.deleteMany({ where: { id } });
    }
    if (taskId) await prisma.task.delete({ where: { id: taskId } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ ВСЁ ЗЕЛЁНОЕ' : `❌ ПРОВАЛОВ: ${fails}`}${skipped ? ` (пропущено: ${skipped})` : ''}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
