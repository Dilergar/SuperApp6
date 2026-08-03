/* eslint-disable */
// core/approvals — сквозная проверка движка согласований («Ждут решения»).
//
// Аккаунты СЬЮТА (+7700999000x), не ручные tester1/2/3. Чисток deleteMany по userId
// здесь нет — скрипт убирает только СВОИ заявки, штатным путём.
//
// Проверяется то, ради чего движок и заведён: заявка знает свой предмет, шаги идут
// группами (одинаковый order — параллельно), «любой из» и «каждый» ведут себя
// по-разному, ознакомление нельзя отклонить, отказ требует причины, снимок адресатов
// фиксируется на активации, а двойной клик и гонка двух согласующих не ломают маршрут.
//
// Run (API up, NODE_ENV=development): node scripts/verify-approvals.cjs
const { PrismaClient } = require('@prisma/client');
// Адрес API переопределяется переменной окружения: два экземпляра на одной машине
// (например, когда :3001 занят чужим дев-сервером) — обычная ситуация при проверке правок.
const BASE = process.env.SA6_API_BASE || 'http://localhost:3001/api';
const P1 = '+77009990001', P2 = '+77009990002', P3 = '+77009990003', PW = 'Test1234!';

let fails = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`);
  if (!ok) fails++;
};

async function call(method, p, token, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json, code: json?.details?.code ?? null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => require('crypto').randomUUID();

const login = async (phone) => {
  const r = await call('POST', '/auth/login', null, { phone, password: PW });
  if (!r.ok) throw new Error(`login ${phone}: ${r.status} ${JSON.stringify(r.json)}`);
  const token = r.json.data.accessToken;
  // Профиль логин не отдаёт — id берём из `sub` самого токена, без лишнего запроса.
  const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  return { token, id: sub };
};

/** Завести заявку через дев-полигон (предмет объявляется тут же) */
async function createRequest(token, steps, opts = {}) {
  const refId = uuid();
  const r = await call('POST', '/approvals/dev/request', token, {
    refId,
    title: opts.title ?? 'Заявление на отпуск',
    workspaceId: opts.workspaceId ?? null,
    sha: opts.sha ?? null,
    ...(opts.originRef ? { originRef: opts.originRef } : {}),
    steps,
  });
  if (!r.ok) throw new Error(`create: ${r.status} ${JSON.stringify(r.json)}`);
  return { refId, request: r.json.data };
}

const created = [];

(async () => {
  const prisma = new PrismaClient();
  const u1 = await login(P1);
  const u2 = await login(P2);
  const u3 = await login(P3);

  console.log('\n=== 0. Заявку нельзя завести по HTTP ===');
  {
    // Право «отправить это на согласование» знает только ПОТРЕБИТЕЛЬ, поэтому
    // публичной ручки заведения быть не должно. Пока она существовала, любой
    // авторизованный получал в ответе название и номер чужого документа, а
    // выбранному человеку прилетало «Подпишите …» с произвольным текстом.
    const direct = await call('POST', '/approvals', u3.token, {
      refType: 'org_document',
      refId: uuid(),
      steps: [{ order: 0, kind: 'signature', assigneeType: 'user', assigneeId: u1.id }],
    });
    check('POST /approvals отсутствует', direct.status === 404, `status ${direct.status}`);
  }

  console.log('\n=== 1. Заявка знает свой предмет ===');
  {
    const { refId, request } = await createRequest(u1.token, [
      { order: 0, kind: 'approval', assigneeType: 'user', assigneeId: u2.id },
    ]);
    created.push({ id: request.id, token: u1.token });

    check('refType/refId сохранены', request.refType === 'approval_dev' && request.refId === refId);
    check('снимок названия предмета взят у резолвера', request.refTitle === 'Заявление на отпуск');
    check('актуальный вид предмета пришёл из describeRef', request.ref?.title === 'Заявление на отпуск' && !!request.ref?.href);
    check('первый шаг активирован сразу', request.steps[0].status === 'active');
    check('снимок адресатов развёрнут', JSON.stringify(request.steps[0].awaitingUserIds) === JSON.stringify([u2.id]));
    check('автор не может решать за адресата', request.myStepId === null);
    check('автор может отозвать свою заявку', request.canCancel === true);
  }

  console.log('\n=== 2. Стопка «Ждут решения» ===');
  {
    const before = await call('GET', '/approvals/inbox/count', u2.token);
    const { request } = await createRequest(u1.token, [
      { order: 0, kind: 'approval', assigneeType: 'user', assigneeId: u2.id },
    ]);
    created.push({ id: request.id, token: u1.token });

    const after = await call('GET', '/approvals/inbox/count', u2.token);
    check('счётчик адресата вырос на 1', after.json.data.total === before.json.data.total + 1,
      `${before.json.data.total} → ${after.json.data.total}`);
    check('счётчик разложен по источникам', typeof after.json.data.counts.approval === 'number');

    const inbox = await call('GET', '/approvals/inbox', u2.token);
    const item = inbox.json.data.items.find((i) => i.id === request.steps[0].id);
    check('шаг виден в стопке', !!item);
    // Адрес карточки заявки — общий `approvalHref` из shared. Пока он собирался
    // строкой в двух местах API, он указывал на страницу, которой в вебе нет
    // вовсе, и КАЖДОЕ уведомление о согласовании вело в 404.
    check('ссылка ведёт на карточку заявки', item?.href === `/approvals/${request.id}`, item?.href);
    check('элемент общей формы: есть sourceKey и кнопки', item?.sourceKey === 'approval' && item.actions.length === 3);
    check('кнопка «Отклонить» помечена как требующая причины',
      item?.actions.find((a) => a.key === 'rejected')?.commentRequired === true);
    check('автор карточкой: requestedById отдан и профиль в actors',
      item?.requestedById === u1.id && !!inbox.json.data.actors[u1.id]);

    const foreign = await call('GET', '/approvals/inbox', u3.token);
    check('посторонний не видит чужой шаг в своей стопке',
      !foreign.json.data.items.some((i) => i.id === request.steps[0].id));
  }

  console.log('\n=== 3. Права: решает только адресат ===');
  {
    const { request } = await createRequest(u1.token, [
      { order: 0, kind: 'approval', assigneeType: 'user', assigneeId: u2.id },
    ]);
    created.push({ id: request.id, token: u1.token });
    const stepId = request.steps[0].id;

    const byStranger = await call('POST', `/approvals/steps/${stepId}/decide`, u3.token, { decision: 'approved' });
    check('посторонний получает 403 с машинным кодом',
      byStranger.status === 403 && byStranger.code === 'approval_not_assignee', `${byStranger.status}/${byStranger.code}`);

    const byAuthor = await call('POST', `/approvals/steps/${stepId}/decide`, u1.token, { decision: 'approved' });
    check('автор не решает за адресата', byAuthor.status === 403);

    const seen = await call('GET', `/approvals/${request.id}`, u3.token);
    check('посторонний не видит и саму заявку (404, а не 403)', seen.status === 404, String(seen.status));

    const noComment = await call('POST', `/approvals/steps/${stepId}/decide`, u2.token, { decision: 'rejected' });
    check('отказ без причины отклонён', noComment.status === 400 && noComment.code === 'approval_comment_required');
  }

  console.log('\n=== 4. Три исхода ===');
  {
    // Отклонение закрывает всю заявку и гасит остальные шаги.
    const { request } = await createRequest(u1.token, [
      { order: 0, kind: 'approval', assigneeType: 'user', assigneeId: u2.id },
      { order: 1, kind: 'signature', assigneeType: 'user', assigneeId: u3.id },
    ]);
    created.push({ id: request.id, token: u1.token });

    const r = await call('POST', `/approvals/steps/${request.steps[0].id}/decide`, u2.token, {
      decision: 'rejected', comment: 'Не тот период',
    });
    check('отклонение принято', r.ok, String(r.status));
    check('заявка закрыта как отклонённая', r.json.data.status === 'rejected');
    check('второй шаг пропущен, а не «согласован»', r.json.data.steps[1].status === 'skipped');
    check('комментарий сохранён в решении', r.json.data.steps[0].decisions[0].comment === 'Не тот период');

    const dead = await call('POST', `/approvals/steps/${request.steps[1].id}/decide`, u3.token, { decision: 'approved' });
    check('по закрытой заявке решать нельзя', dead.status === 400 && dead.code === 'approval_step_not_active');
  }

  console.log('\n=== 5. Ознакомление: отказаться нельзя ===');
  {
    const { request } = await createRequest(u1.token, [
      { order: 0, kind: 'acknowledgement', assigneeType: 'user', assigneeId: u2.id },
    ]);
    created.push({ id: request.id, token: u1.token });

    const bad = await call('POST', `/approvals/steps/${request.steps[0].id}/decide`, u2.token, {
      decision: 'rejected', comment: 'не хочу',
    });
    check('«Отклонить» на ознакомлении недоступно',
      bad.status === 400 && bad.code === 'approval_decision_not_allowed', `${bad.status}/${bad.code}`);

    const ok = await call('POST', `/approvals/steps/${request.steps[0].id}/decide`, u2.token, { decision: 'approved' });
    check('«Ознакомлен» принято и закрыло заявку', ok.ok && ok.json.data.status === 'approved');
  }

  console.log('\n=== 6. Порядок групп и параллель ===');
  {
    const { request } = await createRequest(u1.token, [
      { order: 5, kind: 'approval', assigneeType: 'user', assigneeId: u2.id },   // группа 1
      { order: 5, kind: 'approval', assigneeType: 'user', assigneeId: u3.id },   // группа 1 (параллельно)
      { order: 9, kind: 'signature', assigneeType: 'user', assigneeId: u1.id },  // группа 2
    ]);
    created.push({ id: request.id, token: u1.token });

    check('группы нормализованы в 0,1 (автор мог поставить 5 и 9)',
      request.steps[0].order === 0 && request.steps[2].order === 1);
    check('оба шага первой группы активны сразу',
      request.steps[0].status === 'active' && request.steps[1].status === 'active');
    check('шаг второй группы ждёт очереди', request.steps[2].status === 'waiting');

    const first = await call('POST', `/approvals/steps/${request.steps[0].id}/decide`, u2.token, { decision: 'approved' });
    check('после первого из пары группа ещё не закрыта', first.json.data.steps[2].status === 'waiting');

    const second = await call('POST', `/approvals/steps/${request.steps[1].id}/decide`, u3.token, { decision: 'approved' });
    check('вторая группа активировалась только после ОБОИХ', second.json.data.steps[2].status === 'active');

    const last = await call('POST', `/approvals/steps/${request.steps[2].id}/decide`, u1.token, { decision: 'approved' });
    check('последний шаг закрыл заявку', last.json.data.status === 'approved');
    check('время решения проставлено', !!last.json.data.steps[2].decidedAt);
  }

  console.log('\n=== 7. Двойной клик и гонка ===');
  {
    const { request } = await createRequest(u1.token, [
      { order: 0, kind: 'approval', assigneeType: 'user', assigneeId: u2.id },
    ]);
    created.push({ id: request.id, token: u1.token });
    const stepId = request.steps[0].id;

    const [a, b] = await Promise.all([
      call('POST', `/approvals/steps/${stepId}/decide`, u2.token, { decision: 'approved' }),
      call('POST', `/approvals/steps/${stepId}/decide`, u2.token, { decision: 'approved' }),
    ]);
    const okCount = [a, b].filter((r) => r.ok).length;
    check('одновременный двойной клик прошёл ровно один раз', okCount === 1, `ok=${okCount}`);

    const again = await call('POST', `/approvals/steps/${stepId}/decide`, u2.token, { decision: 'approved' });
    check('повтор после закрытия отвергнут', again.status === 400, String(again.status));

    const decisions = await prisma.approvalDecision.count({ where: { stepId } });
    check('в журнале ровно одно решение', decisions === 1, `решений: ${decisions}`);
  }

  console.log('\n=== 8. «Любой из» и «каждый» по отделу ===');
  {
    // Отдел собираем прямо в движке прав — так же, как его проецирует StaffModule.
    const depId = uuid();
    await prisma.relationTuple.createMany({
      data: [
        { resourceType: 'department', resourceId: depId, relation: 'member', subjectType: 'user', subjectId: u2.id, subjectRelation: '' },
        { resourceType: 'department', resourceId: depId, relation: 'member', subjectType: 'user', subjectId: u3.id, subjectRelation: '' },
      ],
      skipDuplicates: true,
    });

    const any = await createRequest(u1.token, [
      { order: 0, kind: 'approval', assigneeType: 'department', assigneeId: depId, rule: 'any' },
    ]);
    created.push({ id: any.request.id, token: u1.token });
    check('снимок отдела развёрнут в двоих', any.request.steps[0].awaitingUserIds.length === 2);

    const r1 = await call('POST', `/approvals/steps/${any.request.steps[0].id}/decide`, u2.token, { decision: 'approved' });
    check('«любой из»: первый ответивший закрыл заявку', r1.json.data.status === 'approved');

    const all = await createRequest(u1.token, [
      { order: 0, kind: 'acknowledgement', assigneeType: 'department', assigneeId: depId, rule: 'all' },
    ]);
    created.push({ id: all.request.id, token: u1.token });

    const a1 = await call('POST', `/approvals/steps/${all.request.steps[0].id}/decide`, u2.token, { decision: 'approved' });
    check('«каждый»: после первого заявка ещё открыта', a1.json.data.status === 'pending');
    const a2 = await call('POST', `/approvals/steps/${all.request.steps[0].id}/decide`, u3.token, { decision: 'approved' });
    check('«каждый»: закрылась только после всех', a2.json.data.status === 'approved');

    // Снимок — не живое членство: вошедший ПОСЛЕ активации решать не может.
    const late = await createRequest(u1.token, [
      { order: 0, kind: 'approval', assigneeType: 'department', assigneeId: depId, rule: 'any' },
    ]);
    created.push({ id: late.request.id, token: u1.token });
    const newcomer = await prisma.user.findFirst({ where: { phone: P1 }, select: { id: true } });
    await prisma.relationTuple.create({
      data: { resourceType: 'department', resourceId: depId, relation: 'member', subjectType: 'user', subjectId: newcomer.id, subjectRelation: '' },
    });
    const lateTry = await call('POST', `/approvals/steps/${late.request.steps[0].id}/decide`, u1.token, { decision: 'approved' });
    check('вошедший в отдел ПОСЛЕ активации не решает (снимок держит состав)',
      lateTry.status === 403, String(lateTry.status));

    await prisma.relationTuple.deleteMany({ where: { resourceType: 'department', resourceId: depId } });
  }

  console.log('\n=== 9. Отпечаток предмета в решении ===');
  {
    const sha = 'a'.repeat(64);
    const { request } = await createRequest(u1.token, [
      { order: 0, kind: 'signature', assigneeType: 'user', assigneeId: u2.id },
    ], { sha });
    created.push({ id: request.id, token: u1.token });

    const r = await call('POST', `/approvals/steps/${request.steps[0].id}/decide`, u2.token, { decision: 'approved' });
    const d = r.json.data.steps[0].decisions[0];
    check('решение хранит отпечаток той версии, что видел подписант', d.subjectSha256 === sha);
    check('вид подтверждения — internal (место под core/sign)', d.signatureKind === 'internal');
  }

  console.log('\n=== 10. Оповещение адресатов и тупик маршрута ===');
  {
    // Адресата зовут СРАЗУ при создании — до первого решения по заявке.
    const fresh = await createRequest(u1.token, [
      { order: 0, kind: 'signature', assigneeType: 'user', assigneeId: u2.id },
    ], { title: 'Приказ об отпуске' });
    created.push({ id: fresh.request.id, token: u1.token });
    await sleep(500);
    const asked = await prisma.notification.findFirst({
      where: { userId: u2.id, type: 'approval.requested', dedupKey: `apreq:${fresh.request.steps[0].id}:${u2.id}` },
    });
    check('адресат позван при СОЗДАНИИ заявки, а не после первого решения', !!asked);
    check('глагол берётся из вида шага («Подписать», не «Согласовать»)',
      !!asked && asked.title.startsWith('Подписать'), asked?.title);

    const emptyDep = uuid();
    const { request } = await createRequest(u1.token, [
      { order: 0, kind: 'approval', assigneeType: 'department', assigneeId: emptyDep },
    ]);
    created.push({ id: request.id, token: u1.token });
    check('шаг активен, но снимок пуст', request.steps[0].status === 'active' && request.steps[0].awaitingUserIds.length === 0);

    await sleep(500);
    const notif = await prisma.notification.findFirst({
      where: { userId: u1.id, type: 'approval.unassigned', dedupKey: `apun:${request.steps[0].id}` },
    });
    check('автор предупреждён «некому решать»', !!notif);
  }

  console.log('\n=== 11. Мои заявки и отзыв ===');
  {
    const { request } = await createRequest(u1.token, [
      { order: 0, kind: 'approval', assigneeType: 'user', assigneeId: u2.id },
      { order: 1, kind: 'signature', assigneeType: 'user', assigneeId: u3.id },
    ]);

    const mine = await call('GET', '/approvals/mine', u1.token);
    const row = mine.json.data.find((i) => i.id === request.id);
    check('заявка видна в «моих»', !!row);
    check('подпись этапа человеческая', row?.stageLabel === 'Шаг 1 из 2 · На согласовании', row?.stageLabel);
    check('ждущие отданы карточками', row?.awaitingUserIds?.includes(u2.id) && !!mine.json.data && !!mine.json.actors?.[u2.id]);

    // `?archived=false` обязан значить ЛОЖЬ. z.coerce.boolean() здесь давал ИСТИНУ
    // (непустая строка), и список молча отвечал ровно наоборот — архивом.
    const explicitFalse = await call('GET', '/approvals/mine?archived=false', u1.token);
    check('archived=false отдаёт активные, а не архив',
      explicitFalse.ok && explicitFalse.json.data.some((i) => i.id === request.id));
    const archived = await call('GET', '/approvals/mine?archived=true', u1.token);
    check('archived=true не показывает живую заявку',
      archived.ok && !archived.json.data.some((i) => i.id === request.id));

    const byStranger = await call('POST', `/approvals/${request.id}/cancel`, u2.token);
    check('чужой не отзывает заявку', byStranger.status === 403);

    const cancel = await call('POST', `/approvals/${request.id}/cancel`, u1.token);
    check('автор отозвал', cancel.ok);
    const after = await call('GET', `/approvals/${request.id}`, u1.token);
    check('статус «отменено», шаги погашены',
      after.json.data.status === 'cancelled' && after.json.data.steps.every((s) => s.status === 'skipped'));

    const inbox = await call('GET', '/approvals/inbox', u2.token);
    check('отозванная заявка ушла из чужой стопки',
      !inbox.json.data.items.some((i) => i.id === request.steps[0].id));
  }

  console.log('\n=== 12. Скоуп организации ===');
  {
    // Организацию берём ТУ, где адресат действительно работает: у рабочей заявки
    // снимок адресатов сверяется с командой, и посторонний в него не попадает (это
    // проверяется ниже отдельно).
    const membership = await prisma.userRole.findFirst({
      where: {
        userId: u2.id,
        context: 'workspace',
        isActive: true,
        role: { in: ['trainee', 'staff', 'manager', 'admin', 'owner'] },
      },
      select: { tenantId: true },
    });
    const wsId = membership?.tenantId ?? null;
    if (!wsId) {
      check('SKIP: адресат не работает ни в одной организации', true);
    } else {
      const { request } = await createRequest(u1.token, [
        { order: 0, kind: 'approval', assigneeType: 'user', assigneeId: u2.id },
      ], { workspaceId: wsId });
      created.push({ id: request.id, token: u1.token });

      const scoped = await call('GET', `/approvals/inbox?workspaceId=${wsId}`, u2.token);
      check('шаг виден в скоупе своей организации',
        scoped.json.data.items.some((i) => i.id === request.steps[0].id));

      const other = await call('GET', `/approvals/inbox?workspaceId=${uuid()}`, u2.token);
      check('в чужой организации его нет',
        !other.json.data.items.some((i) => i.id === request.steps[0].id));

      // Адрес карточки несёт организацию. Каркас веба выводит контекст
      // «Личное / Организация» РОВНО из пути, поэтому по короткому адресу человек,
      // открывший рабочее заявление кнопкой «Открыть целиком», оказывался в
      // «Личном» — с личным сайдбаром и документом организации рядом со своими
      // задачами и финансами.
      const wsItem = scoped.json.data.items.find((i) => i.id === request.steps[0].id);
      check('ссылка рабочей заявки ведёт внутрь организации',
        wsItem?.href === `/workspaces/${wsId}/approvals/${request.id}`, wsItem?.href);

      // ---- Три состояния скоупа: организация · только личное · сквозной вид ----
      // «Личное» и «всё» одинаково приходят без workspaceId, поэтому различить их
      // можно только явным `scope=personal`. Пока его не было, личная Главная
      // показывала человеку с несколькими компаниями всё вперемешку.
      const personal = await createRequest(u1.token, [
        { order: 0, kind: 'approval', assigneeType: 'user', assigneeId: u2.id },
      ]);
      created.push({ id: personal.request.id, token: u1.token });
      const personalStepId = personal.request.steps[0].id;

      const onlyPersonal = await call('GET', '/approvals/inbox?scope=personal', u2.token);
      check('в личном скоупе рабочей заявки нет',
        !onlyPersonal.json.data.items.some((i) => i.id === request.steps[0].id));
      check('в личном скоупе личная заявка есть',
        onlyPersonal.json.data.items.some((i) => i.id === personalStepId));
      check('ссылка личной заявки остаётся короткой',
        onlyPersonal.json.data.items.find((i) => i.id === personalStepId)?.href === `/approvals/${personal.request.id}`);

      const across = await call('GET', '/approvals/inbox', u2.token);
      check('сквозной вид (верхние иконки) показывает и рабочую, и личную',
        across.json.data.items.some((i) => i.id === request.steps[0].id)
        && across.json.data.items.some((i) => i.id === personalStepId));

      // Счётчик обязан считать ПО ТОМУ ЖЕ правилу, что и список: иначе цифра на
      // иконке ведёт в стопку, где столько строк не окажется.
      const cntPersonal = await call('GET', '/approvals/inbox/count?scope=personal', u2.token);
      const cntAcross = await call('GET', '/approvals/inbox/count', u2.token);
      check('счётчик личного скоупа меньше сквозного',
        cntPersonal.json.data.total < cntAcross.json.data.total,
        `${cntPersonal.json.data.total} < ${cntAcross.json.data.total}`);
      const cntWs = await call('GET', `/approvals/inbox/count?workspaceId=${wsId}`, u2.token);
      const listWs = await call('GET', `/approvals/inbox?workspaceId=${wsId}`, u2.token);
      check('счётчик организации совпал с её списком',
        cntWs.json.data.total === listWs.json.data.items.length,
        `${cntWs.json.data.total} vs ${listWs.json.data.items.length}`);

      // «Мои заявки» скоупятся тем же параметром — список живёт рядом со стопкой
      const mine = await call('GET', '/approvals/mine?scope=personal', u1.token);
      check('«мои заявки» в личном скоупе без рабочих',
        !mine.json.data.some((r) => r.id === request.id) && mine.json.data.some((r) => r.id === personal.request.id));

      // Уволенный/посторонний в снимок не попадает: обязанность решать не должна
      // переживать выход из организации и не должна доставаться человеку со стороны.
      const foreignWs = await prisma.workspace.findFirst({
        where: {
          isActive: true,
          id: { not: wsId },
          members: { none: { userId: u2.id } },
        },
        select: { id: true },
      });
      if (!foreignWs) {
        check('SKIP: нет чужой организации для проверки снимка', true);
      } else {
        const { request: foreign } = await createRequest(u1.token, [
          { order: 0, kind: 'approval', assigneeType: 'user', assigneeId: u2.id },
        ], { workspaceId: foreignWs.id });
        created.push({ id: foreign.id, token: u1.token });
        const step = await prisma.approvalStep.findUnique({ where: { id: foreign.steps[0].id } });
        check('посторонний не попал в снимок адресатов', (step?.awaitingUserIds ?? []).length === 0,
          JSON.stringify(step?.awaitingUserIds ?? []));
        const denied = await call('POST', `/approvals/steps/${foreign.steps[0].id}/decide`, u2.token, { decision: 'approved' });
        check('и решить он не может', !denied.ok, `status ${denied.status}`);
      }
    }
  }

  console.log('\n=== 13. Ведущий снаружи: повтор не заводит вторую заявку ===');
  {
    // Движок Процессов исполняет шаги at-least-once — повторный толчок ноды после
    // уже закоммиченной заявки НЕ должен давать человеку тот же документ дважды.
    const originRef = `dev:${uuid()}`;
    const first = await createRequest(u1.token, [
      { order: 0, kind: 'approval', assigneeType: 'user', assigneeId: u2.id },
    ], { originRef });
    created.push({ id: first.request.id, token: u1.token });

    const again = await call('POST', '/approvals/dev/request', u1.token, {
      refId: uuid(), // ДРУГОЙ предмет: узнавать повтор движок обязан по ведущему
      title: 'Повторный толчок той же ноды',
      originRef,
      steps: [{ order: 0, kind: 'approval', assigneeType: 'user', assigneeId: u2.id }],
    });
    check('повтор вернул ТУ ЖЕ заявку', again.ok && again.json.data.id === first.request.id);

    const live = await prisma.approvalRequest.count({
      where: { originType: 'approval_dev', originRef, status: 'pending' },
    });
    check('живая заявка на шаг ведущего ровно одна', live === 1, `нашлось: ${live}`);

    // Параллельная гонка: два одновременных вызова упираются в партиальный уник,
    // и оба обязаны вернуть одну и ту же строку, а не 500.
    const raceRef = `dev:${uuid()}`;
    const [a, b] = await Promise.all([
      call('POST', '/approvals/dev/request', u1.token, {
        refId: uuid(), title: 'Гонка A', originRef: raceRef,
        steps: [{ order: 0, kind: 'approval', assigneeType: 'user', assigneeId: u2.id }],
      }),
      call('POST', '/approvals/dev/request', u1.token, {
        refId: uuid(), title: 'Гонка B', originRef: raceRef,
        steps: [{ order: 0, kind: 'approval', assigneeType: 'user', assigneeId: u2.id }],
      }),
    ]);
    check('гонка двух вызовов не даёт 500', a.ok && b.ok, `${a.status}/${b.status}`);
    check('гонка вернула одну заявку', a.json?.data?.id === b.json?.data?.id);
    if (a.json?.data?.id) created.push({ id: a.json.data.id, token: u1.token });

    // И возврат управления: закрытая заявка будит ведущего джобом core/jobs.
    await call('POST', `/approvals/steps/${first.request.steps[0].id}/decide`, u2.token, { decision: 'approved' });
    let outcome = null;
    for (let i = 0; i < 20 && !outcome; i++) {
      await sleep(500);
      const r = await call('POST', '/approvals/dev/outcome', u1.token, { originRef });
      outcome = r.json?.data?.outcome ?? null;
    }
    check('ведущий разбужен с исходом', outcome === 'approved', `outcome=${outcome}`);
  }

  console.log('\n=== 14. Напоминание до срока ===');
  {
    const { request } = await createRequest(u1.token, [
      { order: 0, kind: 'approval', assigneeType: 'user', assigneeId: u2.id, dueInHours: 48 },
    ]);
    created.push({ id: request.id, token: u1.token });
    const stepId = request.steps[0].id;

    const step = await prisma.approvalStep.findUnique({ where: { id: stepId }, select: { deadlineAt: true } });
    const remind = await prisma.job.findFirst({
      where: { type: 'approvals.remind', uniqueKey: `aprm:${stepId}:${step.deadlineAt.getTime()}` },
      select: { runAt: true },
    });
    const escalate = await prisma.job.findFirst({
      where: { type: 'approvals.escalate', uniqueKey: `apst:${stepId}:${step.deadlineAt.getTime()}` },
      select: { runAt: true },
    });
    check('напоминание поставлено джобом', !!remind);
    check('эскалация тоже на месте', !!escalate);
    check('напоминание раньше срока', !!remind && remind.runAt.getTime() < step.deadlineAt.getTime());
    check('напоминание за сутки (меньшее из суток и половины окна)',
      !!remind && Math.abs(step.deadlineAt.getTime() - remind.runAt.getTime() - 24 * 3600_000) < 60_000);

    // Узкое окно: напоминание и просрочка подряд — шум, поэтому его нет вовсе.
    const short = await createRequest(u1.token, [
      { order: 0, kind: 'approval', assigneeType: 'user', assigneeId: u2.id, dueInHours: 1 },
    ]);
    created.push({ id: short.request.id, token: u1.token });
    const shortRemind = await prisma.job.count({
      where: { type: 'approvals.remind', payload: { path: ['stepId'], equals: short.request.steps[0].id } },
    });
    check('на коротком сроке напоминания нет', shortRemind === 0, `нашлось: ${shortRemind}`);
  }

  console.log('\n=== Уборка ===');
  {
    let cleaned = 0;
    for (const c of created) {
      const r = await call('POST', `/approvals/${c.id}/cancel`, c.token);
      if (r.ok) cleaned++;
    }
    check('свои заявки закрыты штатным путём', true, `отозвано активных: ${cleaned}`);
  }

  await prisma.$disconnect();
  console.log(`\n${fails === 0 ? '✅ ALL PASS' : `❌ ${fails} FAIL`}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
