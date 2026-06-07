/* eslint-disable */
// Demo: grant + equip a skin on tester1's contacts so foreign skins are visible across the app.
// Run (DB up): node scripts/demo-equip-skin.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function grant(phone, skinName) {
  const u = await prisma.user.findUnique({ where: { phone }, select: { id: true } });
  if (!u) return console.log(`skip: no user ${phone}`);
  const skin = await prisma.cardSkin.findFirst({ where: { name: skinName }, select: { id: true, supply: true } });
  if (!skin) return console.log(`skip: no skin ${skinName}`);
  // Idempotent: clear this user's prior demo instances first.
  await prisma.user.update({ where: { id: u.id }, data: { defaultSkinInstanceId: null } });
  await prisma.cardSkinInstance.deleteMany({ where: { ownerId: u.id, acquiredVia: 'grant' } });
  const upd = await prisma.cardSkin.update({ where: { id: skin.id }, data: { minted: { increment: 1 } }, select: { minted: true } });
  const serial = skin.supply !== null ? upd.minted : null;
  const inst = await prisma.cardSkinInstance.create({ data: { skinId: skin.id, ownerId: u.id, serial, acquiredVia: 'grant' } });
  await prisma.cardSkinTransfer.create({ data: { instanceId: inst.id, fromUserId: null, toUserId: u.id, kind: 'mint' } });
  await prisma.user.update({ where: { id: u.id }, data: { defaultSkinInstanceId: inst.id } });
  console.log(`✓ ${skinName} → ${phone} (serial ${serial ?? '—'})`);
}

async function main() {
  await grant('+77023456789', 'Ретро-неон'); // tester3 = ТЕСТЕР
  await grant('+77012345678', 'Цветочный');   // tester2 = ДИАНА
  console.log('✅ demo skins equipped');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); }).finally(() => prisma.$disconnect());
