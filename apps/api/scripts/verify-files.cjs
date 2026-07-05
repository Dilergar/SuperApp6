/* eslint-disable */
// Files Engine (core/files) — e2e фундамента: init→байты→complete (Slack v2), sha256,
// медиа-конвейер (thumb webp + width/height), приватная выдача (HMAC-ссылка без JWT,
// Range 206), публичный класс (вечный токен + immutable-кэш + variant), доступ (403
// чужому, порченая подпись), гигиена (exe-blacklist, whitelist профиля, magic-bytes,
// лимит размера), квоты (инкремент/декремент, двойной complete), GC-кроны (stale/purge/reconcile).
// Run (API up, FILES_DRIVER=local): node scripts/verify-files.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567', P2 = '+77012345678', PW = 'Test1234!';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let fails = 0;
const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };
async function call(method, p, token, body, headers) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
async function upload(p, token, bytes, filename, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: mime }), filename);
  const res = await fetch(BASE + p, { method: 'PUT', headers: { Authorization: 'Bearer ' + token }, body: fd });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}: ${r.status}`); return r.json.data.accessToken; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Полный цикл: init → PUT content → complete. Возвращает file DTO. */
async function uploadWhole(token, { profile, name, mime, bytes }) {
  const init = await call('POST', '/files', token, { profile, name, mime, size: bytes.length });
  if (!init.ok) return { init };
  const id = init.json.data.file.id;
  const put = await upload(`/files/${id}/content`, token, bytes, name, mime);
  if (!put.ok) return { init, put };
  const done = await call('POST', `/files/${id}/complete`, token, {});
  return { init, put, done, id, file: done.json?.data };
}

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2);
  const uid = async (p) => (await prisma.user.findUnique({ where: { phone: p }, select: { id: true } })).id;
  const u1 = await uid(P1), u2 = await uid(P2);

  // Чистый старт: файлы тестеров + их квоты
  await prisma.fileObject.deleteMany({ where: { uploaderId: { in: [u1, u2] } } });
  await prisma.fileQuotaUsage.deleteMany({ where: { ownerType: 'user', ownerId: { in: [u1, u2] } } });

  try {
    // ===== Загрузка: init → байты → complete =====
    const sha = crypto.createHash('sha256').update(PNG_1PX).digest('hex');
    const init = await call('POST', '/files', t1, { profile: 'avatar', name: 'аватар тест.png', mime: 'image/png', size: PNG_1PX.length });
    check('init: создан intent (uploading)', init.ok && init.json?.data?.file?.status === 'uploading', `status ${init.status}`);
    check('init: транспорт api для мелкого файла', init.json?.data?.transport === 'api');
    check('init: publicUrl скрыт до готовности', init.json?.data?.file?.publicUrl === null);
    const fileId = init.json.data.file.id;

    const put = await upload(`/files/${fileId}/content`, t1, PNG_1PX, 'аватар тест.png', 'image/png');
    check('байты приняты через API', put.ok, `status ${put.status}`);

    const done = await call('POST', `/files/${fileId}/complete`, t1, {});
    check('complete: файл ready', done.ok && done.json?.data?.status === 'ready', `status ${done.status}`);
    check('sha256 посчитан на потоке и совпал', done.json?.data?.sha256 === sha, done.json?.data?.sha256);
    check('размер = фактический', done.json?.data?.size === PNG_1PX.length);
    check('kind = image', done.json?.data?.kind === 'image');
    check('avatar → публичный класс + вечная ссылка', typeof done.json?.data?.publicUrl === 'string' && done.json.data.publicUrl.includes('/public-files/'));

    const dup = await call('POST', `/files/${fileId}/complete`, t1, {});
    check('повторный complete → 409 (нет двойного зачёта квоты)', dup.status === 409, `status ${dup.status}`);

    // ===== Медиа-конвейер =====
    let meta = null;
    for (let i = 0; i < 15; i++) {
      const r = await call('GET', `/files/${fileId}`, t1);
      meta = r.json?.data;
      if (meta?.variants?.some((v) => v.kind === 'thumb')) break;
      await sleep(1000);
    }
    check('конвейер: thumb-вариант webp создан', meta?.variants?.some((v) => v.kind === 'thumb' && v.mime === 'image/webp'), JSON.stringify(meta?.variants));
    check('конвейер: width/height в meta', meta?.meta?.width === 1 && meta?.meta?.height === 1, JSON.stringify(meta?.meta));
    check('конвейер: medium не создан для крошечной картинки', !meta?.variants?.some((v) => v.kind === 'medium'));
    check('конвейер: pipeline=done', meta?.meta?.pipeline === 'done');

    // ===== Приватная выдача (HMAC-ссылка, без JWT) =====
    const dl = await call('GET', `/files/${fileId}/download`, t1);
    check('download: выдана ссылка с expiresAt', dl.ok && typeof dl.json?.data?.url === 'string' && !!dl.json?.data?.expiresAt);
    const rawUrl = dl.json.data.url;
    const rawRes = await fetch(rawUrl);
    const rawBytes = Buffer.from(await rawRes.arrayBuffer());
    check('ссылка работает БЕЗ Authorization', rawRes.status === 200, `status ${rawRes.status}`);
    check('байты совпали', rawBytes.equals(PNG_1PX));
    check('Content-Type сохранён', (rawRes.headers.get('content-type') || '').includes('image/png'));
    check('nosniff выставлен', rawRes.headers.get('x-content-type-options') === 'nosniff');

    const rangeRes = await fetch(rawUrl, { headers: { Range: 'bytes=0-3' } });
    const rangeBytes = Buffer.from(await rangeRes.arrayBuffer());
    check('Range → 206 Partial Content', rangeRes.status === 206, `status ${rangeRes.status}`);
    check('Range: ровно 4 байта + Content-Range', rangeBytes.length === 4 && /^bytes 0-3\//.test(rangeRes.headers.get('content-range') || ''), rangeRes.headers.get('content-range'));

    const tampered = rawUrl.replace(/sig=([A-Za-z0-9_-])/, (m, c) => `sig=${c === 'A' ? 'B' : 'A'}`);
    const tamperedRes = await fetch(tampered);
    check('порченая подпись → 403', tamperedRes.status === 403, `status ${tamperedRes.status}`);

    const variantDl = await call('GET', `/files/${fileId}/download?variant=thumb`, t1);
    const variantRes = await fetch(variantDl.json?.data?.url);
    check('download?variant=thumb отдаёт webp', variantRes.status === 200 && (variantRes.headers.get('content-type') || '').includes('image/webp'), `status ${variantRes.status}`);

    // ===== Публичный класс =====
    const pubRes = await fetch(done.json.data.publicUrl);
    check('публичная ссылка без авторизации → 200', pubRes.status === 200, `status ${pubRes.status}`);
    check('публичная ссылка: immutable-кэш', (pubRes.headers.get('cache-control') || '').includes('immutable'), pubRes.headers.get('cache-control'));
    const pubThumb = await fetch(done.json.data.publicUrl + '?variant=thumb');
    check('публичный вариант thumb → 200 webp', pubThumb.status === 200 && (pubThumb.headers.get('content-type') || '').includes('image/webp'));

    // ===== Доступ: приватный файл чужому =====
    const priv = await uploadWhole(t1, { profile: 'chat_attachment', name: 'секрет.png', mime: 'image/png', bytes: PNG_1PX });
    check('приватный файл загружен (chat_attachment)', !!priv.file && priv.file.visibility === 'private');
    const strangerMeta = await call('GET', `/files/${priv.id}`, t2);
    check('чужой: метаданные приватного → 403', strangerMeta.status === 403, `status ${strangerMeta.status}`);
    const strangerDl = await call('GET', `/files/${priv.id}/download`, t2);
    check('чужой: download приватного → 403', strangerDl.status === 403, `status ${strangerDl.status}`);
    const ownMeta = await call('GET', `/files/${priv.id}`, t1);
    check('загрузивший видит свой приватный файл', ownMeta.ok);

    // ===== Гигиена =====
    const exe = await call('POST', '/files', t1, { profile: 'chat_attachment', name: 'virus.exe', mime: 'application/octet-stream', size: 100 });
    check('exe-расширение → 400', exe.status === 400, `status ${exe.status}`);
    const wrongMime = await call('POST', '/files', t1, { profile: 'avatar', name: 'doc.pdf', mime: 'application/pdf', size: 100 });
    check('pdf в профиль avatar → 400 (whitelist)', wrongMime.status === 400, `status ${wrongMime.status}`);
    const tooBig = await call('POST', '/files', t1, { profile: 'avatar', name: 'big.png', mime: 'image/png', size: 6 * 1024 * 1024 });
    check('6МБ в avatar (лимит 5МБ) → 400', tooBig.status === 400, `status ${tooBig.status}`);

    const fake = await call('POST', '/files', t1, { profile: 'document', name: 'отчёт.pdf', mime: 'application/pdf', size: PNG_1PX.length });
    const fakeId = fake.json?.data?.file?.id;
    const fakePut = await upload(`/files/${fakeId}/content`, t1, PNG_1PX, 'отчёт.pdf', 'application/pdf');
    check('magic-bytes: png под видом pdf → 400', fakePut.status === 400, `status ${fakePut.status}`);
    const fakeRow = await prisma.fileObject.findUnique({ where: { id: fakeId } });
    check('файл-обманка помечен failed', fakeRow?.status === 'failed', fakeRow?.status);

    // ===== Квоты =====
    const usage1 = await call('GET', '/files/usage', t1);
    const expectedBytes = PNG_1PX.length * 2; // avatar + приватный (обманка не завершена)
    check('usage: bytesUsed = сумма ready-файлов', usage1.json?.data?.bytesUsed === expectedBytes, `${usage1.json?.data?.bytesUsed} vs ${expectedBytes}`);
    check('usage: filesCount = 2', usage1.json?.data?.filesCount === 2);
    check('usage: лимит отдан', usage1.json?.data?.limitBytes > 0);

    const del = await call('DELETE', `/files/${priv.id}`, t1);
    check('удаление своего файла → ok', del.ok, `status ${del.status}`);
    const usage2 = await call('GET', '/files/usage', t1);
    check('usage уменьшился после удаления', usage2.json?.data?.bytesUsed === PNG_1PX.length && usage2.json?.data?.filesCount === 1, `${usage2.json?.data?.bytesUsed}`);
    const delMeta = await call('GET', `/files/${priv.id}`, t1);
    check('удалённый файл → 404', delMeta.status === 404, `status ${delMeta.status}`);
    const strangerDel = await call('DELETE', `/files/${fileId}`, t2);
    check('чужой не может удалить → 403', strangerDel.status === 403, `status ${strangerDel.status}`);

    // ===== GC-кроны (методы из dist, лок не нужен — зовём свипы напрямую) =====
    if ((process.env.FILES_DRIVER || 'local') === 'local') {
      const { FilesCron } = require('../dist/core/files/files.cron');
      const { LocalStorageDriver } = require('../dist/core/files/storage/local.driver');
      const driver = new LocalStorageDriver();
      const cron = new FilesCron(prisma, { withLock: async (_k, _t, fn) => fn() }, { retryPending: async () => 0 }, { enabled: false, enqueue: () => {} }, driver);

      const staleId = crypto.randomUUID();
      await prisma.fileObject.create({ data: { id: staleId, ownerType: 'user', ownerId: u1, uploaderId: u1, profile: 'generic', kind: 'other', name: 'stale.bin', mime: 'application/octet-stream', size: BigInt(10), status: 'uploading', visibility: 'private', storageDriver: 'local', storageKey: `zz/zz/${staleId}`, createdAt: new Date(Date.now() - 25 * 3600 * 1000) } });
      await cron.sweepStaleUploads();
      const staleRow = await prisma.fileObject.findUnique({ where: { id: staleId } });
      check('GC: брошенная загрузка (25ч) → failed', staleRow?.status === 'failed', staleRow?.status);

      const purgeId = crypto.randomUUID();
      await prisma.fileObject.create({ data: { id: purgeId, ownerType: 'user', ownerId: u1, uploaderId: u1, profile: 'generic', kind: 'other', name: 'old.bin', mime: 'application/octet-stream', size: BigInt(10), status: 'deleted', visibility: 'private', storageDriver: 'local', storageKey: `zz/zz/${purgeId}`, deletedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) } });
      await cron.sweepDeleted();
      const purgedRow = await prisma.fileObject.findUnique({ where: { id: purgeId } });
      check('GC: soft-deleted (8д) удалён физически', purgedRow === null);

      await cron.reconcileQuotas();
      const usage3 = await call('GET', '/files/usage', t1);
      check('GC: сверка квот сходится с фактом', usage3.json?.data?.bytesUsed === PNG_1PX.length && usage3.json?.data?.filesCount === 1, `${usage3.json?.data?.bytesUsed}`);
    } else {
      console.log('…  GC-блок пропущен (FILES_DRIVER=s3)');
    }

    // ===== abort =====
    const ab = await call('POST', '/files', t1, { profile: 'generic', name: 'будет отменён.bin', mime: 'application/octet-stream', size: 100 });
    const abId = ab.json?.data?.file?.id;
    const abRes = await call('POST', `/files/${abId}/abort`, t1);
    check('abort незавершённой загрузки → ok', abRes.ok, `status ${abRes.status}`);
    const abRow = await prisma.fileObject.findUnique({ where: { id: abId } });
    check('abort: статус failed', abRow?.status === 'failed', abRow?.status);
  } finally {
    await prisma.$disconnect();
  }

  console.log(fails === 0 ? '\nALL PASS' : `\nFAILED: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
