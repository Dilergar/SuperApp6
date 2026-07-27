/* eslint-disable */
// Архив организаций: деактивация → архив → восстановление (владелец).
// Плюс регрессия на счётчик «Пространств» в /users/me: он считает ЖИВЫЕ организации и
// кэшируется в Redis 5 минут — без сброса кэша человек видел «2 Пространств» над
// надписью «У вас пока нет организаций» (реальная жалоба 2026-07-26).
// Run (API up): node scripts/verify-workspace-restore.cjs
const { PrismaClient } = require('@prisma/client');
const BASE = 'http://localhost:3001/api';
const P1 = '+77009990001', P2 = '+77009990002', PW = 'Test1234!';
const { WORKSPACE_LIMITS } = require('@superapp/shared');
const RETENTION_DAYS = WORKSPACE_LIMITS.archiveRetentionDays;

let fails = 0;
const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };
async function call(method, p, token, body) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}: ${r.status}`); return r.json.data.accessToken; };
const has = (list, id) => list.some((w) => w.id === id);
const count = async (t) => (await call('GET', '/users/me', t)).json?.data?.workspacesCount;

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2);
  const u2 = (await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } })).id;
  let wsId = null;

  try {
    const before = await count(t1);
    const created = await call('POST', '/workspaces', t1, { name: `restore-e2e ${Date.now()}` });
    check('организация создана', created.ok, `status ${created.status}`);
    wsId = created.json.data.id;

    check('счётчик /users/me вырос сразу (кэш профиля сброшен)', (await count(t1)) === before + 1, `${before} → ${await count(t1)}`);
    check('живая организация — в списке', has((await call('GET', '/workspaces', t1)).json.data, wsId));
    check('живой организации в архиве нет', !has((await call('GET', '/workspaces/archived', t1)).json.data, wsId));

    // ===== Деактивация =====
    const off = await call('DELETE', `/workspaces/${wsId}`, t1);
    check('деактивация владельцем → ok', off.ok, `status ${off.status}`);
    check('из списка пропала', !has((await call('GET', '/workspaces', t1)).json.data, wsId));
    const arch = (await call('GET', '/workspaces/archived', t1)).json.data;
    check('в архиве появилась', has(arch, wsId));
    check('в архиве видно число участников', (arch.find((w) => w.id === wsId)?.membersCount ?? 0) >= 1);
    check('счётчик «Пространств» упал (иначе счётчик врёт про пустой список)', (await count(t1)) === before, `${await count(t1)} vs ${before}`);

    // ===== Гейт: восстановить может только владелец =====
    check('чужой не видит её в СВОЁМ архиве', !has((await call('GET', '/workspaces/archived', t2)).json.data, wsId));
    check('чужой не может восстановить → 403', (await call('POST', `/workspaces/${wsId}/restore`, t2)).status === 403);

    // Участник (не владелец) — фикстура напрямую, как в соседних сьютах
    await prisma.workspaceMember.create({ data: { workspaceId: wsId, userId: u2 } });
    await prisma.userRole.create({ data: { userId: u2, role: 'staff', context: 'workspace', tenantId: wsId } });
    check('участник (не владелец) не может восстановить → 403', (await call('POST', `/workspaces/${wsId}/restore`, t2)).status === 403);
    check('участник не видит её в своём архиве (архив — только владельца)', !has((await call('GET', '/workspaces/archived', t2)).json.data, wsId));

    // ===== Восстановление =====
    const on = await call('POST', `/workspaces/${wsId}/restore`, t1);
    check('восстановление владельцем → ok', on.ok, `status ${on.status}`);
    check('вернулась в список', has((await call('GET', '/workspaces', t1)).json.data, wsId));
    check('из архива ушла', !has((await call('GET', '/workspaces/archived', t1)).json.data, wsId));
    check('счётчик снова вырос', (await count(t1)) === before + 1, `${await count(t1)}`);
    check('роль владельца сохранилась', (await call('GET', `/workspaces/${wsId}`, t1)).json?.data?.myRole === 'owner');
    check('повторное восстановление идемпотентно', (await call('POST', `/workspaces/${wsId}/restore`, t1)).ok);

    // ===== Несуществующая =====
    check('восстановление несуществующей → 404', (await call('POST', '/workspaces/00000000-0000-0000-0000-000000000000/restore', t1)).status === 404);

    // ===== Ретеншн архива: дата удаления и полная уборка =====
    await call('DELETE', `/workspaces/${wsId}`, t1);
    const row = await prisma.workspace.findUnique({ where: { id: wsId }, select: { archivedAt: true } });
    check('деактивация ставит дату архивации', !!row?.archivedAt);
    const card = (await call('GET', '/workspaces/archived', t1)).json.data.find((w) => w.id === wsId);
    const expectedPurge = new Date(new Date(card.archivedAt).getTime() + RETENTION_DAYS * 864e5).toISOString();
    check('в архиве отдаётся дата полного удаления', card?.purgeAt === expectedPurge, `${card?.purgeAt}`);
    check('до удаления ~90 дней', Math.round((new Date(card.purgeAt) - Date.now()) / 864e5) === RETENTION_DAYS);

    await call('POST', `/workspaces/${wsId}/restore`, t1);
    const restored = await prisma.workspace.findUnique({ where: { id: wsId }, select: { archivedAt: true } });
    check('возврат из архива снимает дату (отсчёт не тикает у живой)', restored?.archivedAt === null);

    // ===== Предупреждения за 7 / 3 / 1 день =====
    const u1 = (await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } })).id;
    const warnsOf = () => prisma.notification.findMany({
      where: { userId: u1, type: 'workspace.archive.expiring', payload: { path: ['workspaceId'], equals: wsId } },
      orderBy: { createdAt: 'asc' },
    });
    const archivedDaysAgo = (d) => prisma.workspace.update({
      where: { id: wsId },
      data: { isActive: false, archivedAt: new Date(Date.now() - d * 864e5) },
    });
    const sweep = () => call('POST', '/workspaces/dev/purge-archives', t1);

    await archivedDaysAgo(RETENTION_DAYS - 30); // осталось 30 дней — рано
    await sweep();
    check('за 30 дней до удаления не предупреждаем', (await warnsOf()).length === 0);

    await archivedDaysAgo(RETENTION_DAYS - 7); // осталось 7
    await sweep();
    let warns = await warnsOf();
    check('за 7 дней пришло предупреждение', warns.length === 1, `${warns.length}`);
    check('в тексте склонённый срок и имя организации', /через 7 дней/.test(warns[0]?.title || '') && (warns[0]?.title || '').includes('restore-e2e'), warns[0]?.title);
    check('в теле — дата, после которой не вернуть', /после \d{2}\.\d{2}\.\d{4}/.test(warns[0]?.body || ''), warns[0]?.body);
    check('дип-линк ведёт на дашборд', warns[0]?.actionUrl === '/dashboard');

    await sweep();
    check('повторный прогон НЕ дублирует тот же рубеж', (await warnsOf()).length === 1);

    await archivedDaysAgo(RETENTION_DAYS - 5); // осталось 5 — всё ещё рубеж «7»
    await sweep();
    check('на 5 днях нового письма нет (рубеж 7 уже отправлен)', (await warnsOf()).length === 1);

    await archivedDaysAgo(RETENTION_DAYS - 3); // осталось 3
    await sweep();
    warns = await warnsOf();
    check('за 3 дня пришло второе предупреждение', warns.length === 2, `${warns.length}`);
    check('во втором — «через 3 дня»', /через 3 дня/.test(warns[1]?.title || ''), warns[1]?.title);

    await archivedDaysAgo(RETENTION_DAYS - 1); // остался 1
    await sweep();
    warns = await warnsOf();
    check('за 1 день пришло третье предупреждение', warns.length === 3, `${warns.length}`);
    check('в третьем — «через 1 день», а не «1 дней»', /через 1 день(?!\w)/.test(warns[2]?.title || ''), warns[2]?.title);

    await call('POST', `/workspaces/${wsId}/restore`, t1);
    await sweep();
    check('восстановленная организация предупреждений больше не получает', (await warnsOf()).length === 3);

    // Задача организации: голое удаление строки workspaces НЕ убрало бы её (FK стоит на
    // SET NULL) — задача стала бы ЛИЧНОЙ задачей человека. Проверяем, что не стала.
    const task = await call('POST', '/tasks', t1, { title: 'задача архивной орг' });
    const taskId = task.json?.data?.id;
    await prisma.task.update({ where: { id: taskId }, data: { workspaceId: wsId } });
    await prisma.chat.create({ data: { type: 'context', parentType: 'task', parentId: taskId, createdById: u1 } });

    // Просрочиваем архив на день и зовём ретеншн-крон
    await call('DELETE', `/workspaces/${wsId}`, t1);
    await prisma.workspace.update({ where: { id: wsId }, data: { archivedAt: new Date(Date.now() - (RETENTION_DAYS + 1) * 864e5) } });
    const notYet = await prisma.workspace.count({ where: { id: wsId } });
    check('до прогона крона организация ещё на месте', notYet === 1);

    const swept = await call('POST', '/workspaces/dev/purge-archives', t1);
    check('ретеншн-прогон отработал', swept.ok && swept.json?.data?.purged >= 1, `status ${swept.status}`);

    check('просроченный архив удалён полностью', (await prisma.workspace.count({ where: { id: wsId } })) === 0);
    check('задача организации удалена, а НЕ стала личной', (await prisma.task.count({ where: { id: taskId } })) === 0);
    check('чат задачи удалён вместе с ней', (await prisma.chat.count({ where: { parentType: 'task', parentId: taskId } })) === 0);
    check('роли в удалённой организации сняты', (await prisma.userRole.count({ where: { tenantId: wsId } })) === 0);
    check('рёбра доступа сняты', (await prisma.relationTuple.count({ where: { OR: [{ resourceId: wsId }, { subjectId: wsId }] } })) === 0);
    check('её нет ни в списке, ни в архиве', !has((await call('GET', '/workspaces/archived', t1)).json.data, wsId) && !has((await call('GET', '/workspaces', t1)).json.data, wsId));
    // Уведомления FK-free (переживают удаление организации) — убираем за собой сами,
    // иначе прогоны копят «предупреждения» о давно удалённых тест-организациях.
    await prisma.notification.deleteMany({ where: { type: 'workspace.archive.expiring', payload: { path: ['workspaceId'], equals: wsId } } }).catch(() => {});
    wsId = null; // организация уже удалена — finally нечего прибирать
  } finally {
    if (wsId) {
      await prisma.notification.deleteMany({ where: { type: 'workspace.archive.expiring', payload: { path: ['workspaceId'], equals: wsId } } }).catch(() => {});
      await prisma.userRole.deleteMany({ where: { tenantId: wsId } }).catch(() => {});
      await prisma.relationTuple.deleteMany({ where: { OR: [{ resourceId: wsId }, { subjectId: wsId }] } }).catch(() => {});
      await prisma.workspace.delete({ where: { id: wsId } }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log(fails === 0 ? '\nALL PASS' : `\nFAILED: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
