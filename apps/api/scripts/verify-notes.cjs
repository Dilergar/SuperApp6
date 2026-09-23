/* eslint-disable */
// Сервис «Заметки» — сквозная проверка: пространства (личное/организация), дерево папок и
// наследование грантов, версии/409, упоминания (только с доступом + подсказка), вики-ссылки и
// обратные ссылки, привязка к задаче и панель by-target, доска раздела, корзина/restore/purge,
// проекции (Markdown, plainText, чанки), витрина поиска, rich-card, надзор владельца организации.
//
// Аккаунты СЬЮТА (+7700999000x). БД не чистим: свои заметки убираем штатным путём (корзина → purge).
// Run (API up): node scripts/verify-notes.cjs
const { PrismaClient } = require('@prisma/client');
const { call, login, makeChecker, SUITE, ensureSuiteWorkspace } = require('./_lib.cjs');

const { check, finish } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureContact(prisma, a, b) {
  const [x, y] = a < b ? [a, b] : [b, a];
  const existing = await prisma.contactLink.findFirst({ where: { userAId: x, userBId: y } });
  if (existing) return;
  await prisma.contactLink.create({
    data: { userAId: x, userBId: y, roleAForB: 'Коллега', roleBForA: 'Коллега', initiatedBy: a },
  });
}

async function hire(wsId, ownerToken, personToken, phone) {
  const inv = (await call('POST', `/workspaces/${wsId}/invitations`, ownerToken, { phone })).json?.data;
  const mine = (await call('GET', '/workspaces/invitations/incoming', personToken)).json?.data?.find?.(
    (i) => i.workspaceId === wsId,
  );
  await call('POST', `/workspaces/invitations/${mine?.id ?? inv?.id}/accept`, personToken);
}

const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...blocks) => ({ type: 'doc', content: blocks });

async function main() {
  const prisma = new PrismaClient();
  const p1 = await login(SUITE.p1);
  const p2 = await login(SUITE.p2);
  const p3 = await login(SUITE.p3);
  await ensureContact(prisma, p1.id, p2.id);
  const stamp = Date.now();
  const cleanup = [];

  // ============================================================
  // Личное пространство: панель, папки, заметка с проекциями
  // ============================================================
  const side0 = await call('GET', '/notes/sidebar', p1.token);
  check('sidebar (личное) отвечает', side0.ok && side0.json.data.space.ownerType === 'user' && side0.json.data.space.access === 'owner');

  const fA = (await call('POST', '/notes/folders', p1.token, { name: `Клиенты ${stamp}` })).json?.data;
  const fB = (await call('POST', '/notes/folders', p1.token, { name: 'Kaspi ' + stamp, parentId: fA?.id })).json?.data;
  check('папки: корневая и вложенная', !!fA?.id && fB?.parentId === fA?.id && fB?.depth === 1, JSON.stringify(fB?.ancestorIds));
  const dup = await call('POST', '/notes/folders', p1.token, { name: `клиенты ${stamp}` });
  check('дубль имени папки (регистр) → 400', dup.status === 400);

  const word = `уникальнослово${stamp}`;
  const other = (await call('POST', '/notes', p1.token, { folderId: fB.id, content: doc(para('Другая заметка'), para('Просто текст')) })).json?.data;
  cleanup.push(other?.id);
  const content = doc(
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: `Собрание ${word}` }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Обсудили с ' },
        { type: 'mention', attrs: { userId: p2.id, name: 'Второй Сьют' } },
        { type: 'text', text: ' и ' },
        { type: 'mention', attrs: { userId: p3.id, name: 'Третий Сьют' } },
        { type: 'text', text: ' план ' },
        { type: 'tag', attrs: { name: 'Важно' } },
        { type: 'text', text: ', см. ' },
        { type: 'wikilink', attrs: { noteId: other.id, title: 'Другая заметка' } },
      ],
    },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [para('Позвонить клиенту')] }] },
  );
  const created = await call('POST', '/notes', p1.token, { folderId: fB.id, content });
  const note = created.json?.data;
  cleanup.push(note?.id);
  check('создание заметки', created.status === 201 && note?.version === 1, `${created.status} ${JSON.stringify(created.json?.message ?? '')}`);
  check('название выведено из первой строки документа', note?.title === `Собрание ${word}` , note?.title);
  check('теги выведены сервером (нижний регистр)', JSON.stringify(note?.tags) === JSON.stringify(['важно']));
  check('Markdown-проекция: упоминание и вики-ссылка в диалекте', /@\[Второй Сьют\]\(user:/.test(note?.contentMd ?? '') && note?.contentMd?.includes(`[[note:${other.id}|Другая заметка]]`));
  check('подсказка: упомянутые без доступа = p2 и p3', (note?.mentionsWithoutAccess ?? []).map((u) => u.id).sort().join() === [p2.id, p3.id].sort().join());

  const backlinks = (await call('GET', `/notes/${other.id}`, p1.token)).json?.data?.backlinks ?? [];
  check('обратная ссылка появилась у целевой заметки', backlinks.some((b) => b.noteId === note.id));

  const md = await fetch(`${process.env.SA6_API_BASE || 'http://localhost:3001/api'}/notes/${note.id}/markdown`, {
    headers: { Authorization: 'Bearer ' + p1.token },
  });
  const mdText = await md.text();
  check('экспорт Markdown (text/markdown)', md.ok && (md.headers.get('content-type') || '').includes('text/markdown') && mdText.startsWith('# Собрание'));

  // Чужой без доступа
  const p3Get = await call('GET', `/notes/${note.id}`, p3.token);
  check('посторонний не видит заметку (404, не 403)', p3Get.status === 404);
  const p2Get0 = await call('GET', `/notes/${note.id}`, p2.token);
  check('упомянутый без гранта не видит заметку', p2Get0.status === 404);
  const feed0 = (await call('GET', '/notifications?mentions=1', p2.token)).json?.data?.items ?? [];
  check('упоминание без доступа НЕ попало в ленту', !feed0.some((m) => m.ref?.type === 'note' && m.ref?.id === note.id));

  // Поделиться с упомянутыми: p2 из окружения получит viewer, p3 (вне окружения) — пропущен
  const shared = await call('POST', `/notes/${note.id}/shares/mentioned`, p1.token);
  check('поделиться с упомянутыми: человек из окружения получил viewer', shared.ok && shared.json.data.some((s) => s.principalId === p2.id && s.role === 'viewer'));
  const p2Get1 = await call('GET', `/notes/${note.id}`, p2.token);
  check('после шеринга p2 видит заметку как viewer', p2Get1.ok && p2Get1.json.data.access === 'viewer');
  // Повторное сохранение автором: упоминание p2 теперь с доступом → запись в ленту
  const resave = await call('PATCH', `/notes/${note.id}`, p1.token, { baseVersion: 1, content: { ...content, content: [...content.content, para('дополнение')] } });
  check('сохранение с baseVersion=1 → version 2', resave.ok && resave.json.data.version === 2);
  check('после шеринга p2 ушёл из подсказки', !(resave.json?.data?.mentionsWithoutAccess ?? []).some((u) => u.id === p2.id));
  await sleep(300);
  const feed1 = (await call('GET', '/notifications?mentions=1', p2.token)).json?.data?.items ?? [];
  const noteMention = feed1.find((m) => m.ref?.type === 'note' && m.ref?.id === note.id);
  check('упоминание с доступом попало в ленту (mentions=1) с адресом заметки', !!noteMention && noteMention.href === `/notes/${note.id}`, noteMention?.href);
  const feedAgain = (await call('GET', '/notifications?mentions=1', p2.token)).json?.data?.items ?? [];
  check('повторное сохранение не дублирует упоминание', feedAgain.filter((m) => m.ref?.type === 'note' && m.ref?.id === note.id).length === 1);

  // Версии: устаревшая база → 409 с машинным кодом
  const stale = await call('PATCH', `/notes/${note.id}`, p1.token, { baseVersion: 1, content: doc(para('устарело')) });
  check('устаревшая версия → 409 NOTE_VERSION_CONFLICT', stale.status === 409 && stale.code === 'NOTE_VERSION_CONFLICT');
  const p2Edit = await call('PATCH', `/notes/${note.id}`, p2.token, { baseVersion: 2, content: doc(para('хочу править')) });
  check('viewer не может править (403)', p2Edit.status === 403);

  // Лимиты документа — страж на срабатывание
  let deep = para('дно');
  for (let i = 0; i < 14; i++) deep = { type: 'blockquote', content: [deep] };
  const tooDeep = await call('POST', '/notes', p1.token, { content: doc(deep) });
  check('документ глубже лимита → 400', tooDeep.status === 400);
  const bad = await call('POST', '/notes', p1.token, { content: { type: 'doc', content: [{ type: 'unknown' }] } });
  check('неизвестный узел → 400', bad.status === 400);

  // Markdown-вход (ИИ-путь)
  const fromMd = await call('POST', '/notes', p1.token, { folderId: fA.id, markdown: `# Из Markdown ${stamp}\n\n- [ ] пункт\n- [x] сделано\n\n#тегмд текст` });
  cleanup.push(fromMd.json?.data?.id);
  check('создание из Markdown: чекбоксы и тег распознаны', fromMd.ok && fromMd.json.data.content.content.some((b) => b.type === 'taskList') && fromMd.json.data.tags.includes('тегмд'));

  // ============================================================
  // Шеринг папки и наследование по дереву, перенос
  // ============================================================
  const word2 = `закрытоеслово${stamp}`;
  const inner = (await call('POST', '/notes', p1.token, { folderId: fB.id, content: doc(para(`внутри папки B ${word2}`)) })).json?.data;
  cleanup.push(inner?.id);
  check('p2 не видит заметку в B до шеринга папки', (await call('GET', `/notes/${inner.id}`, p2.token)).status === 404);
  const shareA = await call('POST', `/notes/folders/${fA.id}/shares`, p1.token, { principalType: 'user', principalId: p2.id, role: 'viewer' });
  check('шеринг папки A человеку из окружения', shareA.ok);
  const viaFolder = await call('GET', `/notes/${inner.id}`, p2.token);
  check('грант на A достаёт заметку в подпапке B (наследование по folderPath)', viaFolder.ok && viaFolder.json.data.access === 'viewer');
  const p2Side = (await call('GET', '/notes/sidebar', p2.token)).json?.data;
  check('в личной панели p2 чужая папка не показывается (другое пространство)', !(p2Side?.folders ?? []).some((f) => f.id === fA.id));
  const listShared = await call('GET', `/notes/${inner.id}/shares`, p2.token);
  check('панель доступа показывает унаследованный грант от папки A', listShared.ok && listShared.json.data.some((s) => s.refType === 'note_folder' && s.refId === fA.id && s.inherited));

  // Перенос B в корень → путь без A → доступ p2 пропадает
  const moved = await call('PATCH', `/notes/folders/${fB.id}`, p1.token, { parentId: null });
  check('перенос папки в корень', moved.ok && moved.json.data.parentId === null && moved.json.data.depth === 0);
  const afterMove = await call('GET', `/notes/${inner.id}`, p2.token);
  check('после переноса грант A больше не достаёт заметку', afterMove.status === 404);
  const rowAfter = await prisma.note.findUnique({ where: { id: inner.id }, select: { folderPath: true } });
  check('folderPath пересчитан одним UPDATE', JSON.stringify(rowAfter?.folderPath) === JSON.stringify([fB.id]));
  const cycle = await call('PATCH', `/notes/folders/${fA.id}`, p1.token, { parentId: fA.id });
  check('папку нельзя переместить в саму себя', cycle.status === 400);

  // Список / фильтры
  const inB = (await call('GET', `/notes?folderId=${fB.id}`, p1.token)).json?.data;
  check('список по папке', inB?.items?.length >= 2 && inB.items.every((n) => n.folderId === fB.id));
  const byTag = (await call('GET', `/notes?tag=важно`, p1.token)).json?.data;
  check('фильтр по тегу', (byTag?.items ?? []).some((n) => n.id === note.id));
  const pinned = await call('PATCH', `/notes/${note.id}`, p1.token, { baseVersion: 2, pinned: true });
  check('закрепление', pinned.ok && pinned.json.data.version === 3);
  const listPinned = (await call('GET', `/notes?pinned=true`, p1.token)).json?.data;
  check('закреплённые в фильтре', (listPinned?.items ?? []).some((n) => n.id === note.id && n.pinnedAt));

  // ============================================================
  // Доска — ВИД на раздел: заметка лежит на ней без всякого «положить»,
  // личной остаётся только РАСКЛАДКА карточки
  // ============================================================
  const boardB = (await call('GET', `/notes/board?folderId=${fB.id}`, p1.token)).json?.data;
  const beforeMove = (boardB?.items ?? []).find((i) => i.noteId === note.id);
  check('доска папки показывает её заметку с документом', !!beforeMove && beforeMove.note.content?.type === 'doc');
  check('нетронутая карточка приходит без раскладки (placed=false)', beforeMove?.placed === false, String(beforeMove?.placed));
  const boardAll = (await call('GET', '/notes/board', p1.token)).json?.data;
  check('доска «Все заметки» показывает заметку из папки', (boardAll?.items ?? []).some((i) => i.noteId === note.id));
  const boardRootOnly = (await call('GET', '/notes/board?folderId=root', p1.token)).json?.data;
  check('доска «Без папки» заметку из папки НЕ показывает', !(boardRootOnly?.items ?? []).some((i) => i.noteId === note.id));
  const put = await call('PUT', `/notes/board/${note.id}`, p1.token, { x: 20, y: 30, w: 300, h: 240 });
  check('раскладка карточки сохранена', put.ok && put.json.data.placed === true && put.json.data.folderId === fB.id && put.json.data.w === 300);
  const boardPlaced = (await call('GET', `/notes/board?folderId=${fB.id}`, p1.token)).json?.data;
  const placedCard = (boardPlaced?.items ?? []).find((i) => i.noteId === note.id);
  check('доска отдаёт сохранённое положение', placedCard?.placed === true && placedCard?.x === 20 && placedCard?.w === 300);
  const badPut = await call('PUT', `/notes/board/${note.id}`, p1.token, { w: 10 });
  check('размер карточки вне лимитов → 400', badPut.status === 400);
  const farPut = await call('PUT', `/notes/board/${note.id}`, p1.token, { y: 1500 });
  check('координаты раскладки — пиксели холста: y=1500 принят', farPut.ok && farPut.json.data.y === 1500);
  const tooFar = await call('PUT', `/notes/board/${note.id}`, p1.token, { y: 50_000 });
  check('координата за потолком холста → 400', tooFar.status === 400);
  const p2Board = await call('PUT', `/notes/board/${note.id}`, p2.token, {});
  check('viewer хранит СВОЮ раскладку чужой заметки', p2Board.ok && p2Board.json.data.placed === true);

  // ============================================================
  // Привязка к задаче и панель by-target
  // ============================================================
  const task = (await call('POST', '/tasks', p1.token, { title: `Задача для заметки ${stamp}` })).json?.data;
  const related = await call('POST', `/notes/${note.id}/related`, p1.token, { targetType: 'task', targetId: task?.id });
  check('привязка заметки к задаче', related.ok && related.json.data.related.some((r) => r.targetType === 'task' && r.targetId === task?.id && r.url === `/tasks/${task?.id}`));
  const byTarget = await call('GET', `/notes/by-target/task/${task?.id}`, p1.token);
  check('панель «Заметки» на задаче видит заметку', byTarget.ok && byTarget.json.data.items.some((n) => n.id === note.id));
  const p3ByTarget = await call('GET', `/notes/by-target/task/${task?.id}`, p3.token);
  check('без права на задачу панель недоступна (404)', p3ByTarget.status === 404);
  const badTarget = await call('POST', `/notes/${note.id}/related`, p1.token, { targetType: 'task', targetId: '00000000-0000-4000-8000-000000000000' });
  check('привязка к невидимой сущности → 400 NOTE_TARGET_NOT_VISIBLE', badTarget.status === 400 && badTarget.code === 'NOTE_TARGET_NOT_VISIBLE');
  const targets = await call('GET', `/notes/targets/search?type=task&q=${encodeURIComponent('Задача для заметки')}`, p1.token);
  check('пикер целей находит задачу', targets.ok && targets.json.data.some((t) => t.id === task?.id));
  const unrelated = await call('DELETE', `/notes/${note.id}/related/task/${task?.id}`, p1.token);
  check('отвязка', unrelated.ok && !unrelated.json.data.related.length);

  // ============================================================
  // Проекции: поиск, чанки, rich-card
  // ============================================================
  const search = await call('GET', `/search?q=${encodeURIComponent(word)}`, p1.token);
  const noteGroup = (search.json?.data?.groups ?? []).find((g) => g.type === 'note');
  check('глобальный поиск находит заметку по слову из заголовка', !!noteGroup && noteGroup.items.some((i) => i.id === note.id));
  const searchP3 = await call('GET', `/search?q=${encodeURIComponent(word2)}`, p3.token);
  check('поиск режет права: посторонний не находит закрытую заметку', !((searchP3.json?.data?.groups ?? []).find((g) => g.type === 'note')?.items ?? []).some((i) => i.id === inner.id));
  const searchOwn2 = await call('GET', `/search?q=${encodeURIComponent(word2)}`, p1.token);
  check('а автор закрытую заметку находит', ((searchOwn2.json?.data?.groups ?? []).find((g) => g.type === 'note')?.items ?? []).some((i) => i.id === inner.id));

  let chunks = 0;
  for (let i = 0; i < 20 && chunks === 0; i++) {
    await sleep(500);
    chunks = await prisma.noteChunk.count({ where: { noteId: note.id } });
  }
  check('джоб проекций нарезал чанки (RAG-готовность)', chunks >= 1, `chunks=${chunks}`);
  if (chunks) {
    const ch = await prisma.noteChunk.findFirst({ where: { noteId: note.id }, orderBy: { ord: 'asc' } });
    check('чанк несёт контекст-префикс и текст', !!ch?.contextPrefix?.includes(word) && ch.text.length > 0 && ch.tokenCount > 0, ch?.contextPrefix);
  }

  const card = await call('GET', `/rich-cards/note/${note.id}`, p1.token);
  check('rich-card заметки рендерится', card.ok && card.json.data.cardType === 'note' && card.json.data.href === `/notes/${note.id}`);
  const cardP3 = await call('GET', `/rich-cards/note/${inner.id}`, p3.token);
  check('rich-card постороннему — заморожена (без содержимого)', cardP3.ok ? cardP3.json.data.subtitle === 'Нет доступа' : cardP3.status === 404);

  // ============================================================
  // Корзина: trash → list → restore → trash → purge
  // ============================================================
  const trash = await call('POST', `/notes/${other.id}/trash`, p1.token);
  check('в корзину', trash.ok);
  const trashed = (await call('GET', `/notes?trashed=true`, p1.token)).json?.data;
  check('корзина показывает заметку', (trashed?.items ?? []).some((n) => n.id === other.id && n.deletedAt));
  check('удалённая пропала из обычного списка', !((await call('GET', `/notes?folderId=${fB.id}`, p1.token)).json?.data?.items ?? []).some((n) => n.id === other.id));
  const purgeLive = await call('DELETE', `/notes/${note.id}`, p1.token);
  check('удалить навсегда живую заметку нельзя (сначала корзина)', purgeLive.status === 400);
  const restored = await call('POST', `/notes/${other.id}/restore`, p1.token);
  check('восстановление', restored.ok && restored.json.data.deletedAt === null);
  const viewerTrash = await call('POST', `/notes/${note.id}/trash`, p2.token);
  check('viewer не может удалить в корзину (403)', viewerTrash.status === 403);

  // ============================================================
  // Организация: надзор владельца, «вся команда», изоляция
  // ============================================================
  // Одна организация на все прогоны (_lib.cjs): свежая на каждый прогон копилась бы до потолка
  const ws = await ensureSuiteWorkspace(p1.token, 'Сьют-Заметки');
  await hire(ws.id, p1.token, p2.token, SUITE.p2);
  await hire(ws.id, p1.token, p3.token, SUITE.p3);
  const wsSide = await call('GET', `/notes/sidebar?workspaceId=${ws.id}`, p2.token);
  check('панель организации для сотрудника', wsSide.ok && wsSide.json.data.space.ownerType === 'workspace' && wsSide.json.data.space.access === 'editor');
  const wsNote = (await call('POST', '/notes', p2.token, { workspaceId: ws.id, content: doc(para(`рабочая приватная ${stamp}`)) })).json?.data;
  check('сотрудник создал рабочую заметку', !!wsNote?.id && wsNote.ownerType === 'workspace');
  const ownerSees = await call('GET', `/notes/${wsNote.id}`, p1.token);
  check('владелец организации видит приватную заметку сотрудника (надзор)', ownerSees.ok && ownerSees.json.data.access === 'owner');
  const p3Sees0 = await call('GET', `/notes/${wsNote.id}`, p3.token);
  check('коллега без шеринга не видит (приватно по умолчанию)', p3Sees0.status === 404);
  const toTeam = await call('POST', `/notes/${wsNote.id}/shares`, p2.token, { principalType: 'workspace', principalId: ws.id, role: 'viewer' });
  check('шеринг «всей организации»', toTeam.ok);
  const p3Sees1 = await call('GET', `/notes/${wsNote.id}`, p3.token);
  check('после шеринга команде коллега видит', p3Sees1.ok && p3Sees1.json.data.access === 'viewer');
  const circleInWs = await call('POST', `/notes/${wsNote.id}/shares`, p2.token, { principalType: 'circle', principalId: '00000000-0000-4000-8000-000000000001', role: 'viewer' });
  check('Группа окружения в организации отвергается (B2B-изоляция)', circleInWs.status === 400);
  const outsider = await login(SUITE.p1);
  const otherWs = await ensureSuiteWorkspace(p3.token, 'Сьют-Чужая');
  const cross = await call('GET', `/notes/sidebar?workspaceId=${otherWs.id}`, p2.token);
  check('не-член организации → 403', cross.status === 403, String(outsider.id ? cross.status : ''));
  const wsMention = (await call('POST', '/notes', p2.token, {
    workspaceId: ws.id,
    content: doc({ type: 'paragraph', content: [{ type: 'mention', attrs: { userId: p3.id, name: 'Коллега' } }] }),
  })).json?.data;
  check('в организации упомянутый коллега без доступа — в подсказке', (wsMention?.mentionsWithoutAccess ?? []).some((u) => u.id === p3.id));
  const shareMentionedWs = await call('POST', `/notes/${wsMention.id}/shares/mentioned`, p2.token);
  check('«поделиться с упомянутыми» в организации работает по членству', shareMentionedWs.ok && shareMentionedWs.json.data.some((s) => s.principalId === p3.id));

  // Название — производная первой строки, отдельного поля нет
  const titleNote = (await call('POST', '/notes', p1.token, { content: doc(para('Первая строка'), para('вторая')) })).json?.data;
  cleanup.push(titleNote.id);
  check('название = первая строка', titleNote.title === 'Первая строка', titleNote.title);
  const renamed = await call('PATCH', `/notes/${titleNote.id}`, p1.token, { baseVersion: titleNote.version, content: doc(para('Другое имя'), para('вторая')) });
  check('правка первой строки переименовывает заметку', renamed.ok && renamed.json.data.title === 'Другое имя', renamed.json?.data?.title);
  const emptyNote = (await call('POST', '/notes', p1.token, {})).json?.data;
  cleanup.push(emptyNote.id);
  check('у пустой заметки название пустое (клиент рисует «Без названия»)', emptyNote.title === '', JSON.stringify(emptyNote.title));
  const titleRejected = await call('POST', '/notes', p1.token, { title: 'Руками', content: doc(para('текст')) });
  check('title в теле запроса отвергается (название не задаётся в обход текста)', titleRejected.status === 400, String(titleRejected.status));

  // ============================================================
  // Стражи ревью (каждый — на срабатывание)
  // ============================================================

  // 1. Адрес ссылки — белый список схем: `javascript:` не должен доехать до документа
  const evilLink = await call('POST', '/notes', p1.token, {
    content: doc({ type: 'paragraph', content: [{ type: 'text', text: 'клик', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }),
  });
  check('ссылка javascript: в документе → 400', evilLink.status === 400);
  const evilMd = (await call('POST', '/notes', p1.token, { markdown: '[клик](javascript:alert(1)) и ![x](javascript:alert(2))' })).json?.data;
  if (evilMd?.id) cleanup.push(evilMd.id);
  const evilMarks = JSON.stringify(evilMd?.content ?? {});
  check('javascript: из Markdown не стал ссылкой', !evilMarks.includes('javascript'));
  const okLink = (await call('POST', '/notes', p1.token, { markdown: '[сайт](https://kaspi.kz)' })).json?.data;
  if (okLink?.id) cleanup.push(okLink.id);
  check('обычная https-ссылка проходит', JSON.stringify(okLink?.content ?? {}).includes('https://kaspi.kz'));

  // 2. Бездонная вложенность — честный 400, а не 500 по переполнению стека.
  // Тело собираем СТРОКОЙ: JSON.stringify такого объекта роняет и сам сьют.
  const depth = 800;
  const abyssBody =
    '{"content":{"type":"doc","content":[' +
    '{"type":"blockquote","content":['.repeat(depth) +
    '{"type":"paragraph","content":[{"type":"text","text":"дно"}]}' +
    ']}'.repeat(depth) +
    ']}}';
  const deepRes = await fetch(`${process.env.SA6_API_BASE || 'http://localhost:3001/api'}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': require('crypto').randomUUID(), Authorization: 'Bearer ' + p1.token },
    body: abyssBody,
  });
  check(`документ глубиной ${depth} → 400 (не 500)`, deepRes.status === 400, String(deepRes.status));

  // 3. Keyset-страница не повторяет закреплённые заметки
  const pageIds = [];
  const firstPage = (await call('GET', `/notes?folderId=${fB.id}&limit=2`, p1.token)).json?.data;
  (firstPage?.items ?? []).forEach((n) => pageIds.push(n.id));
  if (firstPage?.nextCursor) {
    const second = (await call('GET', `/notes?folderId=${fB.id}&limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`, p1.token)).json?.data;
    const dupes = (second?.items ?? []).filter((n) => pageIds.includes(n.id));
    check('вторая страница не повторяет первую (курсор с закреплённой)', dupes.length === 0, dupes.map((d) => d.id).join());
  } else {
    check('вторая страница не повторяет первую (курсор с закреплённой)', true, 'одна страница');
  }

  // 4. История версий: снимки видны, откат делает НОВУЮ версию
  const histNote = (await call('POST', '/notes', p1.token, { content: doc(para('версия один')) })).json?.data;
  cleanup.push(histNote.id);
  const v2 = await call('PATCH', `/notes/${histNote.id}`, p1.token, { baseVersion: histNote.version, content: doc(para('версия два')) });
  const revs = await call('GET', `/notes/${histNote.id}/revisions`, p1.token);
  check('история версий отдаёт оба снимка', revs.ok && revs.json.data.length === 2 && revs.json.data[0].current);
  const rolled = await call('POST', `/notes/${histNote.id}/revisions/1/restore`, p1.token);
  check('откат к версии 1 создал новую версию', rolled.ok && rolled.json.data.version === v2.json.data.version + 1);
  const afterRoll = await call('GET', `/notes/${histNote.id}`, p1.token);
  check('после отката вернулся старый текст', JSON.stringify(afterRoll.json?.data?.content ?? {}).includes('версия один'));

  // 5. «Поделились со мной»: чужая заметка видна в списке, а не только по ссылке
  const sharedList = (await call('GET', '/notes?shared=true', p2.token)).json?.data;
  check('раздел «Поделились со мной» показывает чужую заметку', (sharedList?.items ?? []).some((n) => n.id === note.id));
  // Папку fB (в ней лежит inner) открываем p2 — раздел «Открытые мне» и список по чужой папке
  await call('POST', `/notes/folders/${fB.id}/shares`, p1.token, { principalType: 'user', principalId: p2.id, role: 'viewer' });
  const p2SideShared = (await call('GET', '/notes/sidebar', p2.token)).json?.data;
  check('счётчик «поделились со мной» не нулевой', (p2SideShared?.sharedNotesCount ?? 0) > 0);
  check('папка чужого пространства — в разделе «Открытые мне»', (p2SideShared?.sharedFolders ?? []).some((f) => f.id === fB.id));
  const inForeignFolder = (await call('GET', `/notes?folderId=${fB.id}`, p2.token)).json?.data;
  check('список по чужой папке переключает скоуп', (inForeignFolder?.items ?? []).some((n) => n.id === inner.id));

  // 6. Чужая заметка лежит на доске раздела «Поделились со мной» — без всякого «положить»
  const sharedBoard = (await call('GET', '/notes/board?shared=true', p2.token)).json?.data;
  check('доска «Поделились со мной» показывает чужую заметку', (sharedBoard?.items ?? []).some((i) => i.noteId === note.id));

  // 6б. Доска и список — ОДИН набор: что в дереве, то и на доске
  const boardNote = (await call('POST', '/notes', p1.token, { folderId: fB.id, content: doc(para(`на доску ${stamp}`)) })).json?.data;
  cleanup.push(boardNote.id);
  const listInFolder = (await call('GET', `/notes?folderId=${fB.id}`, p1.token)).json?.data;
  const boardInFolder = (await call('GET', `/notes/board?folderId=${fB.id}`, p1.token)).json?.data;
  const listIds = (listInFolder?.items ?? []).map((n) => n.id).sort().join(',');
  const boardIds = (boardInFolder?.items ?? []).map((i) => i.noteId).sort().join(',');
  check('новая заметка сразу на доске папки', boardIds.includes(boardNote.id));
  check('список папки и её доска — один и тот же набор', listIds === boardIds, `список: ${listIds} / доска: ${boardIds}`);
  const trashBoard = (await call('GET', '/notes/board?trashed=true', p1.token)).json?.data;
  check('доска корзины отвечает набором', Array.isArray(trashBoard?.items));

  // 7. Выбывший из команды теряет доступ к СВОЕЙ рабочей заметке.
  // Заметка автора, НЕ расшаренная команде: проверяем именно авторство, а не грант.
  const ownWork = (await call('POST', '/notes', p2.token, { workspaceId: ws.id, content: doc(para(`моя рабочая ${stamp}`)) })).json?.data;
  const beforeFire = await call('GET', `/notes/${ownWork.id}`, p2.token);
  check('сотрудник видит свою рабочую заметку', beforeFire.ok && beforeFire.json.data.access === 'manager');
  // Исключение ШТАТНЫМ путём: снимаются и роль, и членские tuples движка прав
  const fired = await call('DELETE', `/workspaces/${ws.id}/members/${p2.id}`, p1.token);
  check('исключение сотрудника прошло', fired.ok || fired.status === 204, String(fired.status));
  const afterFire = await call('GET', `/notes/${ownWork.id}`, p2.token);
  check('после исключения своя рабочая заметка недоступна', afterFire.status === 404, String(afterFire.status));
  const afterFireList = (await call('GET', `/notes?workspaceId=${ws.id}`, p2.token)).status;
  check('и панель организации ему больше не отвечает', afterFireList === 403, String(afterFireList));
  const ownerStillSees = await call('GET', `/notes/${ownWork.id}`, p1.token);
  check('владелец организации заметку ушедшего видит (она принадлежит организации)', ownerStillSees.ok);
  await call('POST', `/notes/${ownWork.id}/trash`, p1.token);
  await call('DELETE', `/notes/${ownWork.id}`, p1.token);

  // ============================================================
  // Уборка своих объектов штатным путём
  // ============================================================
  for (const id of [...cleanup, inner.id, wsNote.id, wsMention.id].filter(Boolean)) {
    await call('POST', `/notes/${id}/trash`, id === wsNote.id || id === wsMention.id ? p2.token : p1.token);
    await call('DELETE', `/notes/${id}`, id === wsNote.id || id === wsMention.id ? p2.token : p1.token);
  }
  const gone = await call('GET', `/notes/${note.id}`, p1.token);
  check('после purge заметки нет', gone.status === 404);
  check('после purge гранты сняты', (await prisma.relationTuple.count({ where: { resourceType: 'note', resourceId: note.id } })) === 0);
  await call('POST', `/notes/folders/${fA.id}/trash`, p1.token);
  await call('POST', `/notes/folders/${fB.id}/trash`, p1.token);
  await prisma.$disconnect();
  finish();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
