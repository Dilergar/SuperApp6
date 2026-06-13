/* eslint-disable */
// One-time backfill of CalendarEvent.recurrenceEndsAt (arch-review block 4): the materialized
// end of each bounded recurrence (UNTIL/COUNT), so range queries can skip finished series.
// Infinite rules stay null (= always fetched, same as before). Idempotent — safe to re-run.
// Run: node scripts/backfill-recurrence-ends.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const { RRule } = require('rrule');

async function main() {
  const prisma = new PrismaClient();
  const masters = await prisma.calendarEvent.findMany({
    where: { recurrenceRule: { not: null }, recurrenceEndsAt: null },
    select: { id: true, recurrenceRule: true, startTime: true, endTime: true },
  });
  let set = 0;
  for (const m of masters) {
    let ends = null;
    try {
      const opts = RRule.parseString(m.recurrenceRule);
      if (opts.until || opts.count) {
        const r = new RRule({ ...opts, dtstart: m.startTime });
        const all = r.all();
        const last = all.length ? all[all.length - 1] : m.startTime;
        ends = new Date(+last + (+m.endTime - +m.startTime));
      }
    } catch {}
    if (ends) {
      await prisma.calendarEvent.update({ where: { id: m.id }, data: { recurrenceEndsAt: ends } });
      set++;
    }
  }
  console.log(`recurring masters scanned: ${masters.length}, recurrenceEndsAt set: ${set} (rest = infinite series)`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
