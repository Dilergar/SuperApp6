/* eslint-disable */
// Напоминания календаря на движке джобов (core/jobs, Волна 5):
// создание события ставит джоб calendar.reminder.fire с runAt=fireAt (outbox);
// наступивший срок → АТОМАРНЫЙ пер-строчный клейм sentAt + событие → уведомление;
// повторный джоб / удалённая строка → no-op (без дублей и без ошибок);
// правка времени события пересоздаёт напоминания и джобы под новый срок.
// Run: node scripts/verify-calendar-reminders.cjs   (API на 3001, сидированные tester1-3)
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567', PW = 'Test1234!';
const JOB_TYPE = 'calendar.reminder.fire';

let fails = 0;
const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };
async function call(method, p, token, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => (await call('POST', '/auth/login', null, { phone, password: PW })).json.data.accessToken;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000, step = 400) {
  const until = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > until) return null; await sleep(step); }
}
const mkJob = (prisma, reminderId, uniqueKey) => prisma.job.create({
  data: {
    type: JOB_TYPE, queue: 'default', payload: { reminderId }, status: 'available',
    runAt: new Date(), maxAttempts: 5, uniqueKey,
  },
});

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1);
  const u1 = (await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } })).id;

  try {
    // ---------- 1. Создание события ставит джоб напоминания (transactional outbox) ----------
    const start = new Date(Date.now() + 3 * 3600 * 1000);
    const TITLE = `Проверка напоминаний ${crypto.randomUUID().slice(0, 8)}`;
    const ev = await call('POST', '/calendar/events', t1, {
      title: TITLE,
      startTime: start.toISOString(),
      endTime: new Date(+start + 3600 * 1000).toISOString(),
      reminderOffsets: [30],
    });
    check('событие создано', ev.ok, `status ${ev.status} ${JSON.stringify(ev.json)}`);
    let eventId = ev.json?.data?.id ?? ev.json?.data?.eventId ?? null;
    if (!eventId) {
      const row = await prisma.calendarEvent.findFirst({ where: { userId: u1, title: TITLE }, select: { id: true } });
      eventId = row?.id ?? null;
    }
    check('id события получен', !!eventId, String(eventId));

    const rem = await waitFor(async () =>
      (await prisma.calendarEventReminder.findFirst({ where: { eventId, userId: u1, sentAt: null, minutesBefore: 30 } })) ?? null, 6000);
    check('строка напоминания создана (offset 30 мин)', !!rem, rem && String(rem.fireAt));
    const job = rem ? await prisma.job.findFirst({ where: { type: JOB_TYPE, uniqueKey: `cer:${rem.id}` } }) : null;
    check('outbox: джоб calendar.reminder.fire поставлен', !!job, job?.status);
    check('джоб отложен ровно на fireAt (runAt = fireAt)', !!job && !!rem && Math.abs(+job.runAt - +rem.fireAt) < 2000, `${job?.runAt} vs ${rem?.fireAt}`);
    check('джоб ждёт срока, не исполнен заранее', job?.status === 'available', job?.status);

    // ---------- 2. Наступивший срок: клейм sentAt + событие → уведомление ----------
    // Инжектим просроченную строку мимо API + джоб руками (ровно то, что делает бэкфилл).
    const dueId = crypto.randomUUID();
    await prisma.calendarEventReminder.create({
      data: {
        id: dueId, eventId, userId: u1,
        occurrenceStart: start, minutesBefore: 15,
        fireAt: new Date(Date.now() - 60_000),
      },
    });
    const before = await prisma.notification.count({ where: { userId: u1, type: 'calendar.event.reminder' } });
    await mkJob(prisma, dueId, `cer:${dueId}`);

    const sent = await waitFor(async () => {
      const r = await prisma.calendarEventReminder.findUnique({ where: { id: dueId }, select: { sentAt: true } });
      return r?.sentAt ? r : null;
    });
    check('джоб отработал: sentAt проставлен (пер-строчный атомарный клейм)', !!sent, String(sent?.sentAt));
    const grew = await waitFor(async () => {
      const n = await prisma.notification.count({ where: { userId: u1, type: 'calendar.event.reminder' } });
      return n > before ? n : null;
    });
    check('уведомление calendar.event.reminder создано', !!grew, `было ${before}, стало ${grew}`);

    // ---------- 3. Повторный джоб на ту же строку → no-op (клейм sentAt не пускает) ----------
    const afterFirst = await prisma.notification.count({ where: { userId: u1, type: 'calendar.event.reminder' } });
    await mkJob(prisma, dueId, `cer:${dueId}:again`);
    await sleep(4000);
    const afterSecond = await prisma.notification.count({ where: { userId: u1, type: 'calendar.event.reminder' } });
    check('повторный джоб НЕ задвоил уведомление', afterSecond === afterFirst, `${afterFirst} → ${afterSecond}`);

    // ---------- 4. Удалённая строка (правка события) → джоб no-op без ошибки ----------
    const ghostId = crypto.randomUUID();
    const ghostJob = await mkJob(prisma, ghostId, `cer:${ghostId}`);
    const ghostDone = await waitFor(async () => {
      const j = await prisma.job.findUnique({ where: { id: ghostJob.id }, select: { status: true } });
      return j && j.status !== 'available' && j.status !== 'executing' ? j : null;
    });
    check('джоб удалённого напоминания завершился как completed (no-op)', ghostDone?.status === 'completed', ghostDone?.status);

    // ---------- 5. Правка времени события пересоздаёт напоминания и джобы ----------
    const newStart = new Date(Date.now() + 5 * 3600 * 1000);
    const upd = await call('PATCH', `/calendar/events/${eventId}`, t1, {
      startTime: newStart.toISOString(),
      endTime: new Date(+newStart + 3600 * 1000).toISOString(),
    });
    check('время события изменено', upd.ok, `status ${upd.status} ${JSON.stringify(upd.json?.message ?? '')}`);
    const rem2 = await waitFor(async () => {
      const r = await prisma.calendarEventReminder.findFirst({
        where: { eventId, userId: u1, sentAt: null, minutesBefore: 30 },
      });
      return r && Math.abs(+r.fireAt - (+newStart - 30 * 60_000)) < 2000 ? r : null;
    }, 8000);
    check('напоминание пересоздано под новое время', !!rem2, rem2 && String(rem2.fireAt));
    const job2 = rem2 ? await prisma.job.findFirst({ where: { type: JOB_TYPE, uniqueKey: `cer:${rem2.id}` } }) : null;
    check('джоб под новое время поставлен (runAt = новый fireAt)', !!job2 && !!rem2 && Math.abs(+job2.runAt - +rem2.fireAt) < 2000, String(job2?.runAt));

    await call('DELETE', `/calendar/events/${eventId}`, t1);
  } finally {
    await prisma.$disconnect();
  }

  console.log(fails === 0 ? '\nALL PASS' : `\nFAILED: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
