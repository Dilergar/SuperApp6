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
const crypto = require('crypto');
const zlib = require('zlib');
const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567', P2 = '+77012345678', P3 = '+77023456789', PW = 'Test1234!';

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

  let docId = null, taskId = null, fileId = null;
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
    check('вердикт антивируса сброшен (байты новые)', savedFile.scanStatus === 'none' || savedFile.scanStatus === 'pending', savedFile.scanStatus);

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
      if (ready === 21) break;
      await sleep(1000);
    }
    check('ретеншн оставил 20 последних вех', ready === 21, `готовых версий ${ready} (20 + подписанная)`);
    check('подписанная веха переживает ретеншн (на неё сошлётся ЭЦП)', signedAlive === 1);

    // ===== Жнец брошенной блокировки =====
    await wopi.op(docId, tokenFresh, 'LOCK', { 'X-WOPI-Lock': 'LOCK-E' });
    await prisma.documentSession.updateMany({
      where: { documentId: docId, status: 'open' },
      data: { expiresAt: new Date(Date.now() - 60000) },
    });
    const staleLock = await wopi.op(docId, tokenFresh, 'GET_LOCK');
    check('протухшая блокировка не держит документ', staleLock.headers.get('x-wopi-lock') === '', `«${staleLock.headers.get('x-wopi-lock')}»`);
  } finally {
    // Уборка: документ (каскадом версии/сессии) + вложение + задача
    if (docId) {
      const versionIds = (await prisma.documentVersion.findMany({ where: { documentId: docId }, select: { id: true } })).map((v) => v.id);
      const snapshotIds = (await prisma.fileLink.findMany({ where: { refType: 'document_version', refId: { in: versionIds } }, select: { fileId: true } })).map((l) => l.fileId);
      await prisma.document.delete({ where: { id: docId } }).catch(() => {});
      await prisma.fileObject.deleteMany({ where: { id: { in: snapshotIds } } });
      await prisma.relationTuple.deleteMany({ where: { resourceType: 'document', resourceId: docId } });
    }
    if (fileId) await prisma.fileObject.deleteMany({ where: { id: fileId } });
    if (taskId) await prisma.task.delete({ where: { id: taskId } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ ВСЁ ЗЕЛЁНОЕ' : `❌ ПРОВАЛОВ: ${fails}`}${skipped ? ` (пропущено: ${skipped})` : ''}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
