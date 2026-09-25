/* eslint-disable */
// Архив организаций: деактивация → архив → восстановление (владелец).
// Плюс регрессия на счётчик «Пространств» в /users/me: он считает ЖИВЫЕ организации и
// кэшируется в Redis 5 минут — без сброса кэша человек видел «2 Пространств» над
// надписью «У вас пока нет организаций» (реальная жалоба 2026-07-26).
// Плюс идемпотентность переходов (повторный архив не переставляет archivedAt и не пишет
// второе событие) и гейт дев-purge (только своя и только из архива); задания организации в
// архиве уходят из «Ждут решения» и возвращаются с ней; каскад удаления стирает данные
// движков и сервисов (Диск, заметки, файлы, ссылки, гости) и отменяет незакрытые заявки.
// Run (API up): node scripts/verify-workspace-restore.cjs
const { randomUUID } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { BASE, call, login, makeChecker, SUITE, createSuiteWorkspace, sweepSuiteWorkspaces, crash } = require('./_lib.cjs');
const { WORKSPACE_LIMITS } = require('@superapp/shared');
const RETENTION_DAYS = WORKSPACE_LIMITS.archiveRetentionDays;
const PREFIX = 'Сьют-Архив';

const { check, finish } = makeChecker();
const has = (list, id) => list.some((w) => w.id === id);
const count = async (t) => (await call('GET', '/users/me', t)).json?.data?.workspacesCount;
// Бейдж «Ждут решения» источника согласований (счётчик, а не первая страница: стопка
// показывает 50 старейших на источник, и у накопленного аккаунта свежее туда не влезает)
const approvalsWaiting = async (t) => (await call('GET', '/approvals/inbox/count', t)).json?.data?.counts?.approval ?? -1;

/** Файл во владении организации (лого) — настоящий upload: init → content → complete */
async function uploadOrgFile(token, workspaceId) {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const init = await call('POST', '/files', token, { profile: 'avatar', name: 'logo.png', mime: 'image/png', size: bytes.length, ownerWorkspaceId: workspaceId });
  if (!init.ok) return null;
  const id = init.json.data.file.id;
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: 'image/png' }), 'logo.png');
  const put = await fetch(`${BASE}/files/${id}/content`, { method: 'PUT', headers: { Authorization: 'Bearer ' + token }, body: fd });
  if (!put.ok) return null;
  return (await call('POST', `/files/${id}/complete`, token, {})).ok ? id : null;
}

async function main() {
  const prisma = new PrismaClient();
  const s1 = await login(SUITE.p1), s2 = await login(SUITE.p2);
  const t1 = s1.token, t2 = s2.token, u1 = s1.id, u2 = s2.id;
  let wsId = null;
  const archivedEvents = () => prisma.securityEvent.count({ where: { eventKey: 'org.workspace.archived', workspaceId: wsId } });
  const purgeNow = (token, body) => call('POST', '/workspaces/dev/purge-archives', token, body);

  try {
    // Хвост упавшего прогона — в архив ДО замера счётчика (иначе уборка внутри создания его сдвинет)
    await sweepSuiteWorkspaces(t1, PREFIX);
    const before = await count(t1);
    const created = await createSuiteWorkspace(t1, PREFIX);
    check('организация создана', created.ok, `status ${created.status}`);
    wsId = created.json.data.id;

    check('счётчик /users/me вырос сразу (кэш профиля сброшен)', (await count(t1)) === before + 1, `${before} → ${await count(t1)}`);
    check('живая организация — в списке', has((await call('GET', '/workspaces', t1)).json.data, wsId));
    check('живой организации в архиве нет', !has((await call('GET', '/workspaces/archived', t1)).json.data, wsId));

    // ===== Гейт дев-purge: живую не стереть =====
    const purgeLive = await purgeNow(t1, { workspaceId: wsId });
    check('дев-purge живой организации → 400 workspace.notArchived', purgeLive.status === 400 && purgeLive.code === 'workspace.notArchived', `${purgeLive.status} ${purgeLive.code}`);
    const purgeBad = await purgeNow(t1, { workspaceId: 'not-a-uuid' });
    check('дев-purge с кривым id → 400 (строгая схема)', purgeBad.status === 400, `${purgeBad.status}`);
    check('после отказов организация на месте', (await prisma.workspace.count({ where: { id: wsId, isActive: true } })) === 1);

    // ===== Деактивация =====
    const off = await call('DELETE', `/workspaces/${wsId}`, t1);
    check('деактивация владельцем → ok', off.ok, `status ${off.status}`);
    check('из списка пропала', !has((await call('GET', '/workspaces', t1)).json.data, wsId));
    const arch = (await call('GET', '/workspaces/archived', t1)).json.data;
    check('в архиве появилась', has(arch, wsId));
    check('в архиве видно число участников', (arch.find((w) => w.id === wsId)?.membersCount ?? 0) >= 1);
    check('счётчик «Пространств» упал (иначе счётчик врёт про пустой список)', (await count(t1)) === before, `${await count(t1)} vs ${before}`);

    // ===== Повторный архив — не событие =====
    const firstStamp = (await prisma.workspace.findUnique({ where: { id: wsId }, select: { archivedAt: true } }))?.archivedAt;
    const eventsOnce = await archivedEvents();
    await new Promise((r) => setTimeout(r, 30)); // чтобы новый штамп отличался, если бы его поставили
    const offAgain = await call('DELETE', `/workspaces/${wsId}`, t1);
    const secondStamp = (await prisma.workspace.findUnique({ where: { id: wsId }, select: { archivedAt: true } }))?.archivedAt;
    check('повторный архив идемпотентен → ok', offAgain.ok, `status ${offAgain.status}`);
    check('повторный архив не переставил archivedAt (отсчёт ретеншна не сбросился)', !!firstStamp && secondStamp?.getTime() === firstStamp.getTime(), `${firstStamp?.toISOString()} → ${secondStamp?.toISOString()}`);
    check('повторный архив не записал второе событие журнала', eventsOnce === 1 && (await archivedEvents()) === 1, `${eventsOnce} → ${await archivedEvents()}`);

    // ===== Гейт: восстановить может только владелец =====
    check('чужой не видит её в СВОЁМ архиве', !has((await call('GET', '/workspaces/archived', t2)).json.data, wsId));
    check('чужой не может восстановить → 403', (await call('POST', `/workspaces/${wsId}/restore`, t2)).status === 403);
    const purgeForeign = await purgeNow(t2, { workspaceId: wsId });
    check('чужой не может стереть её дев-purge → 403 workspace.ownerOnly', purgeForeign.status === 403 && purgeForeign.code === 'workspace.ownerOnly', `${purgeForeign.status} ${purgeForeign.code}`);

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
    const restoredEvents = () => prisma.securityEvent.count({ where: { eventKey: 'org.workspace.restored', workspaceId: wsId } });
    const restoredOnce = await restoredEvents();
    check('повторное восстановление идемпотентно', (await call('POST', `/workspaces/${wsId}/restore`, t1)).ok);
    check('повторное восстановление не записало второе событие', restoredOnce === 1 && (await restoredEvents()) === 1, `${restoredOnce} → ${await restoredEvents()}`);

    // ===== Несуществующая =====
    check('восстановление несуществующей → 404', (await call('POST', '/workspaces/00000000-0000-0000-0000-000000000000/restore', t1)).status === 404);

    // ===== «Ждут решения»: задания организации в архиве не показываются =====
    // Сервисы выключенной организации закрыты — решить задание нельзя, а место в стопке
    // оно занимало бы. Возврат из архива возвращает задание как было.
    const waitingBefore = await approvalsWaiting(t2);
    const req = await call('POST', '/approvals/dev/request', t1, {
      refId: randomUUID(), title: `${PREFIX} заявка`, workspaceId: wsId,
      steps: [{ order: 0, kind: 'approval', assigneeType: 'user', assigneeId: u2 }],
    });
    check('заявка согласования в организации заведена', req.ok, `${req.status} ${req.code ?? ''}`);
    const approvalReqId = req.json?.data?.id;
    check('задание появилось у согласующего', (await approvalsWaiting(t2)) === waitingBefore + 1, `${waitingBefore} → ${await approvalsWaiting(t2)}`);
    await call('DELETE', `/workspaces/${wsId}`, t1);
    check('организация в архиве — задание из стопки ушло', (await approvalsWaiting(t2)) === waitingBefore, `${await approvalsWaiting(t2)} vs ${waitingBefore}`);
    await call('POST', `/workspaces/${wsId}/restore`, t1);
    check('возврат из архива — задание вернулось', (await approvalsWaiting(t2)) === waitingBefore + 1, `${await approvalsWaiting(t2)}`);

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
    // Предупреждения — СОБЫТИЯ движка (строка ленты схлопывается по организации,
    // а рубежи 7/3/1 различимы только по событиям).
    const warnsOf = () => prisma.notificationEvent.findMany({
      where: { type: 'workspace.archive.expiring', payload: { path: ['workspaceId'], equals: wsId } },
      orderBy: { createdAt: 'asc' },
    });
    // Машина времени сьюта: сдвинуть дату архивации в прошлое (штатного пути нет и не нужно)
    const archivedDaysAgo = (d) => prisma.workspace.update({
      where: { id: wsId },
      data: { isActive: false, archivedAt: new Date(Date.now() - d * 864e5) },
    });
    const sweep = () => purgeNow(t1);

    await archivedDaysAgo(RETENTION_DAYS - 30); // осталось 30 дней — рано
    await sweep();
    check('за 30 дней до удаления не предупреждаем', (await warnsOf()).length === 0);

    await archivedDaysAgo(RETENTION_DAYS - 7); // осталось 7
    await sweep();
    let warns = await warnsOf();
    check('за 7 дней пришло предупреждение', warns.length === 1, `${warns.length}`);
    // Текст рендерится ПРИ ЧТЕНИИ в языке зрителя; событие несёт ДАННЫЕ шаблона —
    // число дней и имя организации. Склонение («дней»/«дня»/«день») — дело каталога.
    check('в событии число дней и имя организации', warns[0]?.payload?.days === 7 && String(warns[0]?.payload?.workspaceName || '').includes(PREFIX), JSON.stringify(warns[0]?.payload));
    // Строка ленты схлопнута по организации и догоняет рубежи цепочкой джобов (воркер
    // опрашивает раз в секунду) — ждём её до 10 с, как waitFor соседних сьютов, и проверяем
    // ПОСЛЕДНИЙ рубеж (склонение «1 день», а не «1 дней»). 4 с не хватало под нагрузкой.
    const feedTitle = async (re) => {
      let last = '';
      for (let i = 0; i < 50; i++) {
        last = String(((await call('GET', '/notifications', t1)).json?.data?.items ?? [])
          .find((r) => r.type === 'workspace.archive.expiring')?.title ?? '');
        if (re.test(last)) return last;
        await new Promise((r) => setTimeout(r, 200));
      }
      return last;
    };
    // Дата в payload — МАШИННАЯ (`purgeDateIso`), слово зрителя собирает рендер (docs/i18n.md)
    check('в событии — дата, после которой не вернуть', /^\d{4}-\d{2}-\d{2}$/.test(String(warns[0]?.payload?.purgeDateIso || '')), String(warns[0]?.payload?.purgeDateIso));
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
    check('во втором — 3 дня', warns[1]?.payload?.days === 3, JSON.stringify(warns[1]?.payload));

    await archivedDaysAgo(RETENTION_DAYS - 1); // остался 1
    await sweep();
    warns = await warnsOf();
    check('за 1 день пришло третье предупреждение', warns.length === 3, `${warns.length}`);
    check('в третьем — 1 день', warns[2]?.payload?.days === 1, JSON.stringify(warns[2]?.payload));
    const lastTitle = await feedTitle(/1\s*день(?!\p{L})/u);
    check('лента склоняет «1 день», а не «1 дней»', /1\s*день(?!\p{L})/u.test(lastTitle), lastTitle);

    await call('POST', `/workspaces/${wsId}/restore`, t1);
    await sweep();
    check('восстановленная организация предупреждений больше не получает', (await warnsOf()).length === 3);

    // Задача организации: голое удаление строки workspaces НЕ убрало бы её (FK стоит на
    // SET NULL) — задача стала бы ЛИЧНОЙ задачей человека. Проверяем, что не стала.
    const task = await call('POST', '/tasks', t1, { title: 'задача архивной орг' });
    const taskId = task.json?.data?.id;
    await prisma.task.update({ where: { id: taskId }, data: { workspaceId: wsId } });
    await prisma.chat.create({ data: { type: 'context', parentType: 'task', parentId: taskId, createdById: u1 } });

    // Данные движков и сервисов без внешнего ключа на организацию — каскад обязан их стереть
    const folder = await call('POST', '/drive/folders', t1, { workspaceId: wsId, name: `${PREFIX} папка` });
    const folderId = folder.json?.data?.id;
    const link = folderId ? await call('POST', '/share-links', t1, { refType: 'drive_node', refId: folderId }) : null;
    const linkId = link?.json?.data?.id;
    const note = await call('POST', '/notes', t1, { workspaceId: wsId, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: PREFIX }] }] } });
    const noteId = note.json?.data?.id;
    const fileId = await uploadOrgFile(t1, wsId);
    // Гость ссылки (имя + номер — ПДн) — фикстурой: SMS-путь гостя проверяет verify-share-links
    const guest = await prisma.shareLinkGuest.create({
      data: { ownerType: 'workspace', ownerId: wsId, phone: `+7700998${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`, name: 'Гость сьюта' },
    });
    check('данные организации для каскада заведены (Диск, ссылка, заметка, файл)', !!folderId && !!linkId && !!noteId && !!fileId, `${folder.status}/${link?.status}/${note.status}/${fileId}`);

    // Просрочиваем архив на день и зовём ретеншн-крон
    await call('DELETE', `/workspaces/${wsId}`, t1);
    await prisma.workspace.update({ where: { id: wsId }, data: { archivedAt: new Date(Date.now() - (RETENTION_DAYS + 1) * 864e5) } });
    const notYet = await prisma.workspace.count({ where: { id: wsId } });
    check('до прогона крона организация ещё на месте', notYet === 1);

    const swept = await sweep();
    check('ретеншн-прогон отработал', swept.ok && swept.json?.data?.purged >= 1, `status ${swept.status}`);

    check('просроченный архив удалён полностью', (await prisma.workspace.count({ where: { id: wsId } })) === 0);
    check('задача организации удалена, а НЕ стала личной', (await prisma.task.count({ where: { id: taskId } })) === 0);
    check('чат задачи удалён вместе с ней', (await prisma.chat.count({ where: { parentType: 'task', parentId: taskId } })) === 0);
    check('роли в удалённой организации сняты', (await prisma.userRole.count({ where: { tenantId: wsId } })) === 0);
    check('рёбра доступа сняты', (await prisma.relationTuple.count({ where: { OR: [{ resourceId: wsId }, { subjectId: wsId }] } })) === 0);
    check('её нет ни в списке, ни в архиве', !has((await call('GET', '/workspaces/archived', t1)).json.data, wsId) && !has((await call('GET', '/workspaces', t1)).json.data, wsId));
    // Первая фаза каскада — данные движков и сервисов
    check('Диск организации стёрт (пространство и узлы)', (await prisma.driveSpace.count({ where: { ownerType: 'workspace', ownerId: wsId } })) === 0 && (await prisma.driveNode.count({ where: { id: folderId } })) === 0);
    check('заметки организации стёрты (пространство и заметки)', (await prisma.noteSpace.count({ where: { ownerType: 'workspace', ownerId: wsId } })) === 0 && (await prisma.note.count({ where: { id: noteId } })) === 0);
    // Организация уходит навсегда — файл сразу физически (строка и байты), а не 7 дней корзины
    check('файл организации стёрт физически (восстанавливать некому)', (await prisma.fileObject.count({ where: { id: fileId } })) === 0);
    check('ссылка наружу отозвана', !!(await prisma.shareLink.findUnique({ where: { id: linkId } }))?.revokedAt);
    check('гости ссылок организации (ПДн) удалены', (await prisma.shareLinkGuest.count({ where: { id: guest.id } })) === 0);
    // FK на организацию у заявки нет: без шага approvals.workspace история решений пережила бы её
    check('заявки согласования организации удалены (живая — сначала отменена)', (await prisma.approvalRequest.count({ where: { id: approvalReqId } })) === 0);
    check('и из стопки согласующего ушла', (await approvalsWaiting(t2)) === waitingBefore, `${await approvalsWaiting(t2)} vs ${waitingBefore}`);
  } finally {
    // Уведомления FK-free (переживают удаление организации) — убираем свои сами,
    // иначе прогоны копят «предупреждения» о давно удалённых тест-организациях.
    // Саму организацию (если прогон упал до её удаления) архивирует finish()/crash().
    if (wsId) await prisma.notificationEvent.deleteMany({ where: { type: 'workspace.archive.expiring', payload: { path: ['workspaceId'], equals: wsId } } }).catch(() => {});
    await prisma.$disconnect();
  }
  finish();
}

main().catch(crash);
