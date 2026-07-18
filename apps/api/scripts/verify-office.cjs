/* eslint-disable */
// «Виртуальный офис» (B2B, потребитель core/calls) — e2e: гейты команды (чужак/Подрядчик 403),
// создание встречи, приглашения (+уведомление, чужак отсеян), контекстный чат (roleTag
// Организатор/Участник, 403 постороннему), токены LiveKit (payload, roomAdmin у host,
// get-or-create сессии), onJoinAuthorized-материализация участника, вебхук-симуляция
// (идемпотентность joined/room_finished; встреча живёт после конца созвона; новый вход =
// новая сессия), завершение встречи (права, идемпотентность, плашка), rich card.
// LiveKit-сервер НЕ нужен: токены и подпись вебхука — локальные (env-ключи обязательны,
// без них calls-часть SKIP). Run (API up + seeded testers): node scripts/verify-office.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567', P2 = '+77012345678', P3 = '+77023456789', PW = 'Test1234!';

let fails = 0;
const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };
async function call(method, p, token, body) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}: ${r.status}`); return r.json.data.accessToken; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jwtPayload = (t) => JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

async function postWebhook(rawBody, jwt) {
  const res = await fetch(`${BASE}/calls/livekit/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/webhook+json', Authorization: jwt },
    body: rawBody,
  });
  return res.status;
}
async function signedWebhook(evt) {
  const { AccessToken } = require('livekit-server-sdk');
  const body = JSON.stringify(evt);
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { ttl: 600 });
  at.sha256 = crypto.createHash('sha256').update(body).digest('base64');
  return postWebhook(body, await at.toJwt());
}

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2), t3 = await login(P3);
  const uid = async (p) => (await prisma.user.findUnique({ where: { phone: p }, select: { id: true } })).id;
  const u1 = await uid(P1), u2 = await uid(P2), u3 = await uid(P3);

  const cleanup = { wsId: null };
  try {
    // ===== Сетап: организация P1 =====
    const ws = await call('POST', '/workspaces', t1, { name: 'office-e2e' });
    if (!ws.ok) throw new Error(`workspace: ${ws.status}`);
    const wsId = ws.json.data.id; cleanup.wsId = wsId;
    const O = (p) => `/workspaces/${wsId}/office${p}`;

    // ===== Гейты: чужак и Подрядчик =====
    const alien = await call('GET', O(''), t3);
    check('чужак: список встреч → 403', alien.status === 403, `status ${alien.status}`);

    const contractorRole = await prisma.userRole.create({
      data: { userId: u3, role: 'contractor', context: 'workspace', tenantId: wsId, isActive: true },
    });
    const contr = await call('GET', O(''), t3);
    check('Подрядчик изолирован → 403', contr.status === 403, `status ${contr.status}`);
    await prisma.userRole.delete({ where: { id: contractorRole.id } });

    // ===== Создание встречи =====
    const room = await call('POST', O('/rooms'), t1, { name: 'Планёрка' });
    check('встреча создана', room.ok, `status ${room.status}`);
    const roomId = room.json?.data?.id;
    check('создатель = host', room.json?.data?.myRole === 'host', `myRole=${room.json?.data?.myRole}`);

    const unnamed = await call('POST', O('/rooms'), t1, {});
    check('встреча без имени → «Встреча ДД.ММ ЧЧ:ММ»', /^Встреча \d{2}\.\d{2} \d{2}:\d{2}$/.test(unnamed.json?.data?.name ?? ''), unnamed.json?.data?.name);

    const list1 = await call('GET', O(''), t1);
    check('список встреч у создателя', list1.ok && (list1.json?.data ?? []).length >= 2, `n=${(list1.json?.data ?? []).length}`);

    // ===== Наём P2 (Стажёр) =====
    const inv2 = await call('POST', `/workspaces/${wsId}/invitations`, t1, { phone: P2 });
    const myInv2 = (await call('GET', '/workspaces/invitations/incoming', t2)).json?.data?.find((i) => i.workspaceId === wsId);
    const acc2 = await call('POST', `/workspaces/invitations/${myInv2?.id}/accept`, t2);
    if (!inv2.ok || !acc2.ok) throw new Error(`hire P2: ${inv2.status}/${acc2.status}`);

    const list2 = await call('GET', O(''), t2);
    check('Стажёр видит список встреч', list2.ok, `status ${list2.status}`);
    const roomForP2 = (list2.json?.data ?? []).find((r) => r.id === roomId);
    check('Стажёр ещё НЕ участник встречи (myRole=null)', roomForP2 && roomForP2.myRole === null, `myRole=${roomForP2?.myRole}`);

    // ===== Приглашение =====
    const invite = await call('POST', O(`/rooms/${roomId}/invite`), t1, { userIds: [u2] });
    check('приглашение P2 → invited 1', invite.ok && invite.json?.data?.invited === 1, JSON.stringify(invite.json?.data));
    const part2 = await prisma.officeRoomParticipant.findUnique({ where: { roomId_userId: { roomId, userId: u2 } } });
    check('P2 стал участником (role=participant)', part2?.role === 'participant', `role=${part2?.role}`);
    const notif = await prisma.notification.findFirst({
      where: { userId: u2, type: 'office.meeting.invited' },
      orderBy: { createdAt: 'desc' },
    });
    check('уведомление office.meeting.invited у P2', !!notif, notif ? '' : 'нет строки');
    check('actionUrl ведёт на встречу', (notif?.actionUrl ?? '').includes(`/office/${roomId}`), notif?.actionUrl ?? '');

    const inviteAlien = await call('POST', O(`/rooms/${roomId}/invite`), t1, { userIds: [u3] });
    check('приглашение НЕ-члена ws → invited 0 (молча отсеян)', inviteAlien.ok && inviteAlien.json?.data?.invited === 0, JSON.stringify(inviteAlien.json?.data));

    // ===== Контекстный чат встречи =====
    const chat2 = await call('GET', `/messenger/office-rooms/${roomId}/chat`, t2);
    check('участник открывает чат встречи', chat2.ok, `status ${chat2.status}`);
    const chatId = chat2.json?.data?.id;
    const tags = new Map((chat2.json?.data?.participants ?? []).map((p) => [p.userId, p.roleTag]));
    check('roleTag host = «Организатор»', tags.get(u1) === 'Организатор', `=${tags.get(u1)}`);
    check('roleTag участника = «Участник»', tags.get(u2) === 'Участник', `=${tags.get(u2)}`);

    const msg = await call('POST', `/messenger/chats/${chatId}/messages`, t2, { content: 'Привет со встречи!' });
    check('сообщение в чат встречи', msg.ok, `status ${msg.status}`);
    const chatAlien = await call('GET', `/messenger/office-rooms/${roomId}/chat`, t3);
    check('чужак: чат встречи → 403', chatAlien.status === 403, `status ${chatAlien.status}`);

    await sleep(900); // плашка office.room.created идёт через шину
    const msgs1 = await call('GET', `/messenger/chats/${chatId}/messages`, t1);
    const hasCreatedPlaque = (msgs1.json?.data ?? []).some(
      (m) => m.type === 'system' && String(m.payload?.text ?? '').includes('создал'),
    );
    check('плашка «создал(а) встречу» в чате', hasCreatedPlaque, '');

    // ===== Движок звонков =====
    const status = await call('GET', '/calls/status', t1);
    const enabled = !!status.json?.data?.enabled;
    if (!enabled) {
      console.log('\nLIVEKIT_* не заданы — calls-часть SKIP.');
    } else {
      const tokAlien = await call('POST', '/calls/token', t3, { refType: 'office_room', refId: roomId });
      check('чужак: токен → 403', tokAlien.status === 403, `status ${tokAlien.status}`);

      const tok2 = await call('POST', '/calls/token', t2, { refType: 'office_room', refId: roomId });
      check('участник получает токен', tok2.ok, `status ${tok2.status}`);
      const sessionId = tok2.json?.data?.sessionId;
      const roomName = tok2.json?.data?.roomName;
      const grant2 = jwtPayload(tok2.json?.data?.token ?? '..').video ?? {};
      check('grant: room = roomName сессии', grant2.room === roomName, `${grant2.room} vs ${roomName}`);
      check('Стажёр НЕ roomAdmin', grant2.roomAdmin !== true, `roomAdmin=${grant2.roomAdmin}`);

      const tok1 = await call('POST', '/calls/token', t1, { refType: 'office_room', refId: roomId });
      const grant1 = jwtPayload(tok1.json?.data?.token ?? '..').video ?? {};
      check('host = roomAdmin (модератор)', grant1.roomAdmin === true, `roomAdmin=${grant1.roomAdmin}`);
      check('get-or-create: та же сессия', tok1.json?.data?.sessionId === sessionId, `${tok1.json?.data?.sessionId} vs ${sessionId}`);

      const sess = await prisma.callSession.findUnique({ where: { id: sessionId } });
      check('CallSession active c контекстом', sess?.status === 'active' && sess?.refType === 'office_room' && sess?.refId === roomId && sess?.workspaceId === wsId, JSON.stringify({ status: sess?.status, refType: sess?.refType }));

      // --- onJoinAuthorized: первый вход делает участником ---
      const inv3 = await call('POST', `/workspaces/${wsId}/invitations`, t1, { phone: P3 });
      const myInv3 = (await call('GET', '/workspaces/invitations/incoming', t3)).json?.data?.find((i) => i.workspaceId === wsId);
      const acc3 = await call('POST', `/workspaces/invitations/${myInv3?.id}/accept`, t3);
      if (!inv3.ok || !acc3.ok) throw new Error(`hire P3: ${inv3.status}/${acc3.status}`);
      const tok3 = await call('POST', '/calls/token', t3, { refType: 'office_room', refId: roomId });
      check('новый сотрудник входит по ссылке (canJoin=команда)', tok3.ok, `status ${tok3.status}`);
      const part3 = await prisma.officeRoomParticipant.findUnique({ where: { roomId_userId: { roomId, userId: u3 } } });
      check('первый вход материализовал участника', part3?.role === 'participant', `role=${part3?.role}`);
      const chat3 = await call('GET', `/messenger/office-rooms/${roomId}/chat`, t3);
      check('вошедший получил доступ к чату встречи', chat3.ok, `status ${chat3.status}`);

      // --- Вебхуки: журнал участий (at-least-once) ---
      const whJoin = await signedWebhook({ event: 'participant_joined', id: 'evt1', room: { name: roomName }, participant: { identity: u2 } });
      const whJoinDup = await signedWebhook({ event: 'participant_joined', id: 'evt1', room: { name: roomName }, participant: { identity: u2 } });
      check('participant_joined принят + повтор 200', whJoin === 200 && whJoinDup === 200, `${whJoin}/${whJoinDup}`);
      const openRows = await prisma.callSessionParticipant.count({ where: { sessionId, userId: u2, leftAt: null } });
      check('повторная доставка НЕ задвоила участие', openRows === 1, `=${openRows}`);

      const listLive = await call('GET', O(''), t1);
      const liveRoom = (listLive.json?.data ?? []).find((r) => r.id === roomId);
      check('список показывает «идёт сейчас» (1 в звонке)', liveRoom?.live?.participantCount === 1, `=${liveRoom?.live?.participantCount}`);

      await signedWebhook({ event: 'participant_left', id: 'evt2', room: { name: roomName }, participant: { identity: u2 } });
      const closedRow = await prisma.callSessionParticipant.findFirst({ where: { sessionId, userId: u2 }, orderBy: { joinedAt: 'desc' } });
      check('participant_left закрыл участие', !!closedRow?.leftAt, '');

      // --- room_finished: созвон умер, ВСТРЕЧА живёт ---
      const whFin = await signedWebhook({ event: 'room_finished', id: 'evt3', room: { name: roomName } });
      const whFinDup = await signedWebhook({ event: 'room_finished', id: 'evt3', room: { name: roomName } });
      check('room_finished принят + повтор 200 (идемпотентно)', whFin === 200 && whFinDup === 200, `${whFin}/${whFinDup}`);
      const sessAfter = await prisma.callSession.findUnique({ where: { id: sessionId } });
      check('сессия закрыта', sessAfter?.status === 'ended' && !!sessAfter?.endedAt, `status=${sessAfter?.status}`);
      const roomAfter = await call('GET', O(`/rooms/${roomId}`), t1);
      check('встреча ЖИВА после конца созвона (ссылка Meet)', roomAfter.json?.data?.status === 'active', `status=${roomAfter.json?.data?.status}`);

      const tokAgain = await call('POST', '/calls/token', t1, { refType: 'office_room', refId: roomId });
      check('новый вход = НОВАЯ сессия', tokAgain.ok && tokAgain.json?.data?.sessionId !== sessionId, `${tokAgain.json?.data?.sessionId}`);
    }

    // ===== Завершение встречи =====
    const endByTrainee = await call('POST', O(`/rooms/${roomId}/end`), t2);
    check('Стажёр (не host): завершить → 403', endByTrainee.status === 403, `status ${endByTrainee.status}`);
    const endByHost = await call('POST', O(`/rooms/${roomId}/end`), t1);
    check('host завершает встречу', endByHost.ok, `status ${endByHost.status}`);
    const endedRoom = await call('GET', O(`/rooms/${roomId}`), t1);
    check('встреча завершена', endedRoom.json?.data?.status === 'ended', `status=${endedRoom.json?.data?.status}`);
    const endAgain = await call('POST', O(`/rooms/${roomId}/end`), t1);
    check('повторное завершение идемпотентно (200)', endAgain.ok, `status ${endAgain.status}`);

    if (enabledSafe(status)) {
      const tokEnded = await call('POST', '/calls/token', t2, { refType: 'office_room', refId: roomId });
      check('в завершённую встречу не войти → 403', tokEnded.status === 403, `status ${tokEnded.status}`);
    }

    await sleep(900);
    const msgsEnd = await call('GET', `/messenger/chats/${chatId}/messages`, t1);
    const hasEndPlaque = (msgsEnd.json?.data ?? []).some(
      (m) => m.type === 'system' && String(m.payload?.text ?? '').includes('Встреча завершена'),
    );
    check('плашка «Встреча завершена» в чате (чат живёт)', hasEndPlaque, '');

    // ===== История завершённых встреч =====
    const hist = await call('GET', O('/history'), t2);
    check('история: завершённая встреча в списке', hist.ok && (hist.json?.data?.items ?? []).some((r) => r.id === roomId), `n=${(hist.json?.data?.items ?? []).length}`);
    const histRow = (hist.json?.data?.items ?? []).find((r) => r.id === roomId);
    check('история: endedAt заполнен', !!histRow?.endedAt, String(histRow?.endedAt));
    check('история: nextCursor null (мало встреч)', hist.json?.data?.nextCursor === null, String(hist.json?.data?.nextCursor));
    const histAlien = await call('GET', O('/history'), t3);
    check('история видна команде (нанятый P3)', histAlien.ok, `status ${histAlien.status}`);
    const chatAfterEnd = await call('GET', `/messenger/office-rooms/${roomId}/chat`, t2);
    check('чат встречи живёт после завершения (участник)', chatAfterEnd.ok, `status ${chatAfterEnd.status}`);

    // ===== Rich card =====
    const card = await call('GET', `/rich-cards/office_room/${roomId}`, t2);
    check('rich card встречи рендерится', card.ok && card.json?.data?.title === 'Планёрка', JSON.stringify(card.json?.data?.title));
    check('карточка: статус «Завершена» + href на встречу', card.json?.data?.status === 'Завершена' && (card.json?.data?.href ?? '').includes(`/office/${roomId}`), `${card.json?.data?.status} ${card.json?.data?.href}`);
  } finally {
    if (cleanup.wsId) {
      const roomIds = (await prisma.officeRoom.findMany({ where: { workspaceId: cleanup.wsId }, select: { id: true } })).map((r) => r.id);
      await prisma.callSession.deleteMany({ where: { refType: 'office_room', refId: { in: roomIds } } }).catch(() => {});
      await prisma.chat.deleteMany({ where: { parentType: 'office_room', parentId: { in: roomIds } } }).catch(() => {});
      await prisma.relationTuple.deleteMany({ where: { resourceType: 'office_room', resourceId: { in: roomIds } } }).catch(() => {});
      await prisma.officeRoom.deleteMany({ where: { workspaceId: cleanup.wsId } }).catch(() => {});
      await prisma.workspaceInvitation.deleteMany({ where: { workspaceId: cleanup.wsId } }).catch(() => {});
      await call('DELETE', `/workspaces/${cleanup.wsId}`, t1).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ OFFICE («ВИРТУАЛЬНЫЙ ОФИС») ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
function enabledSafe(status) { return !!status?.json?.data?.enabled; }
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
