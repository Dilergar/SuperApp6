/* eslint-disable */
// P0-регрессия (ревью звонков 2026-07-17): увольнение/выход из организации ДОЛЖНЫ снимать
// участие человека во встречах Виртуального офиса — иначе бывший сотрудник сохраняет доступ
// (чтение И запись) к чату встречи через живой tuple office_room#participant.
// Проверяет синхронный каскад WorkspacesService.removeMember → OfficeService.removeAllParticipationsForUser.
// Run (API up + seeded testers): node scripts/verify-office-fire-revoke.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const { createSuiteWorkspace, archiveSuiteWorkspaces } = require('./_lib.cjs');
// Адрес API переопределяется переменной окружения: два экземпляра на одной машине
// (например, когда :3001 занят чужим дев-сервером) — обычная ситуация при проверке правок.
const BASE = process.env.SA6_API_BASE || 'http://localhost:3001/api';
const P1 = '+77009990001', P2 = '+77009990002', PW = 'Test1234!';

let fails = 0;
const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };
async function call(method, p, token, body) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': require('crypto').randomUUID(), 'X-Locale': process.env.SA6_SUITE_LOCALE || 'ru', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}: ${r.status}`); return r.json.data.accessToken; };

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2);
  const uid = async (p) => (await prisma.user.findUnique({ where: { phone: p }, select: { id: true } })).id;
  const u2 = await uid(P2);
  const cleanup = { wsId: null };
  try {
    // ===== Сетап: организация P1 + найм P2 (Стажёр) =====
    const ws = await createSuiteWorkspace(t1, 'Сьют-Офис-Увольнение', {}, { purge: true });
    if (!ws.ok) throw new Error(`workspace: ${ws.status}`);
    const wsId = ws.json.data.id; cleanup.wsId = wsId;

    const inv = await call('POST', `/workspaces/${wsId}/invitations`, t1, { phone: P2 });
    if (!inv.ok) throw new Error(`invite: ${inv.status}`);
    const incoming = await call('GET', '/workspaces/invitations/incoming', t2);
    const invId = incoming.json.data.find((i) => i.workspaceId === wsId)?.id;
    if (!invId) throw new Error('приглашение не найдено');
    const acc = await call('POST', `/workspaces/invitations/${invId}/accept`, t2);
    check('P2 нанят Стажёром', acc.ok, `status ${acc.status}`);

    // ===== Встреча + приглашение P2 (материализует участие + чат + tuple) =====
    const room = await call('POST', `/workspaces/${wsId}/office/rooms`, t1, { name: 'Планёрка' });
    const roomId = room.json.data.id;
    const invRoom = await call('POST', `/workspaces/${wsId}/office/rooms/${roomId}/invite`, t1, { userIds: [u2] });
    check('P2 приглашён во встречу', invRoom.ok && invRoom.json.data.invited === 1, `invited ${invRoom.json?.data?.invited}`);

    // ===== ДО увольнения: P2 видит чат встречи и может писать =====
    const chatBefore = await call('GET', `/messenger/office-rooms/${roomId}/chat`, t2);
    check('P2 (сотрудник) открывает чат встречи → 200', chatBefore.status === 200, `status ${chatBefore.status}`);
    const chatId = chatBefore.json?.data?.id;
    const postBefore = chatId ? await call('POST', `/messenger/chats/${chatId}/messages`, t2, { content: 'привет команде' }) : { status: 0 };
    check('P2 (сотрудник) пишет в чат встречи → 2xx', postBefore.status === 200 || postBefore.status === 201, `status ${postBefore.status}`);

    const tupBefore = await prisma.relationTuple.count({ where: { resourceType: 'office_room', resourceId: roomId, subjectId: u2 } });
    check('tuple office_room#participant@P2 существует', tupBefore >= 1, `n=${tupBefore}`);

    // ===== УВОЛЬНЕНИЕ =====
    const fire = await call('DELETE', `/workspaces/${wsId}/members/${u2}`, t1);
    check('P2 уволен', fire.ok, `status ${fire.status}`);

    // ===== ПОСЛЕ увольнения: доступ отозван (чтение И запись) =====
    const partAfter = await prisma.officeRoomParticipant.count({ where: { userId: u2, room: { workspaceId: wsId } } });
    check('участие P2 во встречах снято (строк 0)', partAfter === 0, `n=${partAfter}`);

    const tupAfter = await prisma.relationTuple.count({ where: { resourceType: 'office_room', resourceId: roomId, subjectId: u2 } });
    check('tuple office_room@P2 снят (проекция)', tupAfter === 0, `n=${tupAfter}`);

    const chatAfter = await call('GET', `/messenger/office-rooms/${roomId}/chat`, t2);
    check('уволенный НЕ открывает чат встречи → 403', chatAfter.status === 403, `status ${chatAfter.status}`);

    const readAfter = chatId ? await call('GET', `/messenger/chats/${chatId}/messages`, t2) : { status: 0 };
    check('уволенный НЕ читает сообщения чата → 403', readAfter.status === 403, `status ${readAfter.status}`);

    const postAfter = chatId ? await call('POST', `/messenger/chats/${chatId}/messages`, t2, { content: 'я всё ещё тут?' }) : { status: 0 };
    check('уволенный НЕ пишет в чат встречи → 403', postAfter.status === 403, `status ${postAfter.status}`);

    console.log(fails === 0 ? '\n✅ FIRE-REVOKE ПРОЙДЕН' : `\n❌ FIRE-REVOKE: провалов ${fails}`);
  } finally {
    // Уборка штатно: архив + каскад purgeWorkspace (чаты встреч, комнаты, членства, роли,
    // рёбра доступа) — источник правды удаления, а не его копия в сьюте. События
    // уведомлений FK-free, каскад их не удаляет — свои убираем сами.
    if (cleanup.wsId) await prisma.notificationEvent.deleteMany({ where: { workspaceId: cleanup.wsId } }).catch(() => {});
    fails += await archiveSuiteWorkspaces();
    await prisma.$disconnect();
    process.exit(fails === 0 ? 0 : 1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
