/* eslint-disable */
// OmniDrive («Диск») — сквозная проверка.
//
// Аккаунты СЬЮТА (+7700999000x), не ручные tester1/2/3: сьют по природе стирает
// состояние между прогонами, и на общих аккаунтах это уносило бы живые данные.
// Чистки через deleteMany по userId здесь НЕТ — только дельты и уборка своих объектов
// штатным путём (иначе квота остаётся раздутой, а байты виснут на диске).
//
// Run (API up): node scripts/verify-drive.cjs
const { PrismaClient } = require('@prisma/client');
const { waitForDriveNode } = require('./drive-test-helpers.cjs');
const BASE = 'http://localhost:3001/api';
const P1 = '+77009990001', P2 = '+77009990002', P3 = '+77009990003', PW = 'Test1234!';

let fails = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`);
  if (!ok) fails++;
};

async function call(method, p, token, body, headers) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}

const login = async (phone) => {
  const r = await call('POST', '/auth/login', null, { phone, password: PW });
  if (!r.ok) throw new Error(`login ${phone}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data.accessToken;
};

/** init → PUT → complete (как в verify-files-consumers) */
async function upload(token, { profile = 'drive_file', name, mime, bytes, ownerWorkspaceId }) {
  const init = await call('POST', '/files', token, {
    profile, name, mime, size: bytes.length, ...(ownerWorkspaceId ? { ownerWorkspaceId } : {}),
  });
  if (!init.ok) throw new Error(`init ${name}: ${init.status} ${JSON.stringify(init.json)}`);
  const id = init.json.data.file.id;
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: mime }), name);
  const put = await fetch(`${BASE}/files/${id}/content`, {
    method: 'PUT', headers: { Authorization: 'Bearer ' + token }, body: fd,
  });
  if (!put.ok) throw new Error(`put ${name}: ${put.status}`);
  const done = await call('POST', `/files/${id}/complete`, token, {});
  if (!done.ok) throw new Error(`complete ${name}: ${done.status} ${JSON.stringify(done.json)}`);
  return done.json.data;
}

/** Связь окружения нужна и личному шерингу (personalOnly), и DM */
async function ensureContact(prisma, a, b) {
  const [x, y] = a < b ? [a, b] : [b, a];
  const existing = await prisma.contactLink.findFirst({ where: { userAId: x, userBId: y } });
  if (existing) return;
  await prisma.contactLink.create({
    data: { userAId: x, userBId: y, roleAForB: 'Коллега', roleBForA: 'Коллега', initiatedBy: a },
  });
}

const TXT = (s) => Buffer.from(s, 'utf8');
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2), t3 = await login(P3);
  const u1 = (await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } })).id;
  const u2 = (await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } })).id;
  const stamp = Date.now();
  const created = { nodes: [], files: [], workspaces: [] };
  let wsId = null;

  try {
    // ============================================================
    // 1. Пространство создаётся лениво
    // ============================================================
    const ov = await call('GET', '/drive', t1);
    check('GET /drive отвечает', ov.ok, `status ${ov.status}`);
    const space = ov.json?.data?.space;
    check('личное пространство создано лениво', !!space?.id && space.kind === 'personal');
    check('у пространства есть корень', !!space?.rootId);
    check('владелец видит себя владельцем', space?.access === 'owner');
    check('лимит места — 15 ГБ', ov.json?.data?.limitBytes === 15 * 1024 ** 3, String(ov.json?.data?.limitBytes));

    const ov2 = await call('GET', '/drive', t1);
    check('повторный вызов не плодит пространств', ov2.json?.data?.space?.id === space.id);

    // ============================================================
    // 2. Папки и файлы
    // ============================================================
    const folder = await call('POST', '/drive/folders', t1, { name: `Проект ${stamp}` });
    check('папка создана', folder.ok, `status ${folder.status} ${JSON.stringify(folder.json?.message ?? '')}`);
    const folderId = folder.json?.data?.id;
    created.nodes.push(folderId);

    const dup = await call('POST', '/drive/folders', t1, { name: `Проект ${stamp}` });
    check('одноимённая папка получает суффикс', dup.json?.data?.name === `Проект ${stamp} (2)`, dup.json?.data?.name);
    created.nodes.push(dup.json?.data?.id);

    const f1 = await upload(t1, { name: `отчёт-${stamp}.txt`, mime: 'text/plain', bytes: TXT('привет') });
    created.files.push(f1.id);
    const node1 = await call('POST', '/drive/nodes', t1, { parentId: folderId, fileId: f1.id });
    check('файл положен на Диск', node1.ok, `status ${node1.status} ${JSON.stringify(node1.json?.message ?? '')}`);
    created.nodes.push(node1.json?.data?.id);
    check('у узла есть файл с размером', node1.json?.data?.file?.size === 12, String(node1.json?.data?.file?.size));

    const again = await call('POST', '/drive/nodes', t1, { parentId: folderId, fileId: f1.id });
    check('повторное добавление того же файла не плодит узлов', again.json?.data?.id === node1.json?.data?.id);

    const list = await call('GET', `/drive/nodes?parentId=${folderId}`, t1);
    check('листинг папки отдаёт файл', list.ok && list.json.data.length === 1, `${list.json?.data?.length}`);

    // Папки вперёд файлов
    const sub = await call('POST', '/drive/folders', t1, { parentId: folderId, name: 'Вложенная' });
    created.nodes.push(sub.json?.data?.id);
    const listed = await call('GET', `/drive/nodes?parentId=${folderId}`, t1);
    check('папки идут перед файлами', listed.json?.data?.[0]?.kind === 'folder', listed.json?.data?.[0]?.kind);

    // ============================================================
    // 3. Один файл в двух местах = одни байты
    // ============================================================
    const links = await prisma.fileLink.count({ where: { fileId: f1.id } });
    const objects = await prisma.fileObject.count({ where: { id: f1.id } });
    check('на файл одна строка file_objects', objects === 1);
    check('связь Диска создана (не копия байт)', links === 1, `links=${links}`);

    // ============================================================
    // 4. Переименование и перемещение
    // ============================================================
    const renamed = await call('PATCH', `/drive/nodes/${node1.json.data.id}`, t1, { name: `итог-${stamp}.txt` });
    check('переименование работает', renamed.json?.data?.name === `итог-${stamp}.txt`, renamed.json?.data?.name);

    const moved = await call('POST', '/drive/nodes/move', t1, {
      ids: [node1.json.data.id], parentId: sub.json.data.id,
    });
    check('перемещение работает', moved.json?.data?.moved === 1, JSON.stringify(moved.json));
    const afterMove = await prisma.driveNode.findUnique({ where: { id: node1.json.data.id } });
    check('предки пересчитаны', afterMove.ancestorIds.includes(sub.json.data.id), afterMove.ancestorIds.join(','));
    check('глубина пересчитана', afterMove.depth === 3, String(afterMove.depth));

    // Цикл
    const cycle = await call('POST', '/drive/nodes/move', t1, { ids: [folderId], parentId: sub.json.data.id });
    check('папку внутрь себя переместить нельзя → 400', cycle.status === 400, `status ${cycle.status}`);

    // ============================================================
    // 5. Корзина: вложение живёт до окончательного удаления
    // ============================================================
    const chatFile = await upload(t1, { name: `чат-${stamp}.txt`, mime: 'text/plain', bytes: TXT('в чате') });
    created.files.push(chatFile.id);
    const chatNode = await call('POST', '/drive/nodes', t1, { parentId: folderId, fileId: chatFile.id });
    created.nodes.push(chatNode.json?.data?.id);

    const trashed = await call('POST', '/drive/nodes/trash', t1, { ids: [chatNode.json.data.id] });
    check('в корзину', trashed.json?.data?.trashed === 1, JSON.stringify(trashed.json));
    const fileAfterTrash = await prisma.fileObject.findUnique({ where: { id: chatFile.id }, select: { status: true } });
    check('файл в корзине ЖИВ (вложение в чате работает)', fileAfterTrash.status === 'ready', fileAfterTrash.status);

    const inTrash = await call('GET', '/drive/trash', t1);
    check('объект виден в корзине', (inTrash.json?.data ?? []).some((n) => n.id === chatNode.json.data.id));

    const listAfterTrash = await call('GET', `/drive/nodes?parentId=${folderId}`, t1);
    check('из листинга пропал', !(listAfterTrash.json?.data ?? []).some((n) => n.id === chatNode.json.data.id));

    const restored = await call('POST', '/drive/nodes/restore', t1, { ids: [chatNode.json.data.id] });
    check('восстановление работает', restored.json?.data?.restored === 1, JSON.stringify(restored.json));

    // Окончательное удаление гасит файл везде
    await call('POST', '/drive/nodes/trash', t1, { ids: [chatNode.json.data.id] });
    const purged = await call('DELETE', '/drive/nodes', t1, { ids: [chatNode.json.data.id] });
    check('удаление навсегда', purged.json?.data?.purged === 1, JSON.stringify(purged.json));
    const fileAfterPurge = await prisma.fileObject.findUnique({ where: { id: chatFile.id }, select: { status: true } });
    check('после окончательного удаления файл погас ВЕЗДЕ', fileAfterPurge?.status === 'deleted', fileAfterPurge?.status);
    const linksAfterPurge = await prisma.fileLink.count({ where: { fileId: chatFile.id } });
    check('связь Диска снята (файл не защищён мёртвым узлом)', linksAfterPurge === 0, `links=${linksAfterPurge}`);

    // ============================================================
    // 6. Права: чужой не видит
    // ============================================================
    const alien = await call('GET', `/drive/nodes?parentId=${folderId}`, t2);
    check('чужой не читает мою папку → 403', alien.status === 403, `status ${alien.status}`);
    const alienNode = await call('GET', `/drive/nodes/${folderId}`, t2);
    check('чужой не открывает мой объект', alienNode.status === 403 || alienNode.status === 404, `status ${alienNode.status}`);

    // ============================================================
    // 7. Шеринг человеку + наследование вглубь
    // ============================================================
    // Связь окружения нужна для личного шеринга (personalOnly)
    await ensureContact(prisma, u1, u2);

    const shared = await call('POST', `/drive/nodes/${folderId}/shares`, t1, {
      principalType: 'user', principalId: u2, role: 'viewer',
    });
    check('шеринг человеку', shared.ok, `status ${shared.status} ${JSON.stringify(shared.json?.message ?? '')}`);

    const alienNow = await call('GET', `/drive/nodes?parentId=${folderId}`, t2);
    check('после шеринга папка читается', alienNow.ok, `status ${alienNow.status}`);
    const deepNode = await call('GET', `/drive/nodes/${node1.json.data.id}`, t2);
    check('наследование вглубь: виден файл во вложенной папке', deepNode.ok, `status ${deepNode.status}`);
    check('унаследованная роль — просмотр', deepNode.json?.data?.access === 'viewer', deepNode.json?.data?.access);

    const alienRename = await call('PATCH', `/drive/nodes/${node1.json.data.id}`, t2, { name: 'взлом.txt' });
    check('зритель не может переименовать → 403', alienRename.status === 403, `status ${alienRename.status}`);

    const sharedSpaces = await call('GET', '/drive', t2);
    check('пространство появилось в «Доступно мне»',
      (sharedSpaces.json?.data?.sharedWithMe ?? []).some((s) => s.id === space.id));

    // Понижение/повышение роли не оставляет старую строку
    await call('POST', `/drive/nodes/${folderId}/shares`, t1, {
      principalType: 'user', principalId: u2, role: 'editor',
    });
    const tuples = await prisma.relationTuple.count({
      where: { resourceType: 'drive_node', resourceId: folderId, subjectType: 'user', subjectId: u2 },
    });
    check('смена роли не плодит гранты', tuples === 1, `tuples=${tuples}`);
    const editorRename = await call('PATCH', `/drive/nodes/${node1.json.data.id}`, t2, { name: `правка-${stamp}.txt` });
    check('редактор может переименовать', editorRename.ok, `status ${editorRename.status}`);

    // Третий по-прежнему не видит
    const third = await call('GET', `/drive/nodes/${folderId}`, t3);
    check('посторонний по-прежнему не видит', third.status === 403 || third.status === 404, `status ${third.status}`);

    // Отзыв
    await call('DELETE', `/drive/nodes/${folderId}/shares/user/${u2}`, t1);
    const afterRevoke = await call('GET', `/drive/nodes/${folderId}`, t2);
    check('после отзыва доступ пропал', afterRevoke.status === 403 || afterRevoke.status === 404, `status ${afterRevoke.status}`);

    // ============================================================
    // 8. Отзыв при разрыве связи окружения
    // ============================================================
    await call('POST', `/drive/nodes/${folderId}/shares`, t1, {
      principalType: 'user', principalId: u2, role: 'viewer',
    });
    check('доступ выдан повторно', (await call('GET', `/drive/nodes/${folderId}`, t2)).ok);
    const blockRes = await call('POST', '/contacts/blocks', t1, { userId: u2 });
    check('блокировка выполнена', blockRes.ok || blockRes.status === 409, `status ${blockRes.status}`);
    const afterUnlink = await call('GET', `/drive/nodes/${folderId}`, t2);
    check('разрыв связи снял грант Диска', afterUnlink.status === 403 || afterUnlink.status === 404, `status ${afterUnlink.status}`);
    await call('DELETE', `/contacts/blocks/${u2}`, t1);

    // ============================================================
    // 9. Версии
    // ============================================================
    const vTarget = node1.json.data.id;
    const v1 = await call('POST', `/drive/nodes/${vTarget}/versions`, t1);
    check('версия сохранена', v1.ok && v1.json?.data?.versionNo === 1, `status ${v1.status} no=${v1.json?.data?.versionNo}`);
    if (v1.json?.data?.fileId) created.files.push(v1.json.data.fileId);
    const vList = await call('GET', `/drive/nodes/${vTarget}/versions`, t1);
    check('версия в списке', (vList.json?.data ?? []).length === 1, String(vList.json?.data?.length));
    const restore = await call('POST', `/drive/nodes/${vTarget}/versions/${v1.json.data.id}/restore`, t1);
    check('возврат версии работает', restore.ok && restore.json?.data?.versionNo === 1, `status ${restore.status}`);
    const vList2 = await call('GET', `/drive/nodes/${vTarget}/versions`, t1);
    check('перед возвратом текущее уехало в историю', (vList2.json?.data ?? []).length === 2, String(vList2.json?.data?.length));

    // ============================================================
    // 10. Копия (оригинал остаётся)
    // ============================================================
    const copyRes = await call('POST', '/drive/nodes/copy', t1, {
      ids: [node1.json.data.id], parentId: folderId,
    });
    check('копирование файла', copyRes.json?.data?.copied === 1, JSON.stringify(copyRes.json));
    const srcAlive = await prisma.driveNode.findUnique({ where: { id: node1.json.data.id } });
    check('оригинал остался на месте', !!srcAlive && !srcAlive.trashedAt);
    const copies = await prisma.driveNode.findMany({ where: { parentId: folderId, kind: 'file' } });
    check('у копии СВОЙ файл (новые байты, своя квота)',
      copies.length === 1 && copies[0].fileId !== node1.json.data.file?.id, `copies=${copies.length}`);
    for (const c of copies) { created.nodes.push(c.id); if (c.fileId) created.files.push(c.fileId); }

    // ============================================================
    // 11. Избранное
    // ============================================================
    await call('POST', `/drive/nodes/${folderId}/star`, t1);
    const starred = await call('GET', '/drive/starred', t1);
    check('избранное работает', (starred.json?.data ?? []).some((n) => n.id === folderId));
    await call('DELETE', `/drive/nodes/${folderId}/star`, t1);
    const starred2 = await call('GET', '/drive/starred', t1);
    check('из избранного убирается', !(starred2.json?.data ?? []).some((n) => n.id === folderId));

    // ============================================================
    // 12. Валидация имён
    // ============================================================
    const badName = await call('POST', '/drive/folders', t1, { name: 'плохая/папка' });
    check('слэш в имени отклоняется → 400', badName.status === 400, `status ${badName.status}`);
    const angle = await call('POST', '/drive/folders', t1, { name: '<script>' });
    check('угловые скобки отклоняются → 400', angle.status === 400, `status ${angle.status}`);

    // ============================================================
    // 13. Файлы из переписки: DM → ВСЕГДА личный диск
    // ============================================================
    // Блокировка выше УДАЛИЛА связь окружения (продуктовое правило), а разблокировка
    // её не возвращает — восстанавливаем фикстуру, иначе DM отдаст 403.
    await ensureContact(prisma, u1, u2);
    const dm = await call('POST', '/messenger/chats/dm', t1, { userId: u2 });
    check('DM создан', dm.ok, `status ${dm.status}`);
    const dmFile = await upload(t1, {
      profile: 'chat_attachment', name: `дм-${stamp}.txt`, mime: 'text/plain', bytes: TXT('из лички'),
    });
    created.files.push(dmFile.id);
    const dmMsg = await call('POST', `/messenger/chats/${dm.json.data.id}/messages/attachments`, t1, {
      fileIds: [dmFile.id],
    });
    check('вложение отправлено в DM', dmMsg.ok, `status ${dmMsg.status}`);
    const dmNode = await waitForDriveNode(prisma, dmFile.id);
    check('свой файл из DM сам появился на Диске', !!dmNode);
    if (dmNode) {
      created.nodes.push(dmNode.id);
      const dmSpace = await prisma.driveSpace.findUnique({ where: { id: dmNode.spaceId } });
      check('из ЛИЧНОЙ переписки — на личный диск', dmSpace.ownerType === 'user' && dmSpace.ownerId === u1,
        `${dmSpace.ownerType}:${dmSpace.ownerId === u1}`);
      const parent = await prisma.driveNode.findUnique({ where: { id: dmNode.parentId } });
      check('в системной папке «Файлы из переписки»', parent?.systemKey === 'chat_uploads', parent?.systemKey);
    }

    // Чужая загрузка на мой Диск не попадает
    const alienUp = await upload(t2, {
      profile: 'chat_attachment', name: `чужой-${stamp}.txt`, mime: 'text/plain', bytes: TXT('чужое'),
    });
    created.files.push(alienUp.id);
    await call('POST', `/messenger/chats/${dm.json.data.id}/messages/attachments`, t2, { fileIds: [alienUp.id] });
    const alienNodes = await waitForDriveNode(prisma, alienUp.id, 3000);
    const alienSpace = alienNodes ? await prisma.driveSpace.findUnique({ where: { id: alienNodes.spaceId } }) : null;
    check('чужая загрузка не легла на МОЙ диск',
      !alienNodes || alienSpace.ownerId !== u1, alienSpace ? alienSpace.ownerId : 'нет узла');
    if (alienNodes) created.nodes.push(alienNodes.id);

    // ============================================================
    // 14. Диск организации: маршрутизация, лестница ролей, строгость папок
    // ============================================================
    const ws = await call('POST', '/workspaces', t1, { name: `drive-e2e ${stamp}` });
    check('организация создана', ws.ok, `status ${ws.status}`);
    wsId = ws.json?.data?.id;
    created.workspaces.push(wsId);
    // Сотрудник — фикстурой напрямую (как в соседних сьютах). Вместе с ролью пишем и
    // ребро в core/access: при настоящем найме его создаёт проекция (staff → member),
    // и без него команда не совпала бы с корневым грантом диска организации.
    await prisma.workspaceMember.create({ data: { workspaceId: wsId, userId: u2 } });
    await prisma.userRole.create({
      data: { userId: u2, role: 'staff', context: 'workspace', tenantId: wsId },
    });
    await prisma.relationTuple.create({
      data: {
        resourceType: 'workspace', resourceId: wsId, relation: 'member',
        subjectType: 'user', subjectId: u2, subjectRelation: '',
      },
    });

    const wsDrive = await call('GET', `/drive?workspaceId=${wsId}`, t1);
    check('диск организации создаётся лениво', wsDrive.ok && wsDrive.json.data.space.kind === 'workspace',
      `status ${wsDrive.status}`);
    const wsSpace = wsDrive.json.data.space;
    check('лимит организации — 100 ГБ', wsDrive.json?.data?.limitBytes === 100 * 1024 ** 3);

    // Лестница ролей: корневой грант выдан @workspace#member, владелец организации — owner
    const staffView = await call('GET', `/drive?workspaceId=${wsId}`, t2);
    check('рядовой сотрудник видит диск организации', staffView.ok, `status ${staffView.status}`);
    check('владелец организации распоряжается диском', wsSpace.access === 'owner', wsSpace.access);
    const rootTuples = await prisma.relationTuple.findMany({
      where: { resourceType: 'drive_node', resourceId: wsSpace.rootId },
      select: { relation: true, subjectRelation: true },
    });
    check('корень открыт команде грантом на @workspace#member',
      rootTuples.some((t) => t.relation === 'editor' && t.subjectRelation === 'member'),
      JSON.stringify(rootTuples));

    // Задача организации → её диск
    const wsTask = await call('POST', '/tasks', t1, { title: `Диск ${stamp}` }, { 'X-Workspace-Id': wsId });
    check('задача организации создана', wsTask.ok, `status ${wsTask.status}`);
    const taskFile = await upload(t1, {
      profile: 'chat_attachment', name: `задача-${stamp}.txt`, mime: 'text/plain', bytes: TXT('рабочее'),
      ownerWorkspaceId: wsId,
    });
    created.files.push(taskFile.id);
    await call('POST', `/tasks/${wsTask.json.data.id}/attachments`, t1, { fileId: taskFile.id });
    const taskNode = await waitForDriveNode(prisma, taskFile.id);
    check('файл задачи организации сам лёг на ЕЁ диск',
      !!taskNode && taskNode.spaceId === wsSpace.id, taskNode ? taskNode.spaceId : 'нет узла');
    if (taskNode) created.nodes.push(taskNode.id);

    // Строгость: файл в закрытой папке недоступен рядовому по прямой ссылке
    const secret = await call('POST', '/drive/folders', t1, { workspaceId: wsId, name: `Зарплаты ${stamp}` });
    check('закрытая папка создана', secret.ok, `status ${secret.status}`);
    created.nodes.push(secret.json?.data?.id);
    // Снимаем унаследованный доступ команды: папка живёт под корнем, поэтому
    // закрываем её переносом гранта — грант корня отзываем и выдаём точечно.
    await prisma.relationTuple.deleteMany({
      where: { resourceType: 'drive_node', resourceId: wsSpace.rootId, relation: 'editor', subjectRelation: 'member' },
    });
    const secretFile = await upload(t1, {
      profile: 'drive_file', name: `оклады-${stamp}.txt`, mime: 'text/plain', bytes: TXT('секрет'),
      ownerWorkspaceId: wsId,
    });
    created.files.push(secretFile.id);
    const secretNode = await call('POST', '/drive/nodes', t1, {
      workspaceId: wsId, parentId: secret.json.data.id, fileId: secretFile.id,
    });
    check('файл положен в закрытую папку', secretNode.ok, `status ${secretNode.status}`);
    created.nodes.push(secretNode.json?.data?.id);

    const staffDownload = await call('GET', `/files/${secretFile.id}/download`, t2);
    check('рядовой НЕ скачает файл из закрытой папки организации → 403',
      staffDownload.status === 403, `status ${staffDownload.status}`);
    const ownerDownload = await call('GET', `/files/${secretFile.id}/download`, t1);
    check('владелец скачивает его же', ownerDownload.ok, `status ${ownerDownload.status}`);

    // Вернём общий грант и проверим, что общая зона по-прежнему видна
    await call('POST', `/drive/nodes/${wsSpace.rootId}/shares`, t1, {
      principalType: 'workspace', principalId: wsId, role: 'editor',
    });
    const openFolder = await call('GET', `/drive/nodes?parentId=${wsSpace.rootId}`, t2);
    check('после возврата гранта общая зона снова читается командой', openFolder.ok, `status ${openFolder.status}`);

    // ============================================================
    // 15. Поиск по Диску
    // ============================================================
    const uniq = `квартальный${stamp}`;
    const searchable = await call('POST', '/drive/folders', t1, { name: uniq });
    created.nodes.push(searchable.json?.data?.id);
    let found = null;
    for (let i = 0; i < 10 && !found; i++) {
      const res = await call('GET', `/search?q=${encodeURIComponent(uniq)}&type=drive_node`, t1);
      found = (res.json?.data?.items ?? []).find((x) => x.id === searchable.json.data.id);
      if (!found) await new Promise((r) => setTimeout(r, 300));
    }
    check('папка находится поиском', !!found);
    const alienSearch = await call('GET', `/search?q=${encodeURIComponent(uniq)}&type=drive_node`, t3);
    check('чужой её не находит (трим по правам в SQL)',
      !(alienSearch.json?.data?.items ?? []).some((x) => x.id === searchable.json.data.id));

    // ============================================================
    // 16. Лента «Фото»
    // ============================================================
    const photo = await upload(t1, {
      profile: 'drive_file', name: `снимок-${stamp}.png`, mime: 'image/png', bytes: PNG_1PX,
    });
    created.files.push(photo.id);
    const photoNode = await call('POST', '/drive/nodes', t1, { parentId: folderId, fileId: photo.id });
    check('снимок положен на Диск', photoNode.ok, `status ${photoNode.status}`);
    created.nodes.push(photoNode.json?.data?.id);

    let indexed = null;
    for (let i = 0; i < 25 && !indexed; i++) {
      const row = await prisma.driveNode.findUnique({ where: { id: photoNode.json.data.id } });
      if (row?.takenAtLocal) indexed = row;
      else await new Promise((r) => setTimeout(r, 400));
    }
    check('снимку проставлена дата съёмки (джоб drive.photo.index)', !!indexed);
    const buckets = await call('GET', '/drive/photos/buckets', t1);
    check('счётчики по месяцам отдаются', buckets.ok && (buckets.json.data ?? []).length > 0, `status ${buckets.status}`);
    const photoPage = await call('GET', '/drive/photos', t1);
    check('страница ленты — колоночная', photoPage.ok && Array.isArray(photoPage.json?.data?.id), `status ${photoPage.status}`);
    check('в ленте есть наш снимок', (photoPage.json?.data?.id ?? []).includes(photoNode.json.data.id));
    const idx = (photoPage.json?.data?.id ?? []).indexOf(photoNode.json.data.id);
    check('у плитки есть соотношение сторон', idx >= 0 && typeof photoPage.json.data.ratio[idx] === 'number');
    check('ссылка на миниатюру подписана сервером (без запроса на плитку)',
      idx >= 0 && photoPage.json.data.url[idx] !== undefined);

    // ============================================================
    // 17. Регрессии ревью (2026-08-01)
    // ============================================================

    // -- 17.1 Чужой fileId не превращается в узел на своём Диске --
    // Знание чужого id (он остаётся у всех, кто когда-то имел доступ) давало полный
    // набор: прочитать, переписать через core/docs и уничтожить у владельца везде.
    const priv = await upload(t1, {
      profile: 'drive_file', name: `личный-${stamp}.txt`, mime: 'text/plain', bytes: TXT('только мой'),
    });
    created.files.push(priv.id);
    const privNode = await call('POST', '/drive/nodes', t1, { parentId: folderId, fileId: priv.id });
    created.nodes.push(privNode.json?.data?.id);
    const steal = await call('POST', '/drive/nodes', t3, { fileId: priv.id });
    check('чужой fileId нельзя положить себе на Диск → 404', steal.status === 404, `status ${steal.status}`);
    const stealRead = await call('GET', `/files/${priv.id}/download`, t3);
    check('и сам файл остался недоступен',
      stealRead.status === 403 || stealRead.status === 404, `status ${stealRead.status}`);

    // -- 17.2 Чужой, но ВИДИМЫЙ файл сохраняется копией, а не связью --
    // Иначе моё «удалить навсегда» гасило бы чужие байты во всех чатах и задачах.
    const savedAlien = await call('POST', '/drive/nodes', t2, { fileId: taskFile.id });
    check('видимый чужой файл сохраняется КОПИЕЙ',
      savedAlien.ok && savedAlien.json?.data?.file?.id && savedAlien.json.data.file.id !== taskFile.id,
      `status ${savedAlien.status} file=${savedAlien.json?.data?.file?.id}`);
    if (savedAlien.ok) {
      created.files.push(savedAlien.json.data.file.id);
      await call('DELETE', '/drive/nodes', t2, { ids: [savedAlien.json.data.id] });
      const origin = await prisma.fileObject.findUnique({
        where: { id: taskFile.id }, select: { status: true },
      });
      check('оригинал пережил удаление копии', origin?.status === 'ready', origin?.status);
    }

    // -- 17.3 Шеринг только на СВОИХ принципалов --
    const alienCircle = await call('POST', '/circles', t2, { name: `чужая-${stamp}` });
    const ownCircle = await call('POST', '/circles', t1, { name: `своя-${stamp}` });
    const badCircle = await call('POST', `/drive/nodes/${folderId}/shares`, t1, {
      principalType: 'circle', principalId: alienCircle.json?.data?.id, role: 'editor',
    });
    check('шеринг на ЧУЖУЮ Группу отклонён → 400', badCircle.status === 400, `status ${badCircle.status}`);
    const goodCircle = await call('POST', `/drive/nodes/${folderId}/shares`, t1, {
      principalType: 'circle', principalId: ownCircle.json?.data?.id, role: 'viewer',
    });
    check('на СВОЮ Группу доступ выдаётся', goodCircle.ok, `status ${goodCircle.status}`);
    if (goodCircle.ok) {
      await call('DELETE', `/drive/nodes/${folderId}/shares/circle/${ownCircle.json.data.id}`, t1);
    }
    const circleOnWs = await call('POST', `/drive/nodes/${wsSpace.rootId}/shares`, t1, {
      principalType: 'circle', principalId: ownCircle.json?.data?.id, role: 'viewer',
    });
    check('личная Группа на диск организации не пускается → 400',
      circleOnWs.status === 400, `status ${circleOnWs.status}`);
    const alienDept = await call('POST', `/drive/nodes/${wsSpace.rootId}/shares`, t1, {
      principalType: 'department', principalId: '00000000-0000-4000-8000-000000000000', role: 'viewer',
    });
    check('отдел не из этой организации отклонён → 400', alienDept.status === 400, `status ${alienDept.status}`);
    const alienWs = await call('POST', `/drive/nodes/${folderId}/shares`, t1, {
      principalType: 'workspace', principalId: wsId, role: 'viewer',
    });
    check('«вся команда» на ЛИЧНЫЙ диск не пускается → 400', alienWs.status === 400, `status ${alienWs.status}`);
    for (const c of [alienCircle, ownCircle]) {
      if (c.ok) await call('DELETE', `/circles/${c.json.data.id}`, c === alienCircle ? t2 : t1);
    }

    // -- 17.4 Удаление навсегда на диске организации — только управляющему --
    const wsFolder = await call('POST', '/drive/folders', t1, { workspaceId: wsId, name: `общая-${stamp}` });
    created.nodes.push(wsFolder.json?.data?.id);
    const staffTrash = await call('POST', '/drive/nodes/trash', t2, { ids: [wsFolder.json.data.id] });
    check('рядовой может отправить в корзину', staffTrash.ok, `status ${staffTrash.status}`);
    const staffPurge = await call('DELETE', '/drive/nodes', t2, { ids: [wsFolder.json.data.id] });
    check('рядовой НЕ удаляет навсегда на диске организации → 403',
      staffPurge.status === 403, `status ${staffPurge.status}`);
    const ownerPurge = await call('DELETE', '/drive/nodes', t1, { ids: [wsFolder.json.data.id] });
    check('владелец организации — удаляет', ownerPurge.ok, `status ${ownerPurge.status}`);

    // -- 17.5 «Недавние» наполняются --
    await call('GET', `/drive/nodes/${folderId}`, t1);
    const recent = await call('GET', '/drive/recent', t1);
    check('«Недавние» наполняются при открытии объекта',
      (recent.json?.data ?? []).some((n) => n.id === folderId), `отдано ${recent.json?.data?.length ?? '?'}`);

    // -- 17.6 Сортировка по размеру не обрывается на папке с неизвестным размером --
    // subtree_bytes = NULL это сентинел пересчёта, а не ноль: раньше курсор кодировал
    // его как «0», и следующая страница просила `< 0`, то есть ничего.
    const pag = await call('POST', '/drive/folders', t1, { name: `пагинация-${stamp}` });
    created.nodes.push(pag.json?.data?.id);
    const kids = [];
    for (const n of ['а', 'б', 'в']) {
      const k = await call('POST', '/drive/folders', t1, { parentId: pag.json.data.id, name: `${n}-${stamp}` });
      kids.push(k.json.data.id);
      created.nodes.push(k.json.data.id);
    }
    await prisma.driveNode.update({ where: { id: kids[1] }, data: { subtreeBytes: null, subtreeFiles: null } });
    let sizeCursor = null, sizeSeen = [], guard = 0;
    do {
      const p = await call(
        'GET',
        `/drive/nodes?parentId=${pag.json.data.id}&sort=size&dir=desc&limit=1` +
          (sizeCursor ? `&cursor=${encodeURIComponent(sizeCursor)}` : ''),
        t1,
      );
      for (const n of p.json?.data ?? []) sizeSeen.push(n.id);
      sizeCursor = p.json?.nextCursor ?? null;
    } while (sizeCursor && ++guard < 10);
    check('сортировка по размеру отдаёт всю папку целиком',
      kids.every((id) => sizeSeen.includes(id)), `отдано ${sizeSeen.length} из 3`);

    // -- 17.7 Корзина не теряет объекты, удалённые одной пачкой --
    // Пакетное удаление ставит всем ОДИН `now`, и курсор «строго раньше» перепрыгивал
    // бы через весь остаток пачки.
    const batch = [];
    for (const n of ['к1', 'к2', 'к3']) {
      const f = await call('POST', '/drive/folders', t1, { name: `${n}-корзина-${stamp}` });
      batch.push(f.json.data.id);
      created.nodes.push(f.json.data.id);
    }
    await call('POST', '/drive/nodes/trash', t1, { ids: batch });
    let trashCursor = null, trashSeen = [], tGuard = 0;
    do {
      const p = await call(
        'GET',
        `/drive/trash?limit=1${trashCursor ? `&cursor=${encodeURIComponent(trashCursor)}` : ''}`,
        t1,
      );
      for (const n of p.json?.data ?? []) trashSeen.push(n.id);
      trashCursor = p.json?.nextCursor ?? null;
    } while (trashCursor && ++tGuard < 40);
    check('корзина не теряет объекты, удалённые одной пачкой',
      batch.every((id) => trashSeen.includes(id)),
      `нашлось ${batch.filter((id) => trashSeen.includes(id)).length} из 3`);
  } finally {
    // ---- Уборка: только СВОИ объекты и штатным путём ----
    const alive = await prisma.driveNode.findMany({
      where: { id: { in: created.nodes.filter(Boolean) } },
      select: { id: true },
    });
    if (alive.length) {
      await call('POST', '/drive/nodes/trash', t1, { ids: alive.map((n) => n.id) }).catch(() => {});
      await call('DELETE', '/drive/nodes', t1, { ids: alive.map((n) => n.id) }).catch(() => {});
    }
    for (const fileId of [...new Set(created.files.filter(Boolean))]) {
      await call('DELETE', `/files/${fileId}`, t1).catch(() => {});
    }
    // Организацию убираем ЗА СОБОЙ: у владельца потолок в 20 штук, и брошенные
    // организации сьюта роняли бы соседние прогоны. Задачи удаляем ПЕРВЫМИ —
    // tasks.workspace_id стоит на SET NULL, и голое удаление превратило бы их в
    // личные задачи человека.
    for (const id of created.workspaces.filter(Boolean)) {
      await prisma.task.deleteMany({ where: { workspaceId: id } }).catch(() => {});
      await prisma.driveSpace.deleteMany({ where: { ownerType: 'workspace', ownerId: id } }).catch(() => {});
      await prisma.userRole.deleteMany({ where: { context: 'workspace', tenantId: id } }).catch(() => {});
      await prisma.relationTuple.deleteMany({ where: { resourceType: 'workspace', resourceId: id } }).catch(() => {});
      await prisma.workspace.delete({ where: { id } }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
  if (fails > 0) process.exit(1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
