/* eslint-disable */
// «Задачи 2.0» e2e: Входящие (GTD inbox) + счётчики + поиск + overdue-семантика.
//  • quick-add {title, inbox:true} → полноценная Task в smartList=inbox;
//  • уточнение (dueDate | executorId | inbox:false) снимает флаг;
//  • create с датой/родителем гасит inbox сразу; submit само-задачи убирает из Входящих;
//  • GET /tasks/stats (роут НЕ перехвачен :id) — паритет с meta.total листов;
//  • overdue: allDay «на сегодня» НЕ просрочена (Todoist), с прошедшим временем — в today И overdue;
//  • приватность: посторонний не видит чужие задачи ни списком, ни поиском, ни в stats.
// Run (API up): node scripts/verify-tasks-inbox.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
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
const q = (params) => '?' + new URLSearchParams(params).toString();
const stats = async (t) => (await call('GET', '/tasks/stats', t)).json?.data;
const listIds = async (t, params) => ((await call('GET', '/tasks' + q(params), t)).json?.data ?? []).map((x) => x.id);

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2), t3 = await login(P3);
  const u2 = (await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } })).id;
  const u1 = (await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } })).id;
  const [a, b] = u1 < u2 ? [u1, u2] : [u2, u1];
  await prisma.contactLink.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u1 } });

  const made = []; // [taskId, ownerToken]
  const mk = async (token, body) => { const r = await call('POST', '/tasks', token, body); if (r.ok) made.push([r.json.data.id, token]); return r; };

  try {
    // ---- 0. stats доступен и не перехвачен @Get(':id')
    const s0 = await stats(t1);
    check('GET /tasks/stats отвечает объектом счётчиков', !!s0 && typeof s0.inbox === 'number' && typeof s0.onReview === 'number', JSON.stringify(s0 ?? {}));
    const base3 = await stats(t3);

    // ---- 1. quick-add → Входящие
    const marker = `Входящие-тест-${Date.now()}`;
    const c1 = await mk(t1, { title: `${marker} молоко`, description: 'купить на рынке', inbox: true });
    check('quick-add: создана задача с inbox=true', c1.ok && c1.json.data.inbox === true, `status ${c1.status}, inbox=${c1.json?.data?.inbox}`);
    const inboxId = c1.json.data.id;
    check('quick-add: это само-задача без участников', !c1.json.data.executor && c1.json.data.coExecutors.length === 0);

    const inboxIds1 = await listIds(t1, { smartList: 'inbox' });
    check('во Входящих появилась', inboxIds1.includes(inboxId));
    const s1 = await stats(t1);
    check('stats.inbox вырос на 1', s1.inbox === s0.inbox + 1, `${s0.inbox} → ${s1.inbox}`);

    // ---- 2. поиск по ключевому слову (название + описание), приватность
    const foundTitle = await listIds(t1, { search: 'молоко' });
    check('поиск по названию находит', foundTitle.includes(inboxId));
    const foundDesc = await listIds(t1, { search: 'рынке' });
    check('поиск по описанию находит', foundDesc.includes(inboxId));
    const strangerSearch = await listIds(t3, { search: 'молоко' });
    check('посторонний поиском ЧУЖОЕ не видит', !strangerSearch.includes(inboxId));
    const strangerInbox = await listIds(t3, { smartList: 'inbox' });
    check('посторонний во Входящих чужого не видит', !strangerInbox.includes(inboxId));

    // ---- 3. уточнение сроком → ушла из Входящих
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const p1 = await call('PATCH', `/tasks/${inboxId}`, t1, { dueDate: tomorrow });
    check('PATCH dueDate: inbox снят автоматически', p1.ok && p1.json.data.inbox === false, `inbox=${p1.json?.data?.inbox}`);
    check('из Входящих ушла', !(await listIds(t1, { smartList: 'inbox' })).includes(inboxId));

    // ---- 4. уточнение исполнителем
    const c2 = await mk(t1, { title: `${marker} поручить`, inbox: true });
    const p2 = await call('PATCH', `/tasks/${c2.json.data.id}`, t1, { executorId: u2 });
    check('PATCH executorId: inbox снят, исполнитель назначен', p2.ok && p2.json.data.inbox === false && p2.json.data.executor?.userId === u2, `inbox=${p2.json?.data?.inbox}`);
    const t2inbox = await listIds(t2, { smartList: 'inbox' });
    check('у исполнителя ЧУЖАЯ задача не во Входящих', !t2inbox.includes(c2.json.data.id));

    // ---- 5. ручное «Разобрано»
    const c3 = await mk(t1, { title: `${marker} разобрано`, inbox: true });
    const p3 = await call('PATCH', `/tasks/${c3.json.data.id}`, t1, { inbox: false });
    check('PATCH inbox:false («Разобрано») работает', p3.ok && p3.json.data.inbox === false);
    check('после «Разобрано» видна в общем списке', (await listIds(t1, { search: marker })).includes(c3.json.data.id));

    // ---- 6. гейты на создании: дата/родитель гасят флаг сразу
    const c4 = await mk(t1, { title: `${marker} с датой`, inbox: true, dueDate: tomorrow });
    check('create c inbox+dueDate → inbox=false', c4.ok && c4.json.data.inbox === false);
    const c5 = await mk(t1, { title: `${marker} родитель` });
    const c6 = await mk(t1, { title: `${marker} сабтаск`, inbox: true, parentId: c5.json.data.id });
    check('create c inbox+parentId → inbox=false (сабтаск не тонет)', c6.ok && c6.json.data.inbox === false);

    // ---- 7. submit само-задачи из Входящих → done, из списка ушла
    const c7 = await mk(t1, { title: `${marker} сделать сразу`, inbox: true });
    const sub = await call('POST', `/tasks/${c7.json.data.id}/submit`, t1);
    check('submit inbox-само-задачи → сразу done', sub.ok && sub.json.data.status === 'done');
    check('выполненная ушла из Входящих', !(await listIds(t1, { smartList: 'inbox' })).includes(c7.json.data.id));

    // ---- 8. overdue-семантика (Todoist): allDay «на сегодня» НЕ просрочена
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
    const todayAllDay = await mk(t1, { title: `${marker} весь день сегодня`, dueDate: startToday.toISOString(), allDay: true });
    const yesterdayAllDay = await mk(t1, { title: `${marker} весь день вчера`, dueDate: new Date(startToday.getTime() - 24 * 3600 * 1000).toISOString(), allDay: true });
    const overdueIds = await listIds(t1, { smartList: 'overdue' });
    const todayIds = await listIds(t1, { smartList: 'today' });
    check('allDay на сегодня — в «Сегодня»', todayIds.includes(todayAllDay.json.data.id));
    check('allDay на сегодня — НЕ в «Просроченных»', !overdueIds.includes(todayAllDay.json.data.id));
    check('allDay на вчера — в «Просроченных»', overdueIds.includes(yesterdayAllDay.json.data.id));

    const past = Date.now() - 5 * 60 * 1000;
    if (past > startToday.getTime()) {
      const timedPast = await mk(t1, { title: `${marker} время прошло`, dueDate: new Date(past).toISOString(), allDay: false });
      const ov2 = await listIds(t1, { smartList: 'overdue' });
      const td2 = await listIds(t1, { smartList: 'today' });
      check('со временем в прошлом сегодня — в «Сегодня» И в «Просроченных»', ov2.includes(timedPast.json.data.id) && td2.includes(timedPast.json.data.id));
    }

    // ---- 9. паритет stats ↔ meta.total соответствующих листов
    const sFin = await stats(t1);
    const totalOf = async (params) => (await call('GET', '/tasks' + q({ ...params, limit: '1' }), t1)).json?.meta?.total;
    const openCsv = 'todo,in_progress,on_review';
    check('паритет: inbox', sFin.inbox === await totalOf({ smartList: 'inbox' }), `${sFin.inbox}`);
    check('паритет: today', sFin.today === await totalOf({ smartList: 'today' }), `${sFin.today}`);
    check('паритет: overdue', sFin.overdue === await totalOf({ smartList: 'overdue' }), `${sFin.overdue}`);
    check('паритет: upcoming', sFin.upcoming === await totalOf({ smartList: 'upcoming' }), `${sFin.upcoming}`);
    check('паритет: onReview', sFin.onReview === await totalOf({ smartList: 'on_review' }), `${sFin.onReview}`);
    check('паритет: assignedToMe (только открытые)', sFin.assignedToMe === await totalOf({ smartList: 'assigned_to_me', status: openCsv }), `${sFin.assignedToMe}`);
    check('паритет: createdByMe (только открытые)', sFin.createdByMe === await totalOf({ smartList: 'created_by_me', status: openCsv }), `${sFin.createdByMe}`);

    // ---- 10. stats постороннего не изменился от чужой активности
    const t3fin = await stats(t3);
    check('у постороннего stats.inbox не изменился', t3fin.inbox === base3.inbox, `${base3.inbox} → ${t3fin.inbox}`);
  } finally {
    for (const [id, token] of made.reverse()) await call('DELETE', `/tasks/${id}`, token).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ TASKS INBOX/STATS/SEARCH E2E ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
