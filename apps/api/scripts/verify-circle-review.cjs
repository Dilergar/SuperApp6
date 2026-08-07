/* eslint-disable */
// Ревью Circle 2026-07-30 — регрессии на ВСЕ закрытые находки.
//
// Красная зона:
//   1. Группа без своей настройки видимости наследует дефолт ВЛАДЕЛЬЦА,
//      а не платформенный (добавление в свежую группу больше не раскрывает поля).
//   2. Бронь ресурсов: bookerUserIds гейтится окружением, bookerCircleIds — владением.
//   3. Задача на Группу проходит гейт достижимости (контекст организации).
//   5. blockUser идемпотентен и ВСЕГДА дочищает связь (повторный блок — не no-op).
//   6. Разрыв связи снимает личные гранты календаря / витрин / вишлиста / книг.
//   7. Удаление группы снимает и рёбра, где группа — ПОЛУЧАТЕЛЬ гранта.
//   8. Принятие приглашения проецирует членство в движок доступа сразу,
//      а autoAddToCircleIds отправителя наконец применяется.
//   4. Регистрация ставит активацию приглашений джобом (переживает блип).
// Жёлтая зона: встречные приглашения, гонка лимитов, курсор входящих,
//   история+resend, «Контакт удалён» не актору, маска телефона, блок гасит
//   внешнее приглашение, мерж видимости профиля, personalOnly для личных книг.
//
// Аккаунты — ТОЛЬКО сьюта (+7700999000x). Скрипт убирает за собой всё своё.
// Запуск (API поднят + seed): node scripts/verify-circle-review.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
// Адрес API переопределяется переменной окружения: два экземпляра на одной машине
// (например, когда :3001 занят чужим дев-сервером) — обычная ситуация при проверке правок.
const BASE = process.env.SA6_API_BASE || 'http://localhost:3001/api';
const P1 = '+77009990001', P2 = '+77009990002', P3 = '+77009990003', PW = 'Test1234!';
// Номер под тест регистрации (аккаунт создаётся и удаляется этим же скриптом).
const PNEW = '+77009998877';

let fails = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`);
  if (!ok) fails++;
};
async function call(method, p, token, body, headers = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => {
  const r = await call('POST', '/auth/login', null, { phone, password: PW });
  if (!r.ok) throw new Error(`login ${phone}: ${r.status}`);
  return r.json.data.accessToken;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Ждём асинхронный эффект (джоб/проекция) вместо гонки с ним. */
async function until(fn, ms = 12000, step = 300) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2), t3 = await login(P3);
  const u = {};
  for (const [k, phone] of [['u1', P1], ['u2', P2], ['u3', P3]]) {
    u[k] = (await prisma.user.findUnique({ where: { phone }, select: { id: true } })).id;
  }
  const pair = (x, y) => (x < y ? { userAId: x, userBId: y } : { userAId: y, userBId: x });
  const p12 = pair(u.u1, u.u2), p13 = pair(u.u1, u.u3);

  // ---- база: чистим ТОЛЬКО артефакты этого скрипта ----
  const created = { circleIds: [], resourceIds: [], workspaceIds: [], userIds: [] };
  const wipeInv = () => prisma.contactInvitation.deleteMany({
    where: { fromUserId: { in: [u.u1, u.u2, u.u3] }, toPhone: { in: [P1, P2, P3, PNEW] } },
  });
  const relink = (p, initiatedBy) => prisma.contactLink.upsert({
    where: { userAId_userBId: p },
    update: {},
    create: { ...p, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy },
  });
  const unblockAll = () => prisma.contactBlock.deleteMany({
    where: { blockerId: { in: [u.u1, u.u2, u.u3] }, blockedId: { in: [u.u1, u.u2, u.u3] } },
  });

  await unblockAll();
  await wipeInv();
  await relink(p12, u.u1);
  await prisma.contactLink.deleteMany({ where: p13 });

  try {
    // ============================================================
    // КРАСНЫЙ 1 — приватность: пустая видимость группы = дефолт владельца
    // ============================================================
    // Поля должны быть ЗАПОЛНЕНЫ, иначе «скрыто» и «пусто» неразличимы: карточка
    // отдаёт null и в том, и в другом случае, и тест ничего бы не доказывал.
    await call('PATCH', '/users/me', t2, { city: 'Алматы', bio: 'Тест ревью' });
    // u2 прячет в анкете город и био.
    await call('PATCH', '/users/me', t2, { cardVisibility: { city: false, bio: false, age: false } });
    const beforeGroup = await call('GET', '/contacts', t1);
    const seen0 = beforeGroup.json?.data?.items?.find((c) => c.them.id === u.u2);
    check('видимость: до групп скрытые поля закрыты', seen0 && seen0.them.city === null && seen0.them.bio === null,
      `city=${seen0?.them?.city} bio=${seen0?.them?.bio}`);

    // u2 создаёт СВЕЖУЮ группу (cardVisibility = null) и кладёт туда u1.
    const grpFresh = await call('POST', '/circles', t2, { name: 'Ревью: свежая' });
    created.circleIds.push(grpFresh.json?.data?.id);
    const link12For2 = (await call('GET', '/contacts', t2)).json.data.items.find((c) => c.them.id === u.u1);
    await call('POST', `/circles/${grpFresh.json.data.id}/members`, t2, { contactLinkId: link12For2.linkId });

    const afterGroup = await call('GET', '/contacts', t1);
    const seen1 = afterGroup.json?.data?.items?.find((c) => c.them.id === u.u2);
    check('КРАСНЫЙ 1: свежая группа НЕ раскрывает скрытые поля', seen1 && seen1.them.city === null && seen1.them.bio === null,
      `city=${seen1?.them?.city} bio=${seen1?.them?.bio}`);

    // Явная настройка группы по-прежнему ОТКРЫВАЕТ поле (union работает).
    await call('PATCH', `/circles/${grpFresh.json.data.id}`, t2, { cardVisibility: { city: true } });
    const afterOpen = await call('GET', '/contacts', t1);
    const seen2 = afterOpen.json?.data?.items?.find((c) => c.them.id === u.u2);
    check('видимость: явная настройка группы открывает поле', seen2 && seen2.them.city !== null, `city=${seen2?.them?.city}`);
    check('видимость: непрописанное поле остаётся закрытым', seen2 && seen2.them.bio === null, `bio=${seen2?.them?.bio}`);

    // ============================================================
    // ЖЁЛТЫЙ — PATCH /users/me мержит карту, а не затирает
    // ============================================================
    await call('PATCH', '/users/me', t2, { cardVisibility: { city: false, bio: false, email: false } });
    await call('PATCH', '/users/me', t2, { cardVisibility: { city: true } }); // частичный патч
    const me2 = await call('GET', '/users/me', t2);
    check('ЖЁЛТЫЙ: частичный PATCH видимости не воскрешает скрытое',
      me2.json?.data?.cardVisibility?.bio === false && me2.json?.data?.cardVisibility?.city === true,
      `bio=${me2.json?.data?.cardVisibility?.bio} city=${me2.json?.data?.cardVisibility?.city}`);

    // ============================================================
    // КРАСНЫЙ 7 — удаление группы снимает рёбра, где группа = СУБЪЕКТ
    // ============================================================
    const grpSub = await call('POST', '/circles', t1, { name: 'Ревью: субъект' });
    const grpSubId = grpSub.json?.data?.id;
    created.circleIds.push(grpSubId);
    await call('POST', '/shop/wishes/shares', t1, { principalType: 'circle', principalId: grpSubId });
    const tuplesBefore = await prisma.relationTuple.count({ where: { subjectType: 'circle', subjectId: grpSubId } });
    check('подготовка: грант НА группу выдан', tuplesBefore > 0, `tuples=${tuplesBefore}`);
    await call('DELETE', `/circles/${grpSubId}`, t1);
    const tuplesAfter = await prisma.relationTuple.count({ where: { subjectType: 'circle', subjectId: grpSubId } });
    check('КРАСНЫЙ 7: удаление группы снимает гранты, где она получатель', tuplesAfter === 0, `осталось ${tuplesAfter}`);
    created.circleIds = created.circleIds.filter((id) => id !== grpSubId);

    // ============================================================
    // КРАСНЫЙ 8 + ЖЁЛТЫЙ: приглашение — автогруппы обеих сторон,
    // проекция членства сразу, встречное приглашение не виснет
    // ============================================================
    await prisma.contactLink.deleteMany({ where: p12 });
    await wipeInv();
    const grpSender = await call('POST', '/circles', t1, { name: 'Ревью: отправитель' });
    const grpRecip = await call('POST', '/circles', t2, { name: 'Ревью: получатель' });
    created.circleIds.push(grpSender.json.data.id, grpRecip.json.data.id);

    const invA = await call('POST', '/contacts/invitations', t1, {
      toPhone: P2, proposedRoleForRecipient: 'Друг', proposedRoleForSender: 'Друг',
      autoAddToCircleIds: [grpSender.json.data.id],
    });
    check('приглашение с автогруппами отправлено', invA.ok, `status ${invA.status}`);
    // Встречное приглашение. Через API его отправить НЕЛЬЗЯ (send видит чужое
    // pending в обе стороны и отдаёт 409) — вторая строка появляется только
    // гонкой двух одновременных отправок, поэтому воспроизводим её напрямую.
    const invB = await prisma.contactInvitation.create({
      data: {
        fromUserId: u.u2, toUserId: u.u1, toPhone: P1, status: 'pending',
        proposedRoleForRecipient: 'Друг',
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      },
    });

    const acc = await call('POST', `/contacts/invitations/${invA.json.data.id}/accept`, t2, {
      myRole: 'Коллега', theirRole: 'Коллега', autoAddToCircleIds: [grpRecip.json.data.id],
    });
    check('приглашение принято', acc.ok, `status ${acc.status}`);

    const memSender = await prisma.circleMembership.count({ where: { circleId: grpSender.json.data.id } });
    const memRecip = await prisma.circleMembership.count({ where: { circleId: grpRecip.json.data.id } });
    check('КРАСНЫЙ 8: автогруппа ОТПРАВИТЕЛЯ применена', memSender === 1, `членств=${memSender}`);
    check('КРАСНЫЙ 8: автогруппа получателя применена', memRecip === 1, `членств=${memRecip}`);

    const tupSender = await prisma.relationTuple.count({
      where: { resourceType: 'circle', resourceId: grpSender.json.data.id, relation: 'member', subjectType: 'user', subjectId: u.u2 },
    });
    const tupRecip = await prisma.relationTuple.count({
      where: { resourceType: 'circle', resourceId: grpRecip.json.data.id, relation: 'member', subjectType: 'user', subjectId: u.u1 },
    });
    check('КРАСНЫЙ 8: членство спроецировано в движок доступа СРАЗУ', tupSender === 1 && tupRecip === 1,
      `sender=${tupSender} recipient=${tupRecip}`);

    const pendingLeft = await prisma.contactInvitation.count({
      where: { status: 'pending', OR: [{ fromUserId: u.u1, toUserId: u.u2 }, { fromUserId: u.u2, toUserId: u.u1 }] },
    });
    check('ЖЁЛТЫЙ: встречное приглашение не зависло в pending', pendingLeft === 0, `pending=${pendingLeft}`);

    // Идемпотентность: принять встречное после создания связи — не 500 и не вечный pending.
    const accDup = await call('POST', `/contacts/invitations/${invB.id}/accept`, t1, {});
    check('ЖЁЛТЫЙ: принятие уже созданной связи идемпотентно', accDup.status === 200 || accDup.status === 409, `status ${accDup.status}`);

    // ============================================================
    // ЖЁЛТЫЙ — гонка лимитов: 5 параллельных приглашений = 1 pending
    // ============================================================
    await wipeInv();
    await prisma.contactLink.deleteMany({ where: p13 });
    const burst = await Promise.all(Array.from({ length: 5 }, () =>
      call('POST', '/contacts/invitations', t1, { toPhone: P3 })));
    const okCount = burst.filter((r) => r.ok).length;
    const pendingToP3 = await prisma.contactInvitation.count({ where: { fromUserId: u.u1, toPhone: P3, status: 'pending' } });
    check('ЖЁЛТЫЙ: параллельные приглашения не обходят лимит', pendingToP3 === 1, `создано pending=${pendingToP3}, ok-ответов=${okCount}`);

    // ============================================================
    // ЖЁЛТЫЙ — курсор входящих + маска телефона отправителя
    // ============================================================
    const incoming = await call('GET', '/contacts/invitations/incoming', t3);
    check('ЖЁЛТЫЙ: входящие отдают курсор', 'nextCursor' in (incoming.json?.data ?? {}), `keys=${Object.keys(incoming.json?.data ?? {})}`);
    const fromCard = incoming.json?.data?.items?.find((i) => i.fromUserId === u.u1)?.from;
    check('ЖЁЛТЫЙ: телефон отправителя маскируется до связи', !!fromCard && fromCard.phone.includes('*'), `phone=${fromCard?.phone}`);

    // ============================================================
    // ЖЁЛТЫЙ — история исходящих + canResend
    // ============================================================
    const outPending = await call('GET', '/contacts/invitations/outgoing', t1);
    const invToP3 = outPending.json?.data?.items?.find((i) => i.toPhone === P3);
    await call('POST', `/contacts/invitations/${invToP3.id}/cancel`, t1);
    const outHistory = await call('GET', '/contacts/invitations/outgoing?scope=history', t1);
    const histRow = outHistory.json?.data?.items?.find((i) => i.id === invToP3.id);
    check('ЖЁЛТЫЙ: история исходящих доступна', !!histRow, `status ${outHistory.status}`);
    check('ЖЁЛТЫЙ: canResend посчитан сервером', histRow && typeof histRow.canResend === 'boolean', `canResend=${histRow?.canResend}`);
    check('ЖЁЛТЫЙ: свежеотменённое нельзя повторить (кулдаун)', histRow?.canResend === false);
    const outAfter = await call('GET', '/contacts/invitations/outgoing', t1);
    check('ЖЁЛТЫЙ: отменённое ушло из активных', !outAfter.json?.data?.items?.some((i) => i.id === invToP3.id));

    // ============================================================
    // ЖЁЛТЫЙ — блок гасит ВНЕШНЕЕ приглашение (матч по номеру)
    // ============================================================
    await wipeInv();
    const external = await prisma.contactInvitation.create({
      data: {
        fromUserId: u.u1, toUserId: null, toPhone: P3, status: 'pending',
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      },
    });
    await call('POST', '/contacts/blocks', t1, { userId: u.u3 });
    const extAfter = await prisma.contactInvitation.findUnique({ where: { id: external.id }, select: { status: true } });
    check('ЖЁЛТЫЙ: блок отменяет внешнее приглашение на номер', extAfter?.status === 'cancelled', `status=${extAfter?.status}`);

    // ============================================================
    // КРАСНЫЙ 5 — повторный блок ДОЧИЩАЕТ связь (не no-op)
    // ============================================================
    await relink(p13, u.u1); // имитируем состояние «блок есть, а связь жива» (гонка)
    const linkAlive = await prisma.contactLink.count({ where: p13 });
    const reblock = await call('POST', '/contacts/blocks', t1, { userId: u.u3 });
    const linkAfter = await prisma.contactLink.count({ where: p13 });
    check('КРАСНЫЙ 5: повторный блок убирает выжившую связь', linkAlive === 1 && linkAfter === 0 && reblock.ok,
      `было=${linkAlive} стало=${linkAfter} status=${reblock.status}`);
    await call('DELETE', `/contacts/blocks/${u.u3}`, t1);

    // ============================================================
    // КРАСНЫЙ 6 — разрыв связи снимает личные гранты (календарь + вишлист)
    // ============================================================
    const linksFor1 = (await call('GET', '/contacts', t1)).json.data.items;
    const link12 = linksFor1.find((c) => c.them.id === u.u2);
    check('подготовка: связь u1↔u2 жива', !!link12);

    await call('POST', '/calendar/shares', t1, { sharedWithUserId: u.u2, accessLevel: 'busy' });
    await call('POST', '/shop/wishes/shares', t1, { principalType: 'user', principalId: u.u2 });
    const calBefore = await prisma.relationTuple.count({
      where: { resourceType: 'calendar', resourceId: u.u1, subjectType: 'user', subjectId: u.u2 },
    });
    const wishBefore = await prisma.relationTuple.count({
      where: { resourceType: 'wishlist', resourceId: u.u1, subjectType: 'user', subjectId: u.u2 },
    });
    check('подготовка: личные гранты выданы', calBefore > 0 && wishBefore > 0, `cal=${calBefore} wish=${wishBefore}`);

    await call('DELETE', `/contacts/${link12.linkId}`, t1);
    const calAfter = await prisma.relationTuple.count({
      where: { resourceType: 'calendar', resourceId: u.u1, subjectType: 'user', subjectId: u.u2 },
    });
    const wishAfter = await prisma.relationTuple.count({
      where: { resourceType: 'wishlist', resourceId: u.u1, subjectType: 'user', subjectId: u.u2 },
    });
    check('КРАСНЫЙ 6: разрыв связи снял доступ к календарю', calAfter === 0, `осталось ${calAfter}`);
    check('КРАСНЫЙ 6: разрыв связи снял доступ к вишлисту', wishAfter === 0, `осталось ${wishAfter}`);

    // ============================================================
    // ЖЁЛТЫЙ — «Контакт удалён» НЕ приходит тому, кто удалил
    // ============================================================
    const since = new Date(Date.now() - 60_000);
    const notifOther = await until(async () => (await prisma.notification.count({
      where: { userId: u.u2, type: 'contact.removed', createdAt: { gte: since } },
    })) > 0);
    const notifActor = await prisma.notification.count({
      where: { userId: u.u1, type: 'contact.removed', createdAt: { gte: since } },
    });
    check('ЖЁЛТЫЙ: уведомление об удалении ушло второй стороне', !!notifOther);
    check('ЖЁЛТЫЙ: актору «Контакт удалён» НЕ приходит', notifActor === 0, `у актора ${notifActor}`);

    // ============================================================
    // КРАСНЫЙ 2 — бронь ресурсов гейтится
    // ============================================================
    const badBooker = await call('POST', '/resources', t1, { name: 'Ревью: ресурс', bookerUserIds: [u.u3] });
    check('КРАСНЫЙ 2: чужой человек в bookerUserIds отклонён', !badBooker.ok, `status ${badBooker.status}`);
    if (badBooker.json?.data?.id) created.resourceIds.push(badBooker.json.data.id);

    const foreignCircle = await call('POST', '/circles', t2, { name: 'Ревью: чужая группа' });
    created.circleIds.push(foreignCircle.json.data.id);
    const badCircle = await call('POST', '/resources', t1, { name: 'Ревью: ресурс 2', bookerCircleIds: [foreignCircle.json.data.id] });
    check('КРАСНЫЙ 2: чужая группа в bookerCircleIds отклонена', !badCircle.ok, `status ${badCircle.status}`);
    if (badCircle.json?.data?.id) created.resourceIds.push(badCircle.json.data.id);

    // ============================================================
    // КРАСНЫЙ 3 + personalOnly — организация
    // ============================================================
    await relink(p12, u.u1);
    const ws = await call('POST', '/workspaces', t1, { name: 'Ревью Circle' });
    const wsId = ws.json?.data?.id;
    if (wsId) created.workspaceIds.push(wsId);
    check('подготовка: организация создана', !!wsId, `status ${ws.status}`);

    const grpTask = await call('POST', '/circles', t1, { name: 'Ревью: задача' });
    created.circleIds.push(grpTask.json.data.id);
    const link12b = (await call('GET', '/contacts', t1)).json.data.items.find((c) => c.them.id === u.u2);
    await call('POST', `/circles/${grpTask.json.data.id}/members`, t1, { contactLinkId: link12b.linkId });

    // u2 в организации НЕ состоит → задача на Группу в контексте организации должна быть отклонена.
    const taskViaCircle = await call('POST', '/tasks', t1,
      { title: 'Ревью: задача на группу', assignedCircleId: grpTask.json.data.id },
      { 'X-Workspace-Id': wsId });
    check('КРАСНЫЙ 3: задача на Группу в контексте организации гейтится',
      taskViaCircle.status === 403, `status ${taskViaCircle.status}`);
    if (taskViaCircle.json?.data?.id) await prisma.task.deleteMany({ where: { id: taskViaCircle.json.data.id } });

    // u3 — сотрудник организации, но НЕ в личном окружении u1.
    await prisma.workspaceMember.create({ data: { workspaceId: wsId, userId: u.u3 } }).catch(() => {});
    await prisma.userRole.create({
      data: { userId: u.u3, role: 'staff', context: 'workspace', tenantId: wsId, isActive: true },
    }).catch(() => {});
    const shareFin = await call('POST', '/finance/shares', t1,
      { principalType: 'user', principalId: u.u3, role: 'viewer' },
      { 'X-Workspace-Id': wsId });
    check('ЖЁЛТЫЙ: личную книгу нельзя расшарить по рабочему пропуску',
      shareFin.status === 403, `status ${shareFin.status}`);

    // ============================================================
    // КРАСНЫЙ 4 — регистрация ставит активацию приглашений джобом
    // ============================================================
    await prisma.user.deleteMany({ where: { phone: PNEW } });
    const invExt = await prisma.contactInvitation.create({
      data: {
        fromUserId: u.u1, toUserId: null, toPhone: PNEW, status: 'pending',
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      },
    });
    const reg = await call('POST', '/auth/register', null, { phone: PNEW, password: PW, firstName: 'Ревью' });
    check('подготовка: регистрация прошла', reg.ok, `status ${reg.status}`);
    const newUser = await prisma.user.findUnique({ where: { phone: PNEW }, select: { id: true } });
    if (newUser) created.userIds.push(newUser.id);
    const activated = await until(async () => {
      const row = await prisma.contactInvitation.findUnique({ where: { id: invExt.id }, select: { toUserId: true } });
      return row?.toUserId ? row : null;
    });
    check('КРАСНЫЙ 4: приглашение активировано джобом после регистрации', !!activated,
      activated ? '' : 'toUserId так и не проставлен');

    // ============================================================
    // Диффная проекция уровня календаря группы (busy → detailed)
    // ============================================================
    const grpCal = await call('POST', '/circles', t1, { name: 'Ревью: календарь' });
    created.circleIds.push(grpCal.json.data.id);
    await call('PATCH', `/circles/${grpCal.json.data.id}`, t1, { calendarVisibility: 'busy' });
    await call('PATCH', `/circles/${grpCal.json.data.id}`, t1, { calendarVisibility: 'detailed' });
    const calTuples = await prisma.relationTuple.findMany({
      where: { resourceType: 'calendar', resourceId: u.u1, subjectType: 'circle', subjectId: grpCal.json.data.id },
      select: { relation: true },
    });
    check('уровень календаря группы: остался ровно один, detailed',
      calTuples.length === 1 && calTuples[0].relation === 'detailed_viewer',
      `tuples=${calTuples.map((t) => t.relation).join(',') || 'нет'}`);
    const repeat = await call('PATCH', `/circles/${grpCal.json.data.id}`, t1, { calendarVisibility: 'detailed' });
    check('повторный PATCH тем же уровнем безопасен', repeat.ok, `status ${repeat.status}`);
  } finally {
    // ---- уборка: только своё ----
    for (const id of created.circleIds.filter(Boolean)) {
      await prisma.circle.deleteMany({ where: { id } }).catch(() => {});
      await prisma.relationTuple.deleteMany({ where: { subjectType: 'circle', subjectId: id } }).catch(() => {});
    }
    for (const id of created.resourceIds.filter(Boolean)) {
      await prisma.resource.deleteMany({ where: { id } }).catch(() => {});
    }
    for (const id of created.workspaceIds.filter(Boolean)) {
      await prisma.userRole.deleteMany({ where: { tenantId: id } }).catch(() => {});
      await prisma.workspaceMember.deleteMany({ where: { workspaceId: id } }).catch(() => {});
      await prisma.task.updateMany({ where: { workspaceId: id }, data: { workspaceId: null } }).catch(() => {});
      await prisma.workspace.deleteMany({ where: { id } }).catch(() => {});
    }
    for (const id of created.userIds.filter(Boolean)) {
      await prisma.contactInvitation.deleteMany({ where: { toUserId: id } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id } }).catch(() => {});
    }
    await prisma.contactInvitation.deleteMany({
      where: { fromUserId: { in: [u.u1, u.u2, u.u3] }, toPhone: { in: [P1, P2, P3, PNEW] } },
    }).catch(() => {});
    await prisma.contactBlock.deleteMany({
      where: { blockerId: { in: [u.u1, u.u2, u.u3] }, blockedId: { in: [u.u1, u.u2, u.u3] } },
    }).catch(() => {});
    // Возвращаем исходную линию: связь u1↔u2 живёт, видимость u2 — платформенная.
    await prisma.contactLink.upsert({
      where: { userAId_userBId: p12 },
      update: {},
      create: { ...p12, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u.u1 },
    }).catch(() => {});
    await prisma.user.update({
      where: { id: u.u2 },
      data: { cardVisibility: null, city: null, bio: null },
    }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
