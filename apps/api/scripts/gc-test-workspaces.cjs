/* eslint-disable */
// Уборка организаций, оставшихся от verify-скриптов и ручных демо-прогонов.
//
//   node scripts/gc-test-workspaces.cjs           — сухой прогон (только показывает)
//   node scripts/gc-test-workspaces.cjs --apply   — удалить
//
// Зачем отдельный скрипт, а не DELETE по таблице workspaces: у организации 18 таблиц с
// workspace_id, и каскад настроен лишь у семи. Ключевая ловушка — `tasks.workspace_id`
// стоит на **SET NULL**: голое удаление организации не убирает её задачи, а превращает
// их в ЛИЧНЫЕ задачи человека, то есть мусор переезжает на видное место. Ещё десять
// таблиц (процессы, хроника, звонки, tuples доступа, роли) FK не имеют вовсе — их
// строки просто повисли бы навсегда.
//
// НЕ трогаем осознанно: счета/валюты кошелька, магазины и книги финансов, принадлежащие
// этим организациям. Они невидимы, когда организации нет, а журнал двойной записи —
// неизменяемый (удаление счёта ломает инвариант Σ=0 и ночную сверку WalletCron).
//
// ⚠️ Тот же каскад живёт в `WorkspacesService.purgeWorkspace` (ретеншн архива, 90 дней) —
// это ИСТОЧНИК ПРАВДЫ. Скрипт повторяет его сырым Prisma, потому что .cjs не поднимает
// Nest-граф. Появится новая таблица с workspace_id — править ОБА места.
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');

// Имена, которые генерят сами скрипты и демо-прогоны в браузере. Всё остальное —
// организации человека, их не трогаем.
// ⚠️ Новый verify-скрипт, создающий организацию, ОБЯЗАН добавить сюда своё имя:
// иначе за 20 прогонов упирается потолок «20 организаций на владельца», и падать
// начинают ЧУЖИЕ сьюты, а не свой (verify-documents уже так ложился на пустом месте).
const PREFIXES = [
  'ТестКорп ', 'fin-e2e-', 'chatter-e2e-', 'Ф1-Лого ', 'Демо', 'Журнал-демо',
  'docs-ws-', 'Сьют-ЭДО', 'Сьют-Контрагенты',
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
      where: { OR: [...PREFIXES.map((p) => ({ name: { startsWith: p } })), { name: { in: EXACT } }] },
      select: { id: true, name: true },
    });
    if (doomed.length === 0) { console.log('Нечего убирать.'); return; }
    const wsIds = doomed.map((w) => w.id);

    const tasks = await prisma.task.findMany({ where: { workspaceId: { in: wsIds } }, select: { id: true } });
    const taskIds = tasks.map((t) => t.id);
    const rooms = await prisma.officeRoom.findMany({ where: { workspaceId: { in: wsIds } }, select: { id: true } });
    const roomIds = rooms.map((r) => r.id);
    const chats = await prisma.chat.findMany({
      where: {
        OR: [
          { parentType: 'task', parentId: { in: taskIds } },
          { parentType: 'office_room', parentId: { in: roomIds } },
        ],
      },
      select: { id: true },
    });
    const chatIds = chats.map((c) => c.id);
    const refIds = [...wsIds, ...taskIds];

    const byName = new Map();
    for (const w of doomed) byName.set(w.name.replace(/[ -]\d{6,}$/, ' *'), (byName.get(w.name.replace(/[ -]\d{6,}$/, ' *')) ?? 0) + 1);
    console.log('Организации под удаление:');
    for (const [n, c] of [...byName].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(4)} × ${n}`);
    console.log(`\nВместе с ними: задач ${taskIds.length} (иначе стали бы личными), чатов ${chatIds.length}, комнат офиса ${roomIds.length}`);

    if (!APPLY) {
      console.log('\nСухой прогон. Чтобы удалить: node scripts/gc-test-workspaces.cjs --apply');
      return;
    }

    const n = await prisma.$transaction(async (tx) => {
      const out = {};
      out.searchDocs = (await tx.searchDocument.deleteMany({ where: { chatId: { in: chatIds } } })).count;
      out.chats = (await tx.chat.deleteMany({ where: { id: { in: chatIds } } })).count; // каскад: сообщения, участники, отложенные
      out.chatter = (await tx.chatterEntry.deleteMany({
        where: { OR: [{ workspaceId: { in: wsIds } }, { refType: 'task', refId: { in: taskIds } }] },
      })).count;
      out.tasks = (await tx.task.deleteMany({ where: { id: { in: taskIds } } })).count; // каскад: участники, теги
      out.procInstances = (await tx.processInstance.deleteMany({ where: { workspaceId: { in: wsIds } } })).count;
      out.procDefs = (await tx.processDefinition.deleteMany({ where: { workspaceId: { in: wsIds } } })).count;
      out.procTriggers = (await tx.processTrigger.deleteMany({ where: { workspaceId: { in: wsIds } } })).count;
      out.procCreds = (await tx.processCredential.deleteMany({ where: { workspaceId: { in: wsIds } } })).count;
      out.recordings = (await tx.callRecording.deleteMany({ where: { workspaceId: { in: wsIds } } })).count;
      out.callSessions = (await tx.callSession.deleteMany({ where: { workspaceId: { in: wsIds } } })).count;
      out.resources = (await tx.resource.deleteMany({ where: { workspaceId: { in: wsIds } } })).count;
      out.tuples = (await tx.relationTuple.deleteMany({
        where: { OR: [{ resourceId: { in: refIds } }, { subjectId: { in: refIds } }] },
      })).count;
      out.roles = (await tx.userRole.deleteMany({ where: { tenantId: { in: wsIds } } })).count;
      out.workspaces = (await tx.workspace.deleteMany({ where: { id: { in: wsIds } } })).count; // каскад: члены, приглашения, справочники, назначения, комнаты
      return out;
    }, { timeout: 120000 });

    console.log('\nУдалено:');
    for (const [k, v] of Object.entries(n)) if (v > 0) console.log(`  ${k.padEnd(14)} ${v}`);
    const left = await prisma.task.count({ where: { workspaceId: { in: wsIds } } });
    console.log(left === 0 ? '\nПроверка: задач-сирот не осталось.' : `\n⚠ осталось задач: ${left}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
