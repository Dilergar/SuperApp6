/* eslint-disable */
// Уборка «бесхозных» байтов локального хранилища движка файлов: файлов на диске,
// которым не соответствует ни одна строка в file_objects/file_variants.
//
//   node scripts/gc-orphan-bytes.cjs           — сухой прогон (только считает)
//   node scripts/gc-orphan-bytes.cjs --apply   — удалить
//
// Откуда берётся мусор: строку файла удалили из БД напрямую (`prisma.fileObject.delete*`
// в тестах и починках), минуя движок. Штатный путь — soft-delete, и тогда байты снимает
// FilesCron.sweepDeleted вместе со строкой; сырое удаление строки диск не трогает.
//
// Защита от гонки с идущей загрузкой: файлы моложе GRACE_HOURS не трогаем — строка
// могла ещё не появиться (init → байты → complete). tmp/ и egress/ пропускаем: это
// рабочие каталоги multer/конвейера и записи звонков, они живут по своим правилам.
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const GRACE_HOURS = 24;
const SKIP_DIRS = new Set(['tmp', 'egress']);

function walk(dir, rel, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!rel && SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), r, out);
    } else if (e.isFile()) {
      out.push(r);
    }
  }
  return out;
}

async function main() {
  if ((process.env.FILES_DRIVER || 'local') !== 'local') {
    console.log('FILES_DRIVER не local — этот скрипт только для локального диска.');
    return;
  }
  const root = path.resolve(process.cwd(), process.env.FILES_LOCAL_ROOT || './storage');
  if (!fs.existsSync(root)) { console.log(`Нет каталога ${root}`); return; }

  const prisma = new PrismaClient();
  try {
    const known = new Set();
    for (const r of await prisma.fileObject.findMany({ select: { storageKey: true } })) known.add(r.storageKey);
    for (const r of await prisma.fileVariant.findMany({ select: { storageKey: true } })) known.add(r.storageKey);

    const cutoff = Date.now() - GRACE_HOURS * 3600 * 1000;
    let orphanCount = 0, orphanBytes = 0, freshSkipped = 0, deleted = 0;
    for (const rel of walk(root, '', [])) {
      if (known.has(rel)) continue;
      const full = path.join(root, rel);
      const st = fs.statSync(full);
      if (st.mtimeMs > cutoff) { freshSkipped++; continue; } // свежак — вдруг загрузка идёт прямо сейчас
      orphanCount++; orphanBytes += st.size;
      if (APPLY) { fs.unlinkSync(full); deleted++; }
    }

    const mb = (b) => (b / 1024 / 1024).toFixed(1);
    console.log(`ключей в БД: ${known.size}`);
    console.log(`бесхозных: ${orphanCount} файлов, ${mb(orphanBytes)} МБ${freshSkipped ? ` (пропущено свежих <${GRACE_HOURS}ч: ${freshSkipped})` : ''}`);
    console.log(APPLY ? `удалено: ${deleted}` : 'Сухой прогон. Чтобы удалить: node scripts/gc-orphan-bytes.cjs --apply');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
