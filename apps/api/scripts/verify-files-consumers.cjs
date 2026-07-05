/* eslint-disable */
// Волна потребителей движка файлов — e2e по фазам:
// Ф1: аватарка пользователя + лого организации (upload профилем 'avatar' → publicUrl →
//     PATCH /users/me | /workspaces/:id → отдача без авторизации; негативы).
// Секции Ф2-Ф5 добавляются по мере стройки фаз.
// Run (API up): node scripts/verify-files-consumers.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567', P2 = '+77012345678', P3 = '+77023456789', PW = 'Test1234!';

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
async function uploadBytes(p, token, bytes, filename, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: mime }), filename);
  const res = await fetch(BASE + p, { method: 'PUT', headers: { Authorization: 'Bearer ' + token }, body: fd });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}: ${r.status}`); return r.json.data.accessToken; };

/** Связь в Окружении через реальный invite-flow (идемпотентно) */
async function ensureContact(tokenA, tokenB, phoneB) {
  const contacts = await call('GET', '/contacts', tokenA);
  if ((contacts.json?.data || []).find((c) => c.phone === phoneB)) return;
  const inv = await call('POST', '/contacts/invitations', tokenA, { toPhone: phoneB, proposedRoleForSender: 'Друг', proposedRoleForRecipient: 'Друг' });
  const invId = inv.json?.data?.id;
  const incoming = await call('GET', '/contacts/invitations/incoming', tokenB);
  const toAccept = (incoming.json?.data || []).find((i) => i.id === invId) || (incoming.json?.data || [])[0];
  if (toAccept) await call('POST', `/contacts/invitations/${toAccept.id}/accept`, tokenB, { myRole: 'Друг', theirRole: 'Друг' });
}

/** init → PUT → complete; extra попадает в init-body (напр. ownerWorkspaceId) */
async function uploadWhole(token, { profile, name, mime, bytes, extra }) {
  const init = await call('POST', '/files', token, { profile, name, mime, size: bytes.length, ...(extra || {}) });
  if (!init.ok) return { init };
  const id = init.json.data.file.id;
  const put = await uploadBytes(`/files/${id}/content`, token, bytes, name, mime);
  if (!put.ok) return { init, put, id };
  const done = await call('POST', `/files/${id}/complete`, token, {});
  return { init, put, done, id, file: done.json?.data };
}

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2);

  try {
    // ============ Ф1: аватарка пользователя ============
    console.log('--- Ф1: аватарка + лого ---');
    const up = await uploadWhole(t1, { profile: 'avatar', name: 'ава.png', mime: 'image/png', bytes: PNG_1PX });
    check('Ф1: аватар загружен, publicUrl есть', !!up.file?.publicUrl, up.file?.publicUrl);

    const patch = await call('PATCH', '/users/me', t1, { avatar: up.file.publicUrl });
    check('Ф1: PATCH /users/me {avatar} принят', patch.ok, `status ${patch.status}`);
    const me = await call('GET', '/users/me', t1);
    check('Ф1: GET /users/me вернул наш URL', me.json?.data?.avatar === up.file.publicUrl, me.json?.data?.avatar);

    const pub = await fetch(up.file.publicUrl);
    check('Ф1: аватар отдаётся без авторизации', pub.status === 200 && (pub.headers.get('content-type') || '').includes('image/'), `status ${pub.status}`);

    const badUrl = await call('PATCH', '/users/me', t1, { avatar: 'не-url' });
    check('Ф1: не-URL в avatar → 400', badUrl.status === 400, `status ${badUrl.status}`);

    // сброс
    const clear = await call('PATCH', '/users/me', t1, { avatar: null });
    check('Ф1: avatar=null (удаление) принят', clear.ok, `status ${clear.status}`);

    // ============ Ф1: лого организации ============
    const ws = await call('POST', '/workspaces', t1, { name: `Ф1-Лого ${Date.now()}` });
    check('Ф1: организация создана', ws.ok, `status ${ws.status}`);
    const wsId = ws.json?.data?.id;

    const logo = await uploadWhole(t1, { profile: 'avatar', name: 'лого.png', mime: 'image/png', bytes: PNG_1PX, extra: { ownerWorkspaceId: wsId } });
    check('Ф1: лого загружено во владение организации', logo.file?.ownerType === 'workspace' && logo.file?.ownerId === wsId, `${logo.file?.ownerType}/${logo.file?.ownerId}`);

    const patchWs = await call('PATCH', `/workspaces/${wsId}`, t1, { logo: logo.file.publicUrl });
    check('Ф1: PATCH /workspaces {logo} принят', patchWs.ok, `status ${patchWs.status}`);
    const wsGet = await call('GET', `/workspaces/${wsId}`, t1);
    check('Ф1: GET /workspaces вернул лого', wsGet.json?.data?.logo === logo.file.publicUrl);

    // не-член не может грузить во владение чужой организации
    const alien = await call('POST', '/files', t2, { profile: 'avatar', name: 'x.png', mime: 'image/png', size: PNG_1PX.length, ownerWorkspaceId: wsId });
    check('Ф1: не-член организации → 403 на ownerWorkspaceId', alien.status === 403, `status ${alien.status}`);

    // ============ Ф2: вложения в чат ============
    console.log('--- Ф2: вложения в чат ---');
    const t3 = await login(P3);
    await ensureContact(t1, t2, P2);
    const dm = await call('POST', '/messenger/chats/dm', t1, { userId: (await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } })).id });
    check('Ф2: DM открыт', dm.ok, `status ${dm.status}`);
    const chatId = dm.json?.data?.id;

    const f1 = await uploadWhole(t1, { profile: 'chat_attachment', name: 'фото.png', mime: 'image/png', bytes: PNG_1PX });
    const f2 = await uploadWhole(t1, { profile: 'chat_attachment', name: 'заметка.txt', mime: 'text/plain', bytes: Buffer.from('привет из вложения') });
    check('Ф2: два файла загружены', !!f1.file && !!f2.file);

    const sendA = await call('POST', `/messenger/chats/${chatId}/messages/attachments`, t1, { fileIds: [f1.id, f2.id], caption: 'смотри файлы' });
    check('Ф2: attachment-сообщение отправлено', sendA.ok && sendA.json?.data?.type === 'attachment', `status ${sendA.status}`);
    const msgA = sendA.json?.data;
    check('Ф2: payload.files = 2', msgA?.payload?.files?.length === 2, JSON.stringify(msgA?.payload?.files?.map((x) => x.name)));
    check('Ф2: подпись в content (К-1)', msgA?.content === 'смотри файлы');

    const t2Msgs = await call('GET', `/messenger/chats/${chatId}/messages`, t2);
    const seen = (t2Msgs.json?.data || []).find((m) => m.id === msgA.id);
    check('Ф2: собеседник видит сообщение с payload', !!seen && seen.payload?.files?.length === 2);

    const t2Dl = await call('GET', `/files/${f1.id}/download`, t2);
    check('Ф2: собеседник качает файл через резолвер chat_message', t2Dl.ok && !!t2Dl.json?.data?.url, `status ${t2Dl.status}`);
    const t3Meta = await call('GET', `/files/${f1.id}`, t3);
    check('Ф2: посторонний → 403', t3Meta.status === 403, `status ${t3Meta.status}`);

    const chatsT2 = await call('GET', '/messenger/chats', t2);
    const dmRow = (chatsT2.json?.data || []).find((c) => c.id === chatId);
    check('Ф2: превью у собеседника = подпись', dmRow?.lastMessage?.text === 'смотри файлы', dmRow?.lastMessage?.text);
    check('Ф2: unread у собеседника вырос', (dmRow?.unreadCount ?? 0) >= 1, `unread ${dmRow?.unreadCount}`);

    const edit = await call('PATCH', `/messenger/messages/${msgA.id}`, t1, { content: 'новая подпись' });
    check('Ф2: правка подписи attachment-сообщения', edit.ok && edit.json?.data?.content === 'новая подпись', `status ${edit.status}`);

    // сообщение без подписи → серверное превью 📎
    const noCap = await call('POST', `/messenger/chats/${chatId}/messages/attachments`, t1, { fileIds: [f2.id] });
    check('Ф2: без подписи отправляется', noCap.ok, `status ${noCap.status}`);
    const chatsT2b = await call('GET', '/messenger/chats', t2);
    const dmRowB = (chatsT2b.json?.data || []).find((c) => c.id === chatId);
    check('Ф2: превью 📎 без подписи', (dmRowB?.lastMessage?.text || '').includes('📎'), dmRowB?.lastMessage?.text);

    // чужой файл (загружен t2) в моём сообщении → 400
    const foreign = await uploadWhole(t2, { profile: 'chat_attachment', name: 'чужой.png', mime: 'image/png', bytes: PNG_1PX });
    const stealSend = await call('POST', `/messenger/chats/${chatId}/messages/attachments`, t1, { fileIds: [foreign.id] });
    check('Ф2: чужой fileId → 400', stealSend.status === 400, `status ${stealSend.status}`);

    // 11 файлов → 400 (лимит альбома)
    const eleven = await call('POST', `/messenger/chats/${chatId}/messages/attachments`, t1, { fileIds: Array.from({ length: 11 }, () => f1.id) });
    check('Ф2: 11 файлов → 400', eleven.status === 400, `status ${eleven.status}`);

    // удаление: файл с ДВУМЯ связями живёт, последняя связь → файл deleted
    const shared = await uploadWhole(t1, { profile: 'chat_attachment', name: 'общий.png', mime: 'image/png', bytes: PNG_1PX });
    const msgX = (await call('POST', `/messenger/chats/${chatId}/messages/attachments`, t1, { fileIds: [shared.id] })).json?.data;
    const msgY = (await call('POST', `/messenger/chats/${chatId}/messages/attachments`, t1, { fileIds: [shared.id] })).json?.data;
    await call('DELETE', `/messenger/messages/${msgX.id}`, t1);
    let sharedRow = await prisma.fileObject.findUnique({ where: { id: shared.id } });
    check('Ф2: файл с оставшейся связью жив после удаления 1-го сообщения', sharedRow?.status === 'ready', sharedRow?.status);
    await call('DELETE', `/messenger/messages/${msgY.id}`, t1);
    sharedRow = await prisma.fileObject.findUnique({ where: { id: shared.id } });
    const sharedLinks = await prisma.fileLink.count({ where: { fileId: shared.id } });
    check('Ф2: последняя связь снята → файл deleted, связей 0', sharedRow?.status === 'deleted' && sharedLinks === 0, `${sharedRow?.status}/${sharedLinks}`);

    // ============ Ф3: фото лотов магазина ============
    console.log('--- Ф3: фото лотов ---');
    const u2 = (await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } })).id;
    // валюта t2 (покупатель платит своей — эмитирует и минтит себе)
    let cur2 = (await call('GET', '/wallet/currency', t2)).json?.data;
    if (!cur2) cur2 = (await call('POST', '/wallet/currency', t2, { name: 'Ф3-коин', icon: '🥝' })).json?.data;
    await call('POST', '/wallet/currency/mint', t2, { amount: 1000 });

    await call('GET', '/shop', t1); // ленивое создание магазина
    const sc = await call('POST', '/shop/showcases', t1, { name: `Ф3 витрина ${Date.now()}` });
    const showcaseId = sc.json?.data?.id;
    const lot = await call('POST', '/shop/listings', t1, { showcaseId, title: 'Лот с фото', prices: [{ currencyId: cur2.id, amount: 10 }] });
    check('Ф3: лот создан', lot.ok, `status ${lot.status} ${JSON.stringify(lot.json)?.slice(0, 120)}`);
    const listingId = lot.json?.data?.id;

    const p1 = await uploadWhole(t1, { profile: 'listing_image', name: 'фото1.png', mime: 'image/png', bytes: PNG_1PX });
    const p2 = await uploadWhole(t1, { profile: 'listing_image', name: 'фото2.png', mime: 'image/png', bytes: PNG_1PX });
    const att1 = await call('POST', `/shop/listings/${listingId}/images`, t1, { fileId: p1.id });
    const att2 = await call('POST', `/shop/listings/${listingId}/images`, t1, { fileId: p2.id });
    check('Ф3: два фото прикреплены', att1.ok && att2.ok && att2.json?.data?.length === 2, `len ${att2.json?.data?.length}`);

    const listings = await call('GET', `/shop/showcases/${showcaseId}/listings`, t1);
    const lotRow = (listings.json?.data || []).find((l) => l.id === listingId);
    check('Ф3: coverUrl = первое фото', !!lotRow?.coverUrl && lotRow.coverUrl.startsWith(p1.file.publicUrl), lotRow?.coverUrl);

    // не-профильный файл → 400
    const wrongProfile = await uploadWhole(t1, { profile: 'chat_attachment', name: 'x.png', mime: 'image/png', bytes: PNG_1PX });
    const wrongAtt = await call('POST', `/shop/listings/${listingId}/images`, t1, { fileId: wrongProfile.id });
    check('Ф3: файл не-listing_image профиля → 400', wrongAtt.status === 400, `status ${wrongAtt.status}`);

    // чужой без manage → 403
    const alienImg = await uploadWhole(t2, { profile: 'listing_image', name: 'a.png', mime: 'image/png', bytes: PNG_1PX });
    const alienAtt = await call('POST', `/shop/listings/${listingId}/images`, t2, { fileId: alienImg.id });
    check('Ф3: чужой attach → 403', alienAtt.status === 403, `status ${alienAtt.status}`);

    // лимит 10: догружаем до 10, 11-е → 400
    for (let i = 3; i <= 10; i++) {
      const px = await uploadWhole(t1, { profile: 'listing_image', name: `ф${i}.png`, mime: 'image/png', bytes: PNG_1PX });
      await call('POST', `/shop/listings/${listingId}/images`, t1, { fileId: px.id });
    }
    const eleventh = await uploadWhole(t1, { profile: 'listing_image', name: 'ф11.png', mime: 'image/png', bytes: PNG_1PX });
    const overAtt = await call('POST', `/shop/listings/${listingId}/images`, t1, { fileId: eleventh.id });
    check('Ф3: 11-е фото → 400', overAtt.status === 400, `status ${overAtt.status}`);

    // удаление первого → обложка сдвигается на второе фото
    const del1 = await call('DELETE', `/shop/listings/${listingId}/images/${p1.id}`, t1);
    check('Ф3: удаление фото ок', del1.ok, `status ${del1.status}`);
    const listings2 = await call('GET', `/shop/showcases/${showcaseId}/listings`, t1);
    const lotRow2 = (listings2.json?.data || []).find((l) => l.id === listingId);
    check('Ф3: cover сдвинулся на второе фото', !!lotRow2?.coverUrl && lotRow2.coverUrl.startsWith(p2.file.publicUrl), lotRow2?.coverUrl);
    const p1Row = await prisma.fileObject.findUnique({ where: { id: p1.id } });
    check('Ф3: осиротевшее фото soft-deleted (К-5)', p1Row?.status === 'deleted', p1Row?.status);

    // rich-card лота несёт imageUrl
    const card = await call('GET', `/rich-cards/listing/${listingId}`, t1);
    check('Ф3: rich-card с imageUrl', !!card.json?.data?.imageUrl, card.json?.data?.imageUrl);

    // заказ: t2 видит живую обложку
    await call('POST', `/shop/showcases/${showcaseId}/shares`, t1, { principalType: 'user', principalId: u2 });
    const buy = await call('POST', `/shop/listings/${listingId}/buy`, t2);
    check('Ф3: покупка прошла', buy.ok, `status ${buy.status} ${JSON.stringify(buy.json)?.slice(0, 120)}`);
    const myOrders = await call('GET', '/shop/orders', t2);
    const orderRow = (myOrders.json?.data || []).find((o) => o.listingId === listingId);
    check('Ф3: заказ несёт listingCoverUrl', !!orderRow?.listingCoverUrl, orderRow?.listingCoverUrl);

    // Уборка Ф3 (иначе точные ассерты видимости verify-shop ловят нашу витрину):
    // отменить заказ → удалить лот → удалить витрину (шеринг уходит вместе с ней)
    if (orderRow) await call('POST', `/shop/orders/${orderRow.id}/cancel`, t2);
    await call('DELETE', `/shop/listings/${listingId}`, t1);
    await call('DELETE', `/shop/showcases/${showcaseId}`, t1);

    // ============ Ф4: вложения задач ============
    console.log('--- Ф4: вложения задач ---');
    // создание с вложением «с порога»: t1 ставит задачу t2, прикладывает файл
    const taskFile = await uploadWhole(t1, { profile: 'chat_attachment', name: 'ТЗ.txt', mime: 'text/plain', bytes: Buffer.from('техзадание') });
    const createTask = await call('POST', '/tasks', t1, { title: 'Задача с файлом', executorId: u2, attachmentFileIds: [taskFile.id] });
    check('Ф4: задача создана с вложением', createTask.ok, `status ${createTask.status} ${JSON.stringify(createTask.json)?.slice(0, 120)}`);
    const taskId = createTask.json?.data?.id;

    const t2Att = await call('GET', `/tasks/${taskId}/attachments`, t2);
    check('Ф4: исполнитель видит вложение', t2Att.ok && t2Att.json?.data?.length === 1, `len ${t2Att.json?.data?.length}`);
    const t2Dl2 = await call('GET', `/files/${taskFile.id}/download`, t2);
    check('Ф4: исполнитель качает файл задачи', t2Dl2.ok && !!t2Dl2.json?.data?.url, `status ${t2Dl2.status}`);

    const t3Att = await call('GET', `/tasks/${taskId}/attachments`, t3);
    check('Ф4: посторонний → 403 на вложения', t3Att.status === 403, `status ${t3Att.status}`);

    // участник (исполнитель) может прикрепить своё
    const t2File = await uploadWhole(t2, { profile: 'chat_attachment', name: 'результат.png', mime: 'image/png', bytes: PNG_1PX });
    const t2Attach = await call('POST', `/tasks/${taskId}/attachments`, t2, { fileId: t2File.id });
    check('Ф4: исполнитель прикрепляет свой файл', t2Attach.ok && t2Attach.json?.data?.length === 2, `len ${t2Attach.json?.data?.length}`);

    // посторонний не может прикрепить
    const t3File = await uploadWhole(t3, { profile: 'chat_attachment', name: 'x.png', mime: 'image/png', bytes: PNG_1PX });
    const t3Attach = await call('POST', `/tasks/${taskId}/attachments`, t3, { fileId: t3File.id });
    check('Ф4: посторонний attach → 403', t3Attach.status === 403, `status ${t3Attach.status}`);

    // удаление вложения → осиротевший файл soft-deleted
    const rem = await call('DELETE', `/tasks/${taskId}/attachments/${taskFile.id}`, t1);
    check('Ф4: удаление вложения ок', rem.ok, `status ${rem.status}`);
    const taskFileRow = await prisma.fileObject.findUnique({ where: { id: taskFile.id } });
    check('Ф4: осиротевшее вложение soft-deleted (К-5)', taskFileRow?.status === 'deleted', taskFileRow?.status);
  } finally {
    await prisma.$disconnect();
  }

  console.log(fails === 0 ? '\nALL PASS' : `\nFAILED: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
