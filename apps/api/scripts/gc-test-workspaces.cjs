/* eslint-disable */
// Уборка организаций, оставшихся от verify-скриптов и ручных демо-прогонов.
//
//   node scripts/gc-test-workspaces.cjs           — сухой прогон (только показывает)
//   node scripts/gc-test-workspaces.cjs --apply   — удалить
//
// Удаляет ШТАТНЫМ каскадом — тем же, что ретеншн архива (план реестра core/lifecycle:
// задачи с эскроу, чаты, Диск, заметки, файлы, права, роли, хроника — docs/lifecycle_engine.md).
// Своего списка таблиц у скрипта нет: он только отправляет организации в архив «давно»
// (срок архива истёк) и зовёт дев-ручку ретеншна, пока есть что удалять. Второго места
// правки каскада больше нет — новая таблица с workspace_id объявляется в реестре, и всё.
//
// НЕ трогаем осознанно: счета/валюты кошелька (журнал двойной записи неизменяем) — это
// решение реестра (`retain_legal`), а не скрипта.
const { PrismaClient } = require('@prisma/client');
const { WORKSPACE_LIMITS } = require('@superapp/shared');
const { SUITE, login, call } = require('./_lib.cjs');

const APPLY = process.argv.includes('--apply');

// Точечная уборка: --only=Сьют-,Зонд- убирает ТОЛЬКО организации с этими префиксами.
// Нужно, когда упёрлись в потолок «20 организаций на владельца» и надо освободить
// место под прогон, не трогая демо-организации человека («Демо», «ТестКорп»).
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '')
  .replace('--only=', '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

// Имена, которые генерят сами скрипты и демо-прогоны в браузере. Всё остальное —
// организации человека, их не трогаем.
// Сьют заводит организацию только хелперами `_lib.cjs` (`createSuiteWorkspace` /
// `ensureSuiteWorkspace`), а они требуют префикс `Сьют-` — он здесь есть, новый сьют
// ничего сюда не дописывает. Прочие имена — прежние, до хелперов (их хвосты ещё живут в базах).
const PREFIXES = [
  'ТестКорп ', 'fin-e2e-', 'chatter-e2e-', 'Ф1-Лого ', 'Демо', 'Журнал-демо',
  'pii-ws-', 'keys-ws-', 'keys-e-',
  'docs-ws-', 'Сьют-ЭДО', 'Сьют-Контрагенты', 'Сьют-КЭДО', 'Сьют-Кампании',
  'Сьют-Юрлица', 'Сьют-Объекты', 'Сьют-Чужая', 'Сьют-Смены', 'Сьют-Оборудование',
  'Сьют-', 'DBG ', 'Зонд-', 'Фикс-', 'Проверка-фиксов',
];
const EXACT = [
  'b2b-reach-e2e', 'staff-e2e', 'proc-e2e', 'office-e2e', 'sec-fixes-e2e',
  'crash-test', 'crash-agent', 'ui-check-triggers', 'tg-check', 'palette-check', 'palette2',
  'Вид карточки запуска',
];

async function main() {
  const prisma = new PrismaClient();
  try {
    const doomed = await prisma.workspace.findMany({
      where: ONLY.length
        ? { OR: ONLY.map((p) => ({ name: { startsWith: p } })) }
        : { OR: [...PREFIXES.map((p) => ({ name: { startsWith: p } })), { name: { in: EXACT } }] },
      select: { id: true, name: true },
    });
    if (doomed.length === 0) { console.log('Нечего убирать.'); return; }
    const wsIds = doomed.map((w) => w.id);

    const tasks = await prisma.task.count({ where: { workspaceId: { in: wsIds } } });
    const chats = await prisma.chat.count({ where: { workspaceId: { in: wsIds } } });

    const byName = new Map();
    for (const w of doomed) byName.set(w.name.replace(/[ -]\d{6,}$/, ' *'), (byName.get(w.name.replace(/[ -]\d{6,}$/, ' *')) ?? 0) + 1);
    console.log('Организации под удаление:');
    for (const [n, c] of [...byName].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(4)} × ${n}`);
    console.log(`\nВместе с ними (каскад реестра): задач ${tasks}, чатов организаций ${chats}`);

    if (!APPLY) {
      console.log('\nСухой прогон. Чтобы удалить: node scripts/gc-test-workspaces.cjs --apply');
      return;
    }

    // Архив «давно»: срок архива истёк — ретеншн заберёт их штатным каскадом
    const long = new Date(Date.now() - (WORKSPACE_LIMITS.archiveRetentionDays + 1) * 864e5);
    await prisma.workspace.updateMany({ where: { id: { in: wsIds } }, data: { isActive: false, archivedAt: long } });
    const { token } = await login(SUITE.p1);
    let purged = 0;
    for (;;) {
      const r = await call('POST', '/workspaces/dev/purge-archives', token, { force: true, limit: 25 });
      if (!r.ok) throw new Error(`purge-archives: ${r.status} ${r.code ?? ''}`);
      const n = r.json?.data?.purged ?? 0;
      purged += n;
      if (n === 0) break;
    }
    const left = await prisma.workspace.count({ where: { id: { in: wsIds } } });
    console.log(`\nУдалено каскадом: ${purged}${left ? `; осталось ${left} (под заморозкой или каскад упал — смотрите lifecycle_runs)` : ''}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
