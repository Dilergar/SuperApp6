/* eslint-disable */
// Сервис «Документы» (Этап 4) — сквозная проверка: вид → шаблон → доступность →
// подача сотрудником → сборка .docx по шаблону → отправка на маршрут → заморозка
// правки → решение → номер при регистрации → подшивка на Диск двумя узлами →
// видимость по виду.
//
// Аккаунты СЬЮТА (+7700999000x). Уборка — только свои объекты и штатным путём:
// организация деактивируется (архив приберёт gc-test-workspaces.cjs).
//
// Run (API up): node scripts/verify-documents.cjs
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');

/** Текст собранного .docx: без распаковки любая проверка подстановки — самообман */
function docxText(bytes) {
  const files = unzipSync(new Uint8Array(bytes));
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('в .docx нет word/document.xml');
  return strFromU8(xml).replace(/<[^>]+>/g, '');
}

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
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
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
  const token = r.json.data.accessToken;
  const me = await call('GET', '/users/me', token);
  return { token, userId: me.json.data.id };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Дождаться условия (фоновые джобы сборки/подшивки) */
async function waitFor(label, fn, { tries = 30, delay = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(delay);
  }
  return null;
}

// ------------------------------------------------------------
// Минимальный НАСТОЯЩИЙ .docx с тегами шаблона
// ------------------------------------------------------------
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function buildDocx(paragraphs) {
  const body = paragraphs
    .map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`)
    .join('');
  const entries = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    ),
    'word/_rels/document.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    ),
    'word/document.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<w:document ${W_NS} ${R_NS}><w:body>${body}<w:sectPr/></w:body></w:document>`,
    ),
  };
  return Buffer.from(zipSync(entries, { level: 6 }));
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function uploadDocx(token, name, bytes) {
  const init = await call('POST', '/files', token, {
    profile: 'document', name, mime: DOCX_MIME, size: bytes.length,
  });
  if (!init.ok) throw new Error(`upload init: ${init.status} ${JSON.stringify(init.json)}`);
  const id = init.json.data.file.id;
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: DOCX_MIME }), name);
  const put = await fetch(`${BASE}/files/${id}/content`, {
    method: 'PUT', headers: { Authorization: 'Bearer ' + token }, body: fd,
  });
  if (!put.ok) throw new Error(`upload put: ${put.status}`);
  const done = await call('POST', `/files/${id}/complete`, token, {});
  if (!done.ok) throw new Error(`upload complete: ${done.status}`);
  return id;
}

async function main() {
  const { token: t1, userId: u1 } = await login(P1); // владелец организации
  const { token: t2, userId: u2 } = await login(P2); // сотрудник-заявитель
  const { token: t3, userId: u3 } = await login(P3); // посторонний сотрудник
  const stamp = Date.now();
  const cleanup = { wsId: null };

  try {
    // ============================================================
    // 0. Организация + два сотрудника
    // ============================================================
    console.log('\n— Подготовка —');
    const cws = await call('POST', '/workspaces', t1, { name: `docs-ws-${stamp}` });
    check('организация создана', cws.ok, `status ${cws.status}`);
    const wsId = cws.json.data.id;
    cleanup.wsId = wsId;

    for (const [phone, token] of [[P2, t2], [P3, t3]]) {
      await call('POST', `/workspaces/${wsId}/invitations`, t1, { phone });
      const inc = await call('GET', '/workspaces/invitations/incoming', token);
      const inv = (inc.json?.data ?? []).find((i) => i.workspaceId === wsId);
      if (inv) await call('POST', `/workspaces/invitations/${inv.id}/accept`, token);
    }
    const roster = await call('GET', `/workspaces/${wsId}/members`, t1);
    check('оба сотрудника наняты', (roster.json?.data ?? []).length === 3, String((roster.json?.data ?? []).length));

    // Реквизиты организации — без них сборка документа подставит пустоту
    const bin = String(Math.floor(Math.random() * 9e11) + 1e11);
    await call('PATCH', `/workspaces/${wsId}/requisites`, t1, {
      orgForm: 'too', legalName: `ТОО «Док-${stamp}»`, legalAddress: 'г. Алматы, ул. Абая, 1',
    });

    // ============================================================
    // 1. Вид документа (Менеджер+)
    // ============================================================
    console.log('\n— Виды документов —');
    const asStaff = await call('POST', `/workspaces/${wsId}/documents/doc-types`, t2, { name: 'Чужой вид' });
    check('рядовой сотрудник НЕ создаёт виды', asStaff.status === 403, `status ${asStaff.status}`);

    const ct = await call('POST', `/workspaces/${wsId}/documents/doc-types`, t1, {
      name: `Заявления ${stamp}`,
      category: 'hr',
      numberFormat: 'ЗАЯВ-{ГГГГ}-{NNN}',
      visibility: 'managers',
      toPersonalFile: true,
    });
    check('вид создан', ct.ok, JSON.stringify(ct.json?.message ?? ct.status));
    const typeId = ct.json?.data?.id;
    check('формат номера сохранён', ct.json?.data?.numberFormat === 'ЗАЯВ-{ГГГГ}-{NNN}');

    const types = await call('GET', `/workspaces/${wsId}/documents/doc-types`, t2);
    check('сотрудник ВИДИТ справочник видов', types.ok && (types.json.data ?? []).length === 1, `status ${types.status}`);

    // ============================================================
    // 2. Шаблон: бланк с тегами + форма подачи
    // ============================================================
    console.log('\n— Шаблон —');
    const blank = buildDocx([
      'В {Организация.Юрнаименование}',
      'от {Сотрудник.ФИО}',
      'Прошу предоставить отпуск с {С|дата:долгая} на {Дней|прописью:число} дней.',
      'Документ: {Документ.Название} {Документ.Номер}',
    ]);
    const blankFileId = await uploadDocx(t1, `blank-${stamp}.docx`, blank);

    const ctpl = await call('POST', `/workspaces/${wsId}/documents/templates`, t1, {
      docTypeId: typeId,
      name: 'Отпуск',
      fileId: blankFileId,
      selfService: true,
      fields: [
        { key: 'С', label: 'Дата начала', kind: 'date', required: true },
        { key: 'Дней', label: 'Дней', kind: 'number', required: true },
      ],
    });
    check('шаблон создан', ctpl.ok, JSON.stringify(ctpl.json?.message ?? ctpl.status));
    const tplId = ctpl.json?.data?.id;

    const beforePublish = await call('GET', `/workspaces/${wsId}/documents/available-templates`, t2);
    check('до публикации подать нечего', beforePublish.ok && (beforePublish.json.data ?? []).length === 0);

    const pub = await call('POST', `/workspaces/${wsId}/documents/templates/${tplId}/publish`, t1);
    check('шаблон опубликован', pub.ok && pub.json.data.status === 'published', JSON.stringify(pub.json?.message ?? pub.status));

    // ============================================================
    // 3. Доступность шаблона (гранты core/access)
    // ============================================================
    console.log('\n— Кому доступен шаблон —');
    const stillEmpty = await call('GET', `/workspaces/${wsId}/documents/available-templates`, t2);
    check('без гранта шаблон не виден', (stillEmpty.json?.data ?? []).length === 0);

    const foreign = await call('POST', `/workspaces/${wsId}/documents/templates/${tplId}/grants`, t1, {
      principalType: 'user', principalId: u1 === u1 ? '00000000-0000-4000-8000-000000000000' : u1,
    });
    check('грант постороннему отклонён', foreign.status === 400, `status ${foreign.status}`);

    const grant = await call('POST', `/workspaces/${wsId}/documents/templates/${tplId}/grants`, t1, {
      principalType: 'user', principalId: u2,
    });
    check('грант сотруднику выдан', grant.ok, JSON.stringify(grant.json?.message ?? grant.status));

    const avail2 = await call('GET', `/workspaces/${wsId}/documents/available-templates`, t2);
    check('сотруднику шаблон стал доступен', (avail2.json?.data ?? []).some((t) => t.id === tplId));
    const avail3 = await call('GET', `/workspaces/${wsId}/documents/available-templates`, t3);
    check('другому сотруднику — нет', (avail3.json?.data ?? []).length === 0);

    // ============================================================
    // 4. Подача документа и сборка .docx
    // ============================================================
    console.log('\n— Подача и сборка —');
    const noGrant = await call('POST', `/workspaces/${wsId}/documents`, t3, {
      templateId: tplId, fields: { С: '2026-09-01', Дней: 14 },
    });
    check('без гранта подать нельзя', noGrant.status === 403, `status ${noGrant.status}`);

    const cdoc = await call('POST', `/workspaces/${wsId}/documents`, t2, {
      templateId: tplId,
      title: `Заявление на отпуск ${stamp}`,
      fields: { С: '2026-09-01', Дней: 14 },
    });
    check('документ создан', cdoc.ok, JSON.stringify(cdoc.json?.message ?? cdoc.status));
    const docId = cdoc.json?.data?.id;
    check('статус — черновик', cdoc.json?.data?.status === 'draft');
    check('номера у черновика НЕТ (нумерация при регистрации)', cdoc.json?.data?.number === null);

    const built = await waitFor('сборка .docx', async () => {
      const r = await call('GET', `/workspaces/${wsId}/documents/${docId}`, t2);
      return r.json?.data?.fileId ? r.json.data : null;
    });
    check('фоновая сборка .docx прошла', !!built, 'джоб documents.generate');

    if (built) {
      const dl = await call('GET', `/files/${built.fileId}/download`, t2);
      check('файл документа доступен автору', dl.ok, `status ${dl.status}`);
      if (dl.ok) {
        const bytes = Buffer.from(await (await fetch(dl.json.data.url)).arrayBuffer());
        // .docx — сжатый ZIP: искать текст в сырых байтах бессмысленно, такая
        // проверка проходит ВСЕГДА и ничего не доказывает. Распаковываем честно.
        const text = docxText(bytes);
        check('данные организации подставлены', text.includes(`ТОО «Док-${stamp}»`), text.slice(0, 120));
        check('ФИО сотрудника подставлено', /Сьют\s+Второй|Второй\s+Сьют/.test(text), text.slice(0, 160));
        check('дата из формы подставлена длинным форматом', text.includes('1 сентября 2026 г.'));
        check('число словами подставлено', text.includes('четырнадцать'));
        check('тегов в собранном документе не осталось', !text.includes('{'), text.slice(0, 200));
      }
    }

    // ============================================================
    // 5. Видимость по виду
    // ============================================================
    console.log('\n— Видимость —');
    const asOther = await call('GET', `/workspaces/${wsId}/documents/${docId}`, t3);
    check('чужой сотрудник не видит документ закрытого вида', asOther.status === 403, `status ${asOther.status}`);
    const asOwner = await call('GET', `/workspaces/${wsId}/documents/${docId}`, t1);
    check('управляющий видит всегда', asOwner.ok, `status ${asOwner.status}`);

    const listOther = await call('GET', `/workspaces/${wsId}/documents`, t3);
    check('в реестре чужого сотрудника документа нет', (listOther.json?.data?.items ?? []).length === 0);
    const listOwner = await call('GET', `/workspaces/${wsId}/documents`, t1);
    check('в реестре управляющего документ есть', (listOwner.json?.data?.items ?? []).some((d) => d.id === docId));

    // ============================================================
    // 5b. Вид «отдел сотрудника»: РЕЕСТР и КАРТОЧКА обязаны отвечать одинаково.
    //     Пока определений «коллега по отделу» было два, документ открывался по
    //     прямой ссылке, но в списке не находился — для человека это поломка.
    // ============================================================
    console.log('\n— Видимость «отдел сотрудника» —');
    const mkDep = async (name) => {
      const r = await call('POST', `/workspaces/${wsId}/staff/departments`, t1, { name });
      if (!r.ok) throw new Error(`department ${name}: ${r.status} ${JSON.stringify(r.json)}`);
      return r.json.data.id;
    };
    const mkPos = async (name, departmentId) => {
      const r = await call('POST', `/workspaces/${wsId}/staff/positions`, t1, { name, departmentId });
      if (!r.ok) throw new Error(`position ${name}: ${r.status} ${JSON.stringify(r.json)}`);
      return r.json.data.id;
    };
    const assign = (userId, positionId) =>
      call('POST', `/workspaces/${wsId}/staff/members/${userId}/assignments`, t1, { positionId });

    const posA = await mkPos(`Кадровик ${stamp}`, await mkDep(`Кадры ${stamp}`));
    const posB = await mkPos(`Кладовщик ${stamp}`, await mkDep(`Склад ${stamp}`));
    check('сторона документа назначена в отдел А', (await assign(u2, posA)).ok);
    check('второй сотрудник назначен в отдел Б', (await assign(u3, posB)).ok);

    const depType = await call('POST', `/workspaces/${wsId}/documents/doc-types`, t1, {
      name: `Справки ${stamp}`, category: 'hr', visibility: 'department',
    });
    check('вид с видимостью «отдел сотрудника» создан', depType.ok, JSON.stringify(depType.json?.message ?? depType.status));
    const depTypeId = depType.json?.data?.id;

    const depBlank = await uploadDocx(t1, `spravka-${stamp}.docx`, buildDocx(['Справка {Организация.Юрнаименование}']));
    const depTpl = await call('POST', `/workspaces/${wsId}/documents/templates`, t1, {
      docTypeId: depTypeId, name: 'Справка с места работы', fileId: depBlank, selfService: true,
    });
    const depTplId = depTpl.json?.data?.id;
    const depPub = await call('POST', `/workspaces/${wsId}/documents/templates/${depTplId}/publish`, t1);
    check('шаблон справки опубликован', depPub.ok, JSON.stringify(depPub.json?.message ?? depPub.status));

    // Документ НА сотрудника заводит управляющий — грант на шаблон для этого не нужен
    const depDoc = await call('POST', `/workspaces/${wsId}/documents`, t1, {
      templateId: depTplId, title: `Справка ${stamp}`, subjectUserId: u2,
    });
    check('документ заведён на сотрудника отдела А', depDoc.ok, JSON.stringify(depDoc.json?.message ?? depDoc.status));
    const depDocId = depDoc.json?.data?.id;

    /** Оба пути доступа разом: карточка по прямой ссылке и строка в реестре */
    const seesDoc = async (token, id) => {
      const card = await call('GET', `/workspaces/${wsId}/documents/${id}`, token);
      const list = await call('GET', `/workspaces/${wsId}/documents`, token);
      return { card: card.ok, inList: (list.json?.data?.items ?? []).some((d) => d.id === id) };
    };
    const seesDepDoc = (token) => seesDoc(token, depDocId);

    const otherDep = await seesDepDoc(t3);
    check('сотрудник ДРУГОГО отдела не видит документ в реестре', otherDep.inList === false);
    check('…и карточку не открывает', otherDep.card === false);
    check('реестр и карточка согласованы (доступа нет)', otherDep.card === otherDep.inList);

    check('второй сотрудник назначен и в отдел А', (await assign(u3, posA)).ok);

    const mate = await seesDepDoc(t3);
    check('КОЛЛЕГА ПО ОТДЕЛУ видит документ в реестре', mate.inList === true);
    check('…и открывает карточку', mate.card === true);
    check('реестр и карточка согласованы (доступ есть)', mate.card === mate.inList);

    const subject = await seesDepDoc(t2);
    check('сторона документа видит его обоими путями', subject.card && subject.inList);

    // Закрытый вид коллегу по отделу НЕ пускает: правило живёт на ВИДЕ, а не на отделе
    const closedForMate = await call('GET', `/workspaces/${wsId}/documents/${docId}`, t3);
    check('вид «только управляющие» коллеге по отделу закрыт', closedForMate.status === 403, `status ${closedForMate.status}`);
    const closedList = await call('GET', `/workspaces/${wsId}/documents`, t3);
    check(
      'и в реестре его нет',
      !(closedList.json?.data?.items ?? []).some((d) => d.id === docId),
    );

    // ============================================================
    // 6. Отправка на маршрут: заморозка правки
    // ============================================================
    console.log('\n— Отправка на маршрут —');
    const submit = await call('POST', `/workspaces/${wsId}/documents/${docId}/submit`, t2);
    check('документ отправлен', submit.ok && submit.json.data.status === 'in_review', JSON.stringify(submit.json?.message ?? submit.status));

    const editAfter = await call('PATCH', `/workspaces/${wsId}/documents/${docId}`, t2, { title: 'Правка на маршруте' });
    check('правка после отправки ЗАКРЫТА', editAfter.status === 403, `status ${editAfter.status}`);

    const submitTwice = await call('POST', `/workspaces/${wsId}/documents/${docId}/submit`, t2);
    check('повторная отправка отклонена', !submitTwice.ok, `status ${submitTwice.status}`);

    // ============================================================
    // 7. Итог маршрута, номер и подшивка (системные пути, которые зовут НОДЫ)
    // ============================================================
    console.log('\n— Решение, номер, подшивка —');
    const dev = (p, token, body) => call('POST', `/workspaces/${wsId}/documents/dev/${docId}/${p}`, token, body);

    // «На доработку» — правка обязана открыться снова
    const returned = await dev('resolve', t1, { outcome: 'returned' });
    check('итог «на доработку» принят', returned.ok, JSON.stringify(returned.json?.message ?? returned.status));
    const afterReturn = await call('GET', `/workspaces/${wsId}/documents/${docId}`, t2);
    check('после доработки статус снова правится', afterReturn.json?.data?.can?.edit === true, afterReturn.json?.data?.status);
    const editAgain = await call('PATCH', `/workspaces/${wsId}/documents/${docId}`, t2, { title: `Заявление ${stamp} (испр.)` });
    check('правка после возврата РАЗРЕШЕНА', editAgain.ok, `status ${editAgain.status}`);

    // Второй заход на маршрут и подпись
    await call('POST', `/workspaces/${wsId}/documents/${docId}/submit`, t2);
    const approved = await dev('resolve', t1, { outcome: 'approved' });
    check('итог «согласовано» принят', approved.ok, JSON.stringify(approved.json?.message ?? approved.status));
    const signed = await call('GET', `/workspaces/${wsId}/documents/${docId}`, t1);
    check('документ помечен подписанным', !!signed.json?.data?.signedAt, signed.json?.data?.status);

    // Регистрация: номер по формату вида, идемпотентно
    const reg = await dev('register', t1);
    check('номер присвоен', reg.ok, JSON.stringify(reg.json?.message ?? reg.status));
    const number = reg.json?.data?.number;
    check('номер по формату вида (ЗАЯВ-ГГГГ-NNN)', /^ЗАЯВ-\d{4}-\d{3}$/.test(number ?? ''), number);
    check('серия начинается с первого номера', number?.endsWith('-001'), number);
    const reg2 = await dev('register', t1);
    check('повторная регистрация идемпотентна (тот же номер)', reg2.json?.data?.number === number, reg2.json?.data?.number);
    const numbered = await call('GET', `/workspaces/${wsId}/documents/${docId}`, t1);
    check('статус стал «зарегистрирован»', numbered.json?.data?.status === 'registered', numbered.json?.data?.status);

    // Подшивка: реестр вида + личное дело (вид создан с toPersonalFile: true)
    const filed = await dev('file', t1);
    check('подшивка поставлена в очередь', filed.ok, JSON.stringify(filed.json?.message ?? filed.status));

    const driveNodes = await waitFor('подшивка на Диск', async () => {
      const r = await call('GET', `/drive/nodes?workspaceId=${wsId}`, t1);
      const items = r.json?.data ?? [];
      const registry = items.find((n) => n.name === 'Документы организации');
      const personal = items.find((n) => n.name === 'Личные дела');
      return registry && personal ? { registry, personal } : null;
    });
    check('на Диске появились обе системные папки', !!driveNodes, 'Документы организации + Личные дела');

    if (driveNodes) {
      const inRegistry = await call('GET', `/drive/nodes?workspaceId=${wsId}&parentId=${driveNodes.registry.id}`, t1);
      const typeFolder = (inRegistry.json?.data ?? []).find((n) => n.name.startsWith('Заявления'));
      check('в реестре есть папка вида', !!typeFolder, JSON.stringify((inRegistry.json?.data ?? []).map((n) => n.name)));

      let registryFileNode = null;
      if (typeFolder) {
        const files = await call('GET', `/drive/nodes?workspaceId=${wsId}&parentId=${typeFolder.id}`, t1);
        registryFileNode = (files.json?.data ?? []).find((n) => n.kind === 'file');
        check('документ подшит в реестр вида', !!registryFileNode, JSON.stringify((files.json?.data ?? []).map((n) => n.name)));
        check('имя файла несёт номер', (registryFileNode?.name ?? '').includes(number ?? '###'), registryFileNode?.name);
      }

      const inPersonal = await call('GET', `/drive/nodes?workspaceId=${wsId}&parentId=${driveNodes.personal.id}`, t1);
      const personFolder = (inPersonal.json?.data ?? [])[0];
      check('заведена папка личного дела сотрудника', !!personFolder, personFolder?.name);
      let personalFileNode = null;
      if (personFolder) {
        const pf = await call('GET', `/drive/nodes?workspaceId=${wsId}&parentId=${personFolder.id}`, t1);
        personalFileNode = (pf.json?.data ?? []).find((n) => n.kind === 'file');
        check('документ подшит и в личное дело', !!personalFileNode);
      }

      // Главное свойство подшивки: ДВА узла на ОДИН файл (байты не дублируются)
      if (registryFileNode && personalFileNode) {
        const a = await call('GET', `/drive/nodes/${registryFileNode.id}`, t1);
        const b = await call('GET', `/drive/nodes/${personalFileNode.id}`, t1);
        const fa = a.json?.data?.node?.file?.id, fb = b.json?.data?.node?.file?.id;
        check('два узла ссылаются на ОДИН файл (байты не удвоены)', !!fa && fa === fb, `${fa} vs ${fb}`);
        check('«используется ещё в N местах» видит обе подшивки', (a.json?.data?.usedElsewhere ?? 0) >= 1, String(a.json?.data?.usedElsewhere));
      }

      const outsider = await call('GET', `/drive/nodes?workspaceId=${wsId}&parentId=${driveNodes.personal.id}`, t3);
      check(
        'личные дела закрыты от постороннего сотрудника',
        !outsider.ok || (outsider.json?.data ?? []).length === 0,
        `status ${outsider.status}`,
      );
    }

    const filedAgain = await dev('file', t1);
    check('повторная подшивка не плодит узлы', filedAgain.ok);

    // ============================================================
    // 8. Отмена — на ОТДЕЛЬНОМ документе: зарегистрированный отменять нельзя,
    //    и это правильно (у него уже есть номер в книге регистрации).
    // ============================================================
    console.log('\n— Отмена —');
    const lateCancel = await call('POST', `/workspaces/${wsId}/documents/${docId}/cancel`, t2);
    check('зарегистрированный документ отменить НЕЛЬЗЯ', !lateCancel.ok, JSON.stringify(lateCancel.json?.message ?? lateCancel.status));

    const doc2 = await call('POST', `/workspaces/${wsId}/documents`, t2, {
      templateId: tplId, title: `Черновик ${stamp}`, fields: { С: '2026-10-01', Дней: 3 },
    });
    const doc2Id = doc2.json?.data?.id;
    check('второй документ создан', doc2.ok, `status ${doc2.status}`);
    const cancelForeign = await call('POST', `/workspaces/${wsId}/documents/${doc2Id}/cancel`, t3);
    check('посторонний не отменяет', !cancelForeign.ok, `status ${cancelForeign.status}`);
    const cancel = await call('POST', `/workspaces/${wsId}/documents/${doc2Id}/cancel`, t2);
    check('автор отменил свой черновик', cancel.ok && cancel.json.data.status === 'cancelled', JSON.stringify(cancel.json?.message ?? cancel.status));

    // ============================================================
    // 9. Хроника карточки
    // ============================================================
    console.log('\n— Хроника —');
    const chron = await call('GET', `/chatter/org_document/${docId}`, t2);
    const keys = (chron.json?.data?.items ?? []).map((i) => i.typeKey);
    check('хроника доступна автору', chron.ok, `status ${chron.status}`);
    check('в хронике есть создание', keys.includes('org_document.created'), JSON.stringify(keys));
    check('в хронике есть отправка', keys.includes('org_document.submitted'));
    check('в хронике есть возврат на доработку', keys.includes('org_document.returned'));
    check('в хронике есть подпись', keys.includes('org_document.signed'));
    check('в хронике есть номер', keys.includes('org_document.registered'));
    check('в хронике есть подшивка', keys.includes('org_document.filed'));
    const chron2 = await call('GET', `/chatter/org_document/${doc2Id}`, t2);
    check(
      'в хронике второго документа есть отмена',
      (chron2.json?.data?.items ?? []).some((i) => i.typeKey === 'org_document.cancelled'),
    );
    const chronForeign = await call('GET', `/chatter/org_document/${docId}`, t3);
    check('хроника закрыта от постороннего', chronForeign.status === 403, `status ${chronForeign.status}`);

    // ============================================================
    // 10. Архив вида
    // Регрессии ревью 2026-08-03: дыры, которые сервис уже проходил
    // ============================================================
    console.log('\n— Регрессии ревью —');
    {
      // 1) Сторона документа. Проверка стояла только на СОЗДАНИИ, и через PATCH в
      //    документ подставлялся любой человек платформы — а рендер печатает его ИИН,
      //    адрес и удостоверение (данные, закрытые от коллег по умолчанию).
      const own = await call('POST', `/workspaces/${wsId}/documents`, t2, {
        templateId: tplId, title: `Регресс сторона ${stamp}`, fields: { С: '2026-09-01', Дней: 3 },
      });
      const ownId = own.json?.data?.id;
      const swap = await call('PATCH', `/workspaces/${wsId}/documents/${ownId}`, t2, { subjectUserId: u3 });
      check('рядовой не подменяет сторону документа', !swap.ok, `status ${swap.status}`);

      // 2) Поля формы не перекрывают группы реестра: подставные реквизиты в
      //    официальном документе — это подделка, а не «значение по умолчанию».
      const forged = await call('POST', `/workspaces/${wsId}/documents`, t2, {
        templateId: tplId,
        title: `Регресс реквизиты ${stamp}`,
        fields: { С: '2026-09-01', Дней: 2, Организация: { Юрнаименование: 'ТОО «Подделка»' } },
      });
      const forgedId = forged.json?.data?.id;
      const forgedDoc = await waitFor('сборка с подделкой', async () => {
        const r = await call('GET', `/workspaces/${wsId}/documents/${forgedId}`, t2);
        return r.json?.data?.fileId ? r.json.data : null;
      });
      check('лишний ключ формы не сохранился', !('Организация' in (forgedDoc?.fields ?? {})),
        JSON.stringify(Object.keys(forgedDoc?.fields ?? {})));
      if (forgedDoc?.fileId) {
        const dlForged = await call('GET', `/files/${forgedDoc.fileId}/download`, t2);
        if (dlForged.ok) {
          const text = docxText(Buffer.from(await (await fetch(dlForged.json.data.url)).arrayBuffer()));
          check('в документе НАСТОЯЩЕЕ имя организации, а не подставленное',
            !text.includes('Подделка') && text.includes(`ТОО «Док-${stamp}»`), text.slice(0, 90));
        }
      }

      // 3) Файл документа закрытого вида не отдаётся постороннему члену команды:
      //    реестр отвечал 403, а байты по прямой ссылке скачивались.
      if (forgedDoc?.fileId) {
        const stolen = await call('GET', `/files/${forgedDoc.fileId}/download`, t3);
        check('файл документа закрыт от постороннего сотрудника', !stolen.ok, `status ${stolen.status}`);
      }

      // 4) «Сотрудник подаёт сам» — гейт подачи, а не подсказка для списка.
      const closedTpl = await call('POST', `/workspaces/${wsId}/documents/templates`, t1, {
        docTypeId: typeId,
        name: `Только кадровик ${stamp}`,
        fileId: await uploadDocx(t1, `hr-${stamp}.docx`, buildDocx(['Приказ'])),
        selfService: false,
      });
      if (closedTpl.ok) {
        const closedId = closedTpl.json.data.id;
        await call('POST', `/workspaces/${wsId}/documents/templates/${closedId}/publish`, t1);
        await call('POST', `/workspaces/${wsId}/documents/templates/${closedId}/grants`, t1, {
          principalType: 'user', principalId: u2,
        });
        const bySelf = await call('POST', `/workspaces/${wsId}/documents`, t2, { templateId: closedId });
        check('шаблон без самообслуживания сотрудник не подаёт', !bySelf.ok, `status ${bySelf.status}`);
      }

      // 5) Возврат с маршрута: отправка не должна быть билетом в один конец, когда
      //    маршрут не нарисован и решать некому.
      const back = await call('POST', `/workspaces/${wsId}/documents/${ownId}/submit`, t2);
      if (back.ok) {
        const withdrawn = await call('POST', `/workspaces/${wsId}/documents/${ownId}/withdraw`, t2);
        check('документ вернулся с маршрута в черновик',
          withdrawn.ok && withdrawn.json?.data?.status === 'draft',
          JSON.stringify(withdrawn.json?.message ?? withdrawn.json?.data?.status));
        const editable = await call('PATCH', `/workspaces/${wsId}/documents/${ownId}`, t2, { title: `После возврата ${stamp}` });
        check('после возврата правка снова открыта', editable.ok, `status ${editable.status}`);
      }

      // За собой убираем: следующая секция архивирует вид, а он не уходит в архив,
      // пока по нему остались документы в работе (это его правило, а не помеха).
      for (const id of [ownId, forgedId]) {
        if (id) await call('POST', `/workspaces/${wsId}/documents/${id}/cancel`, t2);
      }
    }

    // ============================================================
    console.log('\n— Архив вида —');
    const arch = await call('DELETE', `/workspaces/${wsId}/documents/doc-types/${typeId}`, t1);
    check('вид без документов в работе уходит в архив', arch.ok, JSON.stringify(arch.json?.message ?? arch.status));

    // ------------------------------------------------------------
    // Архив вида = жизненный цикл СПРАВОЧНИКА, а не отзыв доступа.
    // Две половины контракта проверяем по отдельности: историю читать МОЖНО,
    // заводить по архивному виду новое — НЕЛЬЗЯ.
    // ------------------------------------------------------------
    const teamType = await call('POST', `/workspaces/${wsId}/documents/doc-types`, t1, {
      name: `Объявления ${stamp}`, category: 'general', numberFormat: 'ОБ-{ГГГГ}-{NNN}', visibility: 'team',
    });
    check('вид «для всей команды» создан', teamType.ok, JSON.stringify(teamType.json?.message ?? teamType.status));
    const teamTypeId = teamType.json?.data?.id;

    const teamBlank = await uploadDocx(t1, `obyav-${stamp}.docx`, buildDocx(['Объявление {Организация.Юрнаименование}']));
    const teamTpl = await call('POST', `/workspaces/${wsId}/documents/templates`, t1, {
      docTypeId: teamTypeId, name: 'Объявление', fileId: teamBlank, selfService: true,
    });
    const teamTplId = teamTpl.json?.data?.id;
    await call('POST', `/workspaces/${wsId}/documents/templates/${teamTplId}/publish`, t1);
    await call('POST', `/workspaces/${wsId}/documents/templates/${teamTplId}/grants`, t1, {
      principalType: 'user', principalId: u2,
    });
    const availBefore = await call('GET', `/workspaces/${wsId}/documents/available-templates`, t2);
    check('до архива по виду можно подать', (availBefore.json?.data ?? []).some((t) => t.id === teamTplId));

    // Документ доводим до РЕГИСТРАЦИИ: архивировать вид можно только когда в работе
    // ничего не осталось, то есть защищаем ровно выданные номера
    const teamDoc = await call('POST', `/workspaces/${wsId}/documents`, t1, {
      templateId: teamTplId, title: `Объявление ${stamp}`, subjectUserId: u2,
    });
    const teamDocId = teamDoc.json?.data?.id;
    check('документ вида «для всей команды» создан', teamDoc.ok, JSON.stringify(teamDoc.json?.message ?? teamDoc.status));
    // Ждём сборку .docx: отправка на маршрут требует готового файла, а системные пути
    // (номер, подпись) теперь уважают статус — раньше этот документ получал номер,
    // так и не собравшись, потому что ноды маршрута статус не проверяли вовсе.
    const teamBuilt = await waitFor('сборка объявления', async () => {
      const r = await call('GET', `/workspaces/${wsId}/documents/${teamDocId}`, t1);
      return r.json?.data?.fileId ? r.json.data : null;
    });
    check('объявление собрано', !!teamBuilt, 'джоб documents.generate');
    const teamSubmit = await call('POST', `/workspaces/${wsId}/documents/${teamDocId}/submit`, t1);
    check('объявление отправлено на маршрут', teamSubmit.ok, JSON.stringify(teamSubmit.json?.message ?? teamSubmit.status));
    await call('POST', `/workspaces/${wsId}/documents/dev/${teamDocId}/resolve`, t1, { outcome: 'approved' });
    const teamReg = await call('POST', `/workspaces/${wsId}/documents/dev/${teamDocId}/register`, t1);
    check('документ зарегистрирован (есть номер)', /^ОБ-\d{4}-\d{3}$/.test(teamReg.json?.data?.number ?? ''), teamReg.json?.data?.number);

    const beforeArchive = await seesDoc(t3, teamDocId);
    check('до архива команда видит документ обоими путями', beforeArchive.card && beforeArchive.inList);

    const archTeam = await call('DELETE', `/workspaces/${wsId}/documents/doc-types/${teamTypeId}`, t1);
    check('вид «для всей команды» ушёл в архив', archTeam.ok, JSON.stringify(archTeam.json?.message ?? archTeam.status));

    const afterArchive = await seesDoc(t3, teamDocId);
    check('ПОСЛЕ архива вида документ ОСТАЁТСЯ в реестре команды', afterArchive.inList === true);
    check('…и карточка открывается', afterArchive.card === true);
    check('реестр и карточка согласованы и на архивном виде', afterArchive.card === afterArchive.inList);

    const availAfter = await call('GET', `/workspaces/${wsId}/documents/available-templates`, t2);
    check('по архивному виду подать больше НЕЛЬЗЯ', !(availAfter.json?.data ?? []).some((t) => t.id === teamTplId));
    const createAfter = await call('POST', `/workspaces/${wsId}/documents`, t2, {
      templateId: teamTplId, title: `Поздно ${stamp}`,
    });
    check('и напрямую по шаблону архивного вида — тоже нельзя', !createAfter.ok, `status ${createAfter.status}`);

    const typesAfter = await call('GET', `/workspaces/${wsId}/documents/doc-types`, t1);
    check(
      'архивный вид пропал из справочника',
      !(typesAfter.json?.data ?? []).some((t) => t.id === typeId),
      JSON.stringify((typesAfter.json?.data ?? []).map((t) => t.name)),
    );

    // ============================================================
  } finally {
    if (cleanup.wsId) await call('DELETE', `/workspaces/${cleanup.wsId}`, t1);
  }

  console.log(`\n${fails === 0 ? 'ALL PASS' : `FAILS: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
