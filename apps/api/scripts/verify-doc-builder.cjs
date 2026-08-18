/* eslint-disable */
// Блочный конструктор документов (builder-шаблоны + свободные документы):
// рендерер HTML (чистой функцией из dist) → шаблон в конструкторе → публикация с
// проверкой чипов → документ по шаблону (файл = PDF) → правка/заморозка →
// свободный документ → превью-PDF. PDF-шаги SKIP без GOTENBERG_URL (прецедент voice).
//
// Run (API up): node scripts/verify-doc-builder.cjs
const { call, login, makeChecker, SUITE, BASE } = require('./_lib.cjs');

const { check, finish } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { tries = 30, delay = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(delay);
  }
  return null;
}

const PDF_ON = !!(process.env.GOTENBERG_URL ?? '').trim();

// ------------------------------------------------------------
// Кирпичи builder-документа
// ------------------------------------------------------------
let seq = 0;
const bid = () => `b${++seq}`;
const text = (t, styles) => ({ type: 'text', text: t, ...(styles ? { styles } : {}) });
const chip = (path, format, label) => ({
  type: 'chip',
  props: { path, ...(format ? { format } : {}), ...(label ? { label } : {}) },
});
const p = (content, align) => ({ id: bid(), type: 'paragraph', ...(align ? { props: { align } } : {}), content });
const doc = (blocks) => ({ version: 1, page: { footer: 'pageNumbers' }, blocks });

function sampleBuilderDoc() {
  return doc([
    { id: bid(), type: 'requisites', props: { showLogo: false } },
    { id: bid(), type: 'heading', props: { level: 1 }, content: [text('ЗАЯВЛЕНИЕ')] },
    { id: bid(), type: 'docMeta' },
    p([
      text('Прошу предоставить мне отпуск с '),
      chip('Форма.С', 'дата:долгая', 'Дата начала'),
      text(' на '),
      chip('Форма.Дней', 'прописью:число', 'Дней'),
      text(' календарных дней.'),
    ]),
    p([text('Сотрудник: '), chip('Сотрудник.ФИО'), text(' ('), chip('Организация.Юрнаименование'), text(')')]),
    { id: bid(), type: 'signature', props: { role: 'Работник', nameSource: 'subject' } },
    { id: bid(), type: 'pageBreak' },
    p([text('Вторая страница для колонтитула.')]),
  ]);
}

async function fetchFileBytes(token, fileId) {
  const dl = await call('GET', `/files/${fileId}/download`, token);
  if (!dl.ok) return null;
  const res = await fetch(dl.json.data.url);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function previewPdf(token, path, builderDoc) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(builderDoc ? { builderDoc } : {}),
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', bytes };
}

async function main() {
  // ============================================================
  // 0. Рендерер HTML — чистой функцией, без контейнера и БД
  // ============================================================
  console.log('\n— Рендерер блоков (dist, без сети) —');
  const { renderBuilderHtml, checkBuilderDoc } = require('../dist/core/templates/builder-render.driver.js');

  const values = {
    С: '2026-09-01',
    Дней: 14,
    Документ: { Название: 'Заявление', Номер: 'ЗАЯВ-2026-007', Дата: new Date('2026-08-08T10:00:00Z') },
    Организация: { Юрнаименование: 'ТОО «Ромашка»', БИН: '123456789012', Юрадрес: 'г. Алматы', Директор: 'Ахметов Аскар' },
    Сотрудник: { ФИО: 'Нурланов Санжар' },
  };
  const r1 = renderBuilderHtml(sampleBuilderDoc(), values, { strict: false, title: 'Тест' });
  check('HTML собрался', r1.html.includes('<!doctype html>'));
  check('чип формы: дата длинная', r1.html.includes('1 сентября 2026 г.'), r1.html.slice(0, 0));
  check('чип формы: число прописью', r1.html.includes('четырнадцать'));
  check('данные организации подставлены', r1.html.includes('ТОО «Ромашка»'));
  check('шапка реквизитов с БИН', r1.html.includes('БИН 123456789012'));
  check('номер в docMeta', r1.html.includes('ЗАЯВ-2026-007'));
  check('подпись: имя стороны', r1.html.includes('Нурланов Санжар'));
  check('разрыв страницы в HTML', r1.html.includes('page-break'));
  check('ничего не потерялось (replaced)', r1.replaced >= 5, String(r1.replaced));
  check('missing пуст при полных данных', r1.missing.length === 0, JSON.stringify(r1.missing));

  const rMiss = renderBuilderHtml(sampleBuilderDoc(), { Документ: values.Документ }, { strict: false });
  check('мягкий режим: метка вместо пустоты', rMiss.html.includes('chip-missing') && rMiss.html.includes('‹Сотрудник.ФИО›'));
  check('missing перечислен', rMiss.missing.includes('Организация.Юрнаименование'), JSON.stringify(rMiss.missing));
  let strictThrew = false;
  try {
    renderBuilderHtml(sampleBuilderDoc(), {}, { strict: true });
  } catch (e) {
    strictThrew = Array.isArray(e.missing) && e.missing.length > 0;
  }
  check('strict: отказ СПИСКОМ недостающих', strictThrew);

  const rXss = renderBuilderHtml(
    doc([p([text('<script>alert(1)</script> и '), chip('Форма.Х')])]),
    { Х: '<img src=x onerror=1>' },
    { strict: false },
  );
  check('текст экранирован', !rXss.html.includes('<script>alert') && rXss.html.includes('&lt;script&gt;'));
  check('значение чипа экранировано', !rXss.html.includes('<img src=x') );

  const rList = renderBuilderHtml(
    doc([
      { id: bid(), type: 'bulletListItem', content: [text('один')] },
      { id: bid(), type: 'bulletListItem', content: [text('два')] },
      { id: bid(), type: 'numberedListItem', content: [text('три')] },
    ]),
    {},
    { strict: false },
  );
  check('подряд идущие пункты склеены в один список', (rList.html.match(/<ul>/g) ?? []).length === 1 && rList.html.includes('<ol>'));

  const rTable = renderBuilderHtml(
    doc([{ id: bid(), type: 'table', props: { headerRow: true, columnWidths: [2, 1] }, rows: [
      { cells: [[text('Показатель')], [text('Значение')]] },
      { cells: [[text('Дней')], [chip('Форма.Дней')]] },
    ] }]),
    { Дней: 14 },
    { strict: false },
  );
  check('таблица: thead + colgroup + значение', rTable.html.includes('<thead>') && rTable.html.includes('colgroup') && rTable.html.includes('>14<'));

  const issues = checkBuilderDoc(
    doc([p([chip('Организация.Несуществующее'), chip('Форма.Нет'), chip('Форма.Дней', 'кривой-формат')])]),
    (path) => path === 'Организация.Юрнаименование',
    ['Дней'],
  );
  check('компилятор: неизвестное поле реестра', issues.some((i) => i.tag === 'Организация.Несуществующее'));
  check('компилятор: необъявленное поле формы', issues.some((i) => i.tag === 'Форма.Нет'));
  check('компилятор: неизвестный формат', issues.some((i) => i.code === 'unknown_formatter'));

  // ============================================================
  // 1. Организация + сотрудник
  // ============================================================
  console.log('\n— Подготовка —');
  const { token: t1, id: u1 } = await login(SUITE.p1);
  const { token: t2, id: u2 } = await login(SUITE.p2);
  const stamp = Date.now();
  const cleanup = { wsId: null };

  try {
    const cws = await call('POST', '/workspaces', t1, { name: `builder-ws-${stamp}` });
    check('организация создана', cws.ok, `status ${cws.status}`);
    const wsId = cws.json.data.id;
    cleanup.wsId = wsId;

    await call('POST', `/workspaces/${wsId}/invitations`, t1, { phone: SUITE.p2 });
    const inc = await call('GET', '/workspaces/invitations/incoming', t2);
    const inv = (inc.json?.data ?? []).find((i) => i.workspaceId === wsId);
    if (inv) await call('POST', `/workspaces/invitations/${inv.id}/accept`, t2);
    const roster = await call('GET', `/workspaces/${wsId}/members`, t1);
    check('сотрудник нанят', (roster.json?.data ?? []).length === 2, String((roster.json?.data ?? []).length));

    await call('PATCH', `/workspaces/${wsId}/requisites`, t1, {
      orgForm: 'too',
      legalName: `ТОО «Билдер-${stamp}»`,
      legalAddress: 'г. Алматы, ул. Абая, 1',
    });

    const base = `/workspaces/${wsId}/documents`;
    const ct = await call('POST', `${base}/doc-types`, t1, {
      name: `Заявления-Б ${stamp}`,
      category: 'hr',
      numberFormat: 'БЛД-{ГГГГ}-{NNN}',
      visibility: 'team',
    });
    const typeId = ct.json?.data?.id;
    check('вид создан', ct.ok && !!typeId, `status ${ct.status}`);

    // ============================================================
    // 2. Builder-шаблон
    // ============================================================
    console.log('\n— Builder-шаблон —');
    const ctpl = await call('POST', `${base}/templates`, t1, {
      docTypeId: typeId,
      name: `Отпуск-конструктор ${stamp}`,
      kind: 'builder',
      selfService: true,
      fields: [
        { key: 'С', label: 'Дата начала', kind: 'date', required: true },
        { key: 'Дней', label: 'Дней', kind: 'number', required: true },
      ],
    });
    check('builder-шаблон создан', ctpl.ok, JSON.stringify(ctpl.json?.message ?? ctpl.status));
    const tplId = ctpl.json?.data?.id;
    check('kind в DTO', ctpl.json?.data?.kind === 'builder');
    check('пустой лист по умолчанию', Array.isArray(ctpl.json?.data?.builderDoc?.blocks));

    const withFile = await call('POST', `${base}/templates`, t1, {
      docTypeId: typeId, name: 'x', kind: 'builder', fileId: '00000000-0000-4000-8000-000000000000',
    });
    check('builder + fileId → 400', withFile.status === 400, `status ${withFile.status}`);

    const badPublish1 = await call('POST', `${base}/templates/${tplId}/publish`, t1);
    check('публикация пустого листа → 400', badPublish1.status === 400, `status ${badPublish1.status}`);

    const badDoc = doc([p([chip('Организация.Несуществующее')])]);
    await call('PATCH', `${base}/templates/${tplId}`, t1, { builderDoc: badDoc });
    const badPublish2 = await call('POST', `${base}/templates/${tplId}/publish`, t1);
    check('публикация с неизвестным чипом → 400 со списком', badPublish2.status === 400 && JSON.stringify(badPublish2.json).includes('Несуществующее'), `status ${badPublish2.status}`);

    seq = 0;
    const goodDoc = sampleBuilderDoc();
    const upd = await call('PATCH', `${base}/templates/${tplId}`, t1, { builderDoc: goodDoc });
    check('блоки сохранены', upd.ok && (upd.json?.data?.builderDoc?.blocks ?? []).length === goodDoc.blocks.length);

    const pub = await call('POST', `${base}/templates/${tplId}/publish`, t1);
    check('публикация прошла', pub.ok, JSON.stringify(pub.json?.message ?? pub.status));

    await call('POST', `${base}/templates/${tplId}/grants`, t1, { principalType: 'user', principalId: u2 });
    const avail = await call('GET', `${base}/available-templates`, t2);
    const gotTpl = (avail.json?.data ?? []).find((t) => t.id === tplId);
    check('сотрудник видит шаблон + kind', !!gotTpl && gotTpl.kind === 'builder');

    // Превью шаблона (менеджер)
    if (PDF_ON) {
      const pv = await previewPdf(t1, `${base}/templates/${tplId}/preview`);
      check('превью шаблона — настоящий PDF', pv.status === 201 || pv.status === 200, `status ${pv.status}`);
      check('превью: content-type pdf', pv.contentType.includes('application/pdf'), pv.contentType);
      check('превью: %PDF и размер', pv.bytes.slice(0, 4).toString() === '%PDF' && pv.bytes.length > 3000, String(pv.bytes.length));
      const pvOverride = await previewPdf(t1, `${base}/templates/${tplId}/preview`, doc([p([text('Свежий холст без сохранения')])]));
      check('превью несохранённых блоков', pvOverride.bytes.slice(0, 4).toString() === '%PDF');
      const pvStaff = await previewPdf(t2, `${base}/templates/${tplId}/preview`);
      check('превью шаблона — только Менеджер+', pvStaff.status === 403, `status ${pvStaff.status}`);
    } else {
      console.log('   (SKIP превью-PDF: GOTENBERG_URL не задан)');
    }

    // ============================================================
    // 3. Документ по builder-шаблону: файл = PDF
    // ============================================================
    console.log('\n— Документ по шаблону —');
    const cdoc = await call('POST', base, t2, {
      templateId: tplId,
      fields: { С: '2026-09-01', Дней: 14 },
    });
    check('документ создан', cdoc.ok, JSON.stringify(cdoc.json?.message ?? cdoc.status));
    const docId = cdoc.json?.data?.id;
    check('снимок блоков в документе', (cdoc.json?.data?.builderDoc?.blocks ?? []).length === goodDoc.blocks.length);

    if (PDF_ON) {
      const built = await waitFor(async () => {
        const g = await call('GET', `${base}/${docId}`, t2);
        return g.json?.data?.fileId ? g.json.data : null;
      });
      check('PDF-файл собрался джобом', !!built?.fileId);
      if (built?.fileId) {
        const bytes = await fetchFileBytes(t2, built.fileId);
        check('файл документа — PDF', !!bytes && bytes.slice(0, 4).toString() === '%PDF', String(bytes?.length));
      }

      // Правка блоков черновика доступна автору
      const patch = await call('PATCH', `${base}/${docId}`, t2, {
        builderDoc: doc([p([text('Новое тело документа '), chip('Сотрудник.ФИО')])]),
      });
      check('правка блоков черновика', patch.ok, `status ${patch.status}`);

      const pvDoc = await previewPdf(t2, `${base}/${docId}/preview`);
      check('превью документа — PDF', pvDoc.bytes.slice(0, 4).toString() === '%PDF', `status ${pvDoc.status}`);

      // Submit сразу после правки блоков упирается в страж пересборки («Документ
      // ещё пересобирается») — ретраим, как веб (он гасит кнопку по `rebuilding`
      // и опрашивает карточку). Пересборки схлопнуты (docGenKey: стабильный ключ
      // + парный, бэкофф 3с) — страж держит СЕКУНДЫ; 30 попыток по 1с — это
      // трипваер: разъедутся ключи или вернётся бэкофф 30с+ — сьют упадёт здесь.
      const sub = await waitFor(async () => {
        const r = await call('POST', `${base}/${docId}/submit`, t2);
        return r.ok ? r : null;
      }, { tries: 30 });
      check('отправка на маршрут', !!sub?.ok, JSON.stringify(sub?.json?.message ?? sub?.status ?? 'не дождались'));

      const withPdf = await waitFor(async () => {
        const g = await call('GET', `${base}/${docId}`, t2);
        return g.json?.data?.pdfFileId ? g.json.data : null;
      });
      check('PDF-отпечаток проставлен', !!withPdf?.pdfFileId);
      check('отпечаток = сам файл (builder)', withPdf?.pdfFileId === withPdf?.fileId);

      const patchLocked = await call('PATCH', `${base}/${docId}`, t2, { builderDoc: doc([p([text('взлом')])]) });
      check('после отправки правка закрыта', patchLocked.status === 403, `status ${patchLocked.status}`);
    } else {
      console.log('   (SKIP сборка/отпечаток: GOTENBERG_URL не задан)');
      const sub = await call('POST', `${base}/${docId}/submit`, t2);
      check('submit без PDF-рендера честно отказывает (файла нет)', sub.status === 400, `status ${sub.status}`);
    }

    // ============================================================
    // 4. Свободный документ с нуля
    // ============================================================
    console.log('\n— Свободный документ —');
    const freeForeign = await call('POST', `${base}/free`, t2, {
      docTypeId: typeId, title: 'На чужое имя', subjectUserId: u1,
    });
    check('рядовой НЕ заводит документ на другого', freeForeign.status === 403, `status ${freeForeign.status}`);

    const cfree = await call('POST', `${base}/free`, t2, {
      docTypeId: typeId,
      title: `Служебная записка ${stamp}`,
      builderDoc: doc([
        { id: 'h1', type: 'heading', props: { level: 1 }, content: [text('СЛУЖЕБНАЯ ЗАПИСКА')] },
        p([text('Прошу закупить канцтовары. Ответственный: '), chip('Сотрудник.ФИО')]),
        { id: 's1', type: 'signature', props: { role: 'Составил', nameSource: 'subject' } },
      ]),
    });
    check('свободный документ создан', cfree.ok, JSON.stringify(cfree.json?.message ?? cfree.status));
    const freeId = cfree.json?.data?.id;
    check('свободный: без шаблона', cfree.json?.data?.templateId === null);
    check('свободный: сторона — сам автор', cfree.json?.data?.subjectUserId === u2);

    // Свои поля свободного документа: без шаблона форму задаёт сам документ
    const ownFields = [{ key: 'Период', label: 'Период работ', kind: 'daterange', required: true }];
    const setOwn = await call('PATCH', `${base}/${freeId}`, t2, { formFields: ownFields });
    check('свободный: свои поля объявлены', setOwn.ok && (setOwn.json?.data?.formFields ?? []).length === 1, `status ${setOwn.status}`);
    const setVal = await call('PATCH', `${base}/${freeId}`, t2, {
      fields: { Период: { from: '2026-10-01', to: '2026-10-03' } },
    });
    check('свободный: значение периода принято по СВОЕМУ объявлению', setVal.json?.data?.fields?.['Период']?.to === '2026-10-03', JSON.stringify(setVal.json?.data?.fields));
    const dropped = await call('PATCH', `${base}/${freeId}`, t2, { formFields: [] });
    check('свободный: снятие поля убирает висячее значение', Object.keys(dropped.json?.data?.fields ?? {}).length === 0, JSON.stringify(dropped.json?.data?.fields));
    await call('PATCH', `${base}/${freeId}`, t2, { formFields: ownFields });

    // У документа ПО ШАБЛОНУ форма принадлежит шаблону — своей быть не может.
    // Черновик СВЕЖИЙ: у отправленного правка закрыта, и 403 пришёл бы мимо этой ветки.
    const freshTplDoc = await call('POST', base, t2, { templateId: tplId, fields: { С: '2026-09-01', Дней: 3 } });
    const tplDocOwn = await call('PATCH', `${base}/${freshTplDoc.json?.data?.id}`, t2, { formFields: ownFields });
    check(
      'документ по шаблону: свои поля отклонены с объяснением',
      tplDocOwn.status === 400 && String(tplDocOwn.json?.message ?? '').includes('шаблон'),
      `status ${tplDocOwn.status} ${JSON.stringify(tplDocOwn.json?.message ?? '')}`,
    );

    if (PDF_ON) {
      const freeBuilt = await waitFor(async () => {
        const g = await call('GET', `${base}/${freeId}`, t2);
        return g.json?.data?.fileId ? g.json.data : null;
      });
      check('свободный: PDF собрался', !!freeBuilt?.fileId);
      // Тот же страж пересборки. Два PATCH подряд больше НЕ дают два параллельных
      // джоба (стабильный ключ схлопывает, правку во время рендера докрывает
      // парный ключ) — 30с здесь трипваер против возврата старой гонки.
      const subFree = await waitFor(async () => {
        const r = await call('POST', `${base}/${freeId}/submit`, t2);
        return r.ok ? r : null;
      }, { tries: 30 });
      check(
        'свободный: отправка (маршрута нет — ждёт решения)',
        !!subFree?.ok && subFree?.json?.data?.status === 'in_review',
        subFree?.json?.data?.status ?? 'не дождались',
      );
      const wd = await call('POST', `${base}/${freeId}/withdraw`, t2);
      check('свободный: возврат в черновик', wd.ok && wd.json?.data?.status === 'draft', wd.json?.data?.status);
    }

    // docx-путь не сломан: шаблон без файла не публикуется прежним текстом
    const cDocx = await call('POST', `${base}/templates`, t1, { docTypeId: typeId, name: `Док-х ${stamp}` });
    const pubDocx = await call('POST', `${base}/templates/${cDocx.json?.data?.id}/publish`, t1);
    check('docx-шаблон без бланка → прежний 400', pubDocx.status === 400 && String(pubDocx.json?.message ?? '').includes('нет бланка'), `status ${pubDocx.status}`);

    // ============================================================
    // 5. Отчество в ФИО (группа «Сотрудник»)
    // ============================================================
    console.log('\n— Отчество —');
    const mPatch = await call('PATCH', '/users/me', t2, { middleName: 'Тестұлы' });
    check('отчество сохраняется в анкете', mPatch.ok, `status ${mPatch.status}`);
    // Дев-полигон резолва групп (development): значения глазами реестра
    const resolved = await call('POST', '/templates/dev/resolve', t1, {
      workspaceId: wsId,
      subjectUserId: u2,
    });
    if (resolved.status === 404) {
      console.log('   (SKIP резолв: дев-полигон выключен — не development)');
    } else {
      const emp = resolved.json?.data?.values?.['Сотрудник'] ?? {};
      check('ФИО содержит отчество (Фамилия Имя Отчество)', String(emp['ФИО'] ?? '').includes('Тестұлы'), String(emp['ФИО']));
      check('Отчество — отдельным полем', emp['Отчество'] === 'Тестұлы', String(emp['Отчество']));
    }
    await call('PATCH', '/users/me', t2, { middleName: null }); // прибрать за собой

    // ============================================================
    // 6. Период дат (kind='daterange')
    // ============================================================
    console.log('\n— Период дат —');
    const range = { from: '2026-09-01', to: '2026-09-14' };
    const rangeValues = require('@superapp/shared').expandDocFormValues({ Отпуск: range });
    const rDoc = doc([
      p([
        text('Прошу предоставить отпуск с '),
        chip('Форма.Отпуск С', 'дата:долгая'),
        text(' по '),
        chip('Форма.Отпуск По', 'дата'),
        text(' на '),
        chip('Форма.Отпуск Дней', 'прописью:число'),
        text(' дней, то есть '),
        chip('Форма.Отпуск'),
        text('.'),
      ]),
    ]);
    const rHtml = renderBuilderHtml(rDoc, rangeValues, { strict: false });
    check('период: «с» длинной датой', rHtml.html.includes('1 сентября 2026 г.'));
    check('период: «по» короткой датой', rHtml.html.includes('14.09.2026'));
    check('период: дней прописью', rHtml.html.includes('четырнадцать'));
    check('период: целиком строкой «с … по …»', rHtml.html.includes('с 01.09.2026 по 14.09.2026'));
    check('период: ничего не потерялось', rHtml.missing.length === 0, JSON.stringify(rHtml.missing));
    const oneDay = require('@superapp/shared').expandDocFormValues({ Отпуск: { from: '2026-09-01', to: '2026-09-01' } });
    check('один день: целиком = просто дата', oneDay['Отпуск'] === '01.09.2026', String(oneDay['Отпуск']));
    check('один день: дней = 1', oneDay['Отпуск Дней'] === 1, String(oneDay['Отпуск Дней']));

    const cRange = await call('POST', `${base}/templates`, t1, {
      docTypeId: typeId,
      name: `Отпуск-период ${stamp}`,
      kind: 'builder',
      selfService: true,
      builderDoc: rDoc,
      fields: [{ key: 'Отпуск', label: 'Отпуск', kind: 'daterange', required: true }],
    });
    const rangeTplId = cRange.json?.data?.id;
    check('шаблон с полем-периодом создан', cRange.ok, `status ${cRange.status}`);
    const pubRange = await call('POST', `${base}/templates/${rangeTplId}/publish`, t1);
    check('чипы «Отпуск С/По/Дней» — законные пути при публикации', pubRange.ok, JSON.stringify(pubRange.json?.message ?? pubRange.status));
    await call('POST', `${base}/templates/${rangeTplId}/grants`, t1, { principalType: 'user', principalId: u2 });

    const cRangeDoc = await call('POST', base, t2, { templateId: rangeTplId, fields: { Отпуск: range } });
    check('документ с периодом создан', cRangeDoc.ok, JSON.stringify(cRangeDoc.json?.message ?? cRangeDoc.status));
    const savedRange = cRangeDoc.json?.data?.fields?.['Отпуск'];
    check('период сохранился объектом {from,to}', savedRange?.from === range.from && savedRange?.to === range.to, JSON.stringify(savedRange));
    check('formFields в DTO несут kind периода', (cRangeDoc.json?.data?.formFields ?? []).some((f) => f.kind === 'daterange'));

    const cBadRange = await call('POST', base, t2, { templateId: rangeTplId, fields: { Отпуск: { from: 'мусор', to: 42 } } });
    check('невалидный период отрезан санитайзером', cBadRange.ok && cBadRange.json?.data?.fields?.['Отпуск'] === undefined, JSON.stringify(cBadRange.json?.data?.fields));
  } finally {
    if (cleanup.wsId) await call('DELETE', `/workspaces/${cleanup.wsId}`, t1).catch(() => undefined);
  }

  finish();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
