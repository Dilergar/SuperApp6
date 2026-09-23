/* eslint-disable */
// Первый владелец кабинета платформы — второй и последний ручной шаг запуска платформы
// (docs/platform_console.md). Первый — `consents-publish-initial.cjs`: пока юридические
// документы не опубликованы, регистрация закрыта и живого аккаунта для штата не существует.
// Дальше сотрудников добавляют командами кабинета. Скрипт отказывается работать, если
// активный владелец уже есть: второго «первого» не бывает, а третьего — командой.
//
//   node apps/api/scripts/platform-bootstrap-owner.cjs +77009990001
//
// Пишет в append-only журнал запись `platform.staff.bootstrap` с actorId = null.
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const { PrismaClient } = require('@prisma/client');
const { ensureAuditPartition, recordScriptEvent } = require('./_audit.cjs');

const OWNER_ROLE = 'platform_owner';

async function main() {
  const phone = process.argv[2];
  if (!phone || !/^\+\d{10,15}$/.test(phone)) {
    console.error('usage: node apps/api/scripts/platform-bootstrap-owner.cjs +7XXXXXXXXXX');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const owners = await prisma.platformStaffRole.count({
      where: { role: OWNER_ROLE, staff: { status: 'active' }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    });
    if (owners > 0) {
      console.error('refused: an active platform owner already exists — add staff with console commands');
      process.exit(1);
    }
    const user = await prisma.user.findUnique({ where: { phone }, select: { id: true, deletedAt: true, firstName: true } });
    if (!user || user.deletedAt) {
      console.error(`refused: no live account for ${phone}`);
      process.exit(1);
    }
    await ensureAuditPartition(prisma);
    await prisma.$transaction(async (tx) => {
      await tx.platformStaff.upsert({
        where: { userId: user.id },
        create: { userId: user.id, status: 'active', note: 'bootstrap owner', createdBy: null },
        update: { status: 'active', suspendedAt: null },
      });
      await tx.platformStaffRole.upsert({
        where: { userId_role: { userId: user.id, role: OWNER_ROLE } },
        create: { userId: user.id, role: OWNER_ROLE, grantedBy: user.id, reason: 'bootstrap: first platform owner' },
        update: { expiresAt: null },
      });
      // След в журнале безопасности (core/audit): команда Кабинета от имени системы
      await recordScriptEvent(tx, {
        key: 'platform.command.executed',
        op: 'platform.staff.bootstrap',
        target: { type: 'user', id: user.id },
        details: {
          version: 1,
          input: { userId: user.id },
          before: null,
          after: null,
          readOnly: false,
          risk: 'critical',
          reason: 'bootstrap: first platform owner',
          dryRun: false,
          durationMs: 0,
        },
      });
    });
    console.log(`ok: ${user.firstName} (${user.id}) is the platform owner`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
