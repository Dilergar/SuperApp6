// ============================================================
// Разовый перенос раскладки доски Заметок: x/y были ПРОЦЕНТАМИ холста, стали ПИКСЕЛЯМИ.
// Размер холста, в котором человек раскладывал, неизвестен — берём типичный (≈1300px):
// взаимное расположение карточек сохраняется, точное место человек поправит одним жестом.
// Запускать ОДИН раз (из apps/api): после переноса значения ≤ 100 — честные пиксели.
// ============================================================
const { PrismaClient } = require('@prisma/client');

const db = new PrismaClient();
const K = 13;

(async () => {
  const rows = await db.noteBoardItem.findMany({ select: { id: true, x: true, y: true } });
  let moved = 0;
  for (const r of rows) {
    if (r.x > 100 || r.y > 100) continue; // уже пиксели
    await db.noteBoardItem.update({ where: { id: r.id }, data: { x: Math.round(r.x * K), y: Math.round(r.y * K) } });
    moved += 1;
  }
  console.log(`перенесено строк раскладки: ${moved} из ${rows.length}`);
  await db.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
