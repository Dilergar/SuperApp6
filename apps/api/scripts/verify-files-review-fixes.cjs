/* eslint-disable */
// Ревью-фиксы движка файлов (июль 2026): жизненный цикл сирот + утечки квоты.
//  1) complete отвергает пустой (0 байт) файл.
//  2) reap заменённого аватара: смена аватара soft-delete'ит прежний публичный файл.
//  3) удаление задачи отвязывает и прибирает её вложения.
//  4) DELETE вложения с непривязанным fileId НЕ удаляет непричастный файл.
//  5) удаление лота отвязывает и прибирает фото галереи.
// Run (API up, FILES_DRIVER=local): node scripts/verify-files-review-fixes.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
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
async function uploadBytes(id, token, bytes, filename, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: mime }), filename);
  const res = await fetch(`${BASE}/files/${id}/content`, { method: 'PUT', headers: { Authorization: 'Bearer ' + token }, body: fd });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}: ${r.status}`); return r.json.data.accessToken; };
async function uploadWhole(token, { profile, name, mime, bytes }) {
  const init = await call('POST', '/files', token, { profile, name, mime, size: bytes.length });
  if (!init.ok) return { init };
  const id = init.json.data.file.id;
  const put = await uploadBytes(id, token, bytes, name, mime);
  if (!put.ok) return { init, put, id };
  const done = await call('POST', `/files/${id}/complete`, token, {});
  return { init, put, done, id, file: done.json?.data };
}
const tokenOf = (url) => { const m = /\/public-files\/([^/?#]+)/.exec(url || ''); return m ? m[1] : null; };

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2);
  try {
    // ============ 1) Пустой файл отвергается на complete ============
    console.log('--- 1) пустой файл ---');
    const initEmpty = await call('POST', '/files', t1, { profile: 'chat_attachment', name: 'пусто.txt', mime: 'text/plain', size: 1 });
    const emptyId = initEmpty.json?.data?.file?.id;
    await uploadBytes(emptyId, t1, Buffer.alloc(0), 'пусто.txt', 'text/plain');
    const emptyDone = await call('POST', `/files/${emptyId}/complete`, t1, {});
    check('1: complete пустого файла → 400', emptyDone.status === 400, `status ${emptyDone.status}`);
    const emptyRow = await prisma.fileObject.findUnique({ where: { id: emptyId } });
    check('1: пустой файл не ready', emptyRow?.status !== 'ready', emptyRow?.status);

    // ============ 2) Reap заменённого аватара ============
    console.log('--- 2) reap заменённого аватара ---');
    const av1 = await uploadWhole(t1, { profile: 'avatar', name: 'а1.png', mime: 'image/png', bytes: PNG_1PX });
    await call('PATCH', '/users/me', t1, { avatar: av1.file.publicUrl });
    const av2 = await uploadWhole(t1, { profile: 'avatar', name: 'а2.png', mime: 'image/png', bytes: PNG_1PX });
    const patch2 = await call('PATCH', '/users/me', t1, { avatar: av2.file.publicUrl });
    check('2: смена аватара принята', patch2.ok, `status ${patch2.status}`);
    const oldAvatar = await prisma.fileObject.findUnique({ where: { publicToken: tokenOf(av1.file.publicUrl) } });
    check('2: ПРЕЖНИЙ аватар soft-deleted', oldAvatar?.status === 'deleted', oldAvatar?.status);
    const newAvatar = await prisma.fileObject.findUnique({ where: { publicToken: tokenOf(av2.file.publicUrl) } });
    check('2: НОВЫЙ аватар жив (ready)', newAvatar?.status === 'ready', newAvatar?.status);
    // тот же URL повторно — не трогаем файл
    await call('PATCH', '/users/me', t1, { avatar: av2.file.publicUrl });
    const sameAvatar = await prisma.fileObject.findUnique({ where: { publicToken: tokenOf(av2.file.publicUrl) } });
    check('2: повторное сохранение того же URL — файл жив', sameAvatar?.status === 'ready', sameAvatar?.status);

    // ============ 3) Удаление задачи прибирает вложения ============
    console.log('--- 3) удаление задачи ---');
    const tf = await uploadWhole(t1, { profile: 'chat_attachment', name: 'вложение.png', mime: 'image/png', bytes: PNG_1PX });
    const task = await call('POST', '/tasks', t1, { title: 'Задача на удаление', attachmentFileIds: [tf.id] });
    check('3: задача с вложением создана', task.ok, `status ${task.status}`);
    const taskId = task.json?.data?.id;
    const linkedBefore = await prisma.fileLink.count({ where: { refType: 'task', refId: taskId } });
    check('3: связь вложения существует', linkedBefore === 1, `links ${linkedBefore}`);
    const delTask = await call('DELETE', `/tasks/${taskId}`, t1);
    check('3: задача удалена', delTask.ok, `status ${delTask.status}`);
    const tfRow = await prisma.fileObject.findUnique({ where: { id: tf.id } });
    check('3: вложение удалённой задачи soft-deleted', tfRow?.status === 'deleted', tfRow?.status);
    const linkedAfter = await prisma.fileLink.count({ where: { refType: 'task', refId: taskId } });
    check('3: связи вложения сняты', linkedAfter === 0, `links ${linkedAfter}`);

    // ============ 4) DELETE вложения с непривязанным fileId не убивает файл ============
    console.log('--- 4) непривязанный fileId ---');
    const orphanish = await uploadWhole(t1, { profile: 'chat_attachment', name: 'сам-по-себе.png', mime: 'image/png', bytes: PNG_1PX });
    const task2 = await call('POST', '/tasks', t1, { title: 'Пустая задача' });
    const task2Id = task2.json?.data?.id;
    // файл orphanish НЕ привязан к task2 — удаление его «вложения» не должно его тронуть
    await call('DELETE', `/tasks/${task2Id}/attachments/${orphanish.id}`, t1);
    const orphanRow = await prisma.fileObject.findUnique({ where: { id: orphanish.id } });
    check('4: непривязанный файл НЕ удалён', orphanRow?.status === 'ready', orphanRow?.status);
    await call('DELETE', `/tasks/${task2Id}`, t1);

    // ============ 5) Удаление лота прибирает фото галереи ============
    console.log('--- 5) удаление лота ---');
    let cur = (await call('GET', '/wallet/currency', t1)).json?.data;
    if (!cur) cur = (await call('POST', '/wallet/currency', t1, { name: 'Ревью-коин', icon: '🔧' })).json?.data;
    await call('GET', '/shop', t1); // ленивое создание магазина
    const sc = await call('POST', '/shop/showcases', t1, { name: `Ревью витрина ${Date.now()}` });
    const showcaseId = sc.json?.data?.id;
    const lot = await call('POST', '/shop/listings', t1, { showcaseId, title: 'Лот на удаление', prices: [{ currencyId: cur.id, amount: 5 }] });
    check('5: лот создан', lot.ok, `status ${lot.status}`);
    const listingId = lot.json?.data?.id;
    const photo = await uploadWhole(t1, { profile: 'listing_image', name: 'товар.png', mime: 'image/png', bytes: PNG_1PX });
    const att = await call('POST', `/shop/listings/${listingId}/images`, t1, { fileId: photo.id });
    check('5: фото прикреплено', att.ok, `status ${att.status}`);
    const delLot = await call('DELETE', `/shop/listings/${listingId}`, t1);
    check('5: лот удалён', delLot.ok, `status ${delLot.status}`);
    const photoRow = await prisma.fileObject.findUnique({ where: { id: photo.id } });
    check('5: фото удалённого лота soft-deleted', photoRow?.status === 'deleted', photoRow?.status);
    const galleryLinks = await prisma.fileLink.count({ where: { refType: 'listing', refId: listingId } });
    check('5: связи галереи сняты', galleryLinks === 0, `links ${galleryLinks}`);

    console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
  } finally {
    await prisma.$disconnect();
  }
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
