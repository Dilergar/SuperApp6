// ЭДО (внешний контур «Документооборота»): сквозной путь.
// Контрагент → документ (upload PDF) → номер → отправка (внутренние + гость) →
// подписи (ПЭП и mock-ЭЦП со сверкой БИН) → штамп → публичная проверка →
// скачивания гостя → подшивка → отказ/возврат → отзыв → истечение срока.
// Аккаунты СЬЮТА; гостевые номера рандомизированы (лимиты SMS на номер).
const { BASE, call, login, makeChecker, SUITE } = require('./_lib.cjs');
const crypto = require('crypto');
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');

const { check, finish } = makeChecker();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Поллинг до истины (джобы асинхронны: finished/штамп/подшивка) */
async function until(name, fn, timeoutMs = 45000, everyMs = 800) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(everyMs);
  }
}

/** Валидный БИН/ИИН (двухпроходный mod 11) */
function makeBin(prefix11) {
  const d = prefix11.split('').map(Number);
  const w1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const w2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];
  let s = d.reduce((acc, x, i) => acc + x * w1[i], 0) % 11;
  if (s === 10) {
    s = d.reduce((acc, x, i) => acc + x * w2[i], 0) % 11;
    if (s === 10) return null;
  }
  return prefix11 + String(s);
}
function randomBin() {
  for (let i = 0; i < 40; i++) {
    const bin = makeBin('9' + String(Math.floor(Math.random() * 1e10)).padStart(10, '0'));
    if (bin) return bin;
  }
  throw new Error('БИН не подобрался');
}

/** Минимальный КОРРЕКТНЫЙ PDF (1 страница, текст): pdf-lib обязан его открыть для штампа */
function makeMinimalPdf(text) {
  const esc = String(text).replace(/[^\x20-\x7e]/g, '').replace(/[()\\]/g, '');
  const header = '%PDF-1.4\n';
  const content = `BT /F1 12 Tf 50 780 Td (${esc}) Tj ET`;
  const o1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  const o2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
  const o3 =
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n';
  const o4 = `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`;
  const o5 = '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';
  const parts = [header, o1, o2, o3, o4, o5];
  const offsets = [];
  let pos = 0;
  for (const p of parts) {
    offsets.push(pos);
    pos += Buffer.byteLength(p, 'latin1');
  }
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  return Buffer.from(parts.join('') + xref + trailer, 'latin1');
}

/** Загрузка PDF обычным путём движка файлов (владелец — организация; профиль по умолчанию document) */
async function uploadPdf(token, wsId, name, label, profile = 'document') {
  const bytes = makeMinimalPdf(label);
  const init = await call('POST', '/files', token, {
    profile,
    name,
    size: bytes.length,
    mime: 'application/pdf',
    ownerWorkspaceId: wsId,
  });
  if (!init.ok) throw new Error(`files init: ${JSON.stringify(init.json)}`);
  const fileId = init.json.data.file.id;
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: 'application/pdf' }), name);
  const up = await fetch(`${BASE}/files/${fileId}/content`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token },
    body: fd,
  });
  if (!up.ok) throw new Error(`files content: ${up.status}`);
  const done = await call('POST', `/files/${fileId}/complete`, token, {});
  if (!done.ok) throw new Error(`files complete: ${JSON.stringify(done.json)}`);
  return fileId;
}

// Минимальный НАСТОЯЩИЙ .docx с тегами шаблона (копия хелпера verify-documents)
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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

async function uploadDocx(token, name, bytes) {
  const init = await call('POST', '/files', token, {
    profile: 'document', name, mime: DOCX_MIME, size: bytes.length,
  });
  if (!init.ok) throw new Error(`docx init: ${init.status} ${JSON.stringify(init.json)}`);
  const id = init.json.data.file.id;
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: DOCX_MIME }), name);
  const put = await fetch(`${BASE}/files/${id}/content`, {
    method: 'PUT', headers: { Authorization: 'Bearer ' + token }, body: fd,
  });
  if (!put.ok) throw new Error(`docx put: ${put.status}`);
  const done = await call('POST', `/files/${id}/complete`, token, {});
  if (!done.ok) throw new Error(`docx complete: ${done.status}`);
  return id;
}

/** Гостевые вызовы: свой транспорт (НИКОГДА не 401 — сверяется в каждой проверке) */
let sawGuest401 = false;
async function guest(method, p, session, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(session ? { 'x-share-session': session } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) sawGuest401 = true;
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, ok: res.ok, json, code: json?.details?.code ?? null };
}

async function devCode(challengeId) {
  const r = await call('GET', `/verify/dev/last-code?challengeId=${challengeId}`);
  return r.json?.data?.code ?? null;
}

/** Личность гостя: SMS-код по гостевой ссылке → verifyToken → сессия */
async function openGuestSession(token, phone, guestName) {
  const peek = await guest('GET', `/share-links/guest/${token}`);
  if (!peek.json?.data?.identityRequired) throw new Error('ссылка не требует личность');
  const started = await guest('POST', `/share-links/guest/${token}/identity/start`, null, { phone });
  if (!started.ok) throw new Error(`identity/start: ${JSON.stringify(started.json)}`);
  const code = await devCode(started.json.data.challengeId);
  const checked = await call('POST', '/verify/check', null, {
    challengeId: started.json.data.challengeId,
    code,
  });
  if (!checked.ok) throw new Error(`verify/check: ${JSON.stringify(checked.json)}`);
  const session = await guest('POST', `/share-links/guest/${token}/session`, null, {
    verifyToken: checked.json.data.verifyToken,
    guestName,
  });
  if (!session.ok) throw new Error(`session: ${JSON.stringify(session.json)}`);
  return session.json.data; // { sessionToken, view, guest }
}

/** ПЭП-подпись внутреннего подписанта (свой акт заявки) */
async function signPepAsUser(user, requestId) {
  const flow = await call('GET', `/sign/requests/${requestId}`, user.token);
  const actId = flow.json?.data?.myAct?.id;
  if (!actId) throw new Error(`нет своего акта у ${user.id}`);
  const start = await call('POST', `/sign/acts/${actId}/pep/start`, user.token, { consentAccepted: true });
  if (!start.ok) throw new Error(`pep/start: ${JSON.stringify(start.json)}`);
  const code = await devCode(start.json.data.challengeId);
  const confirm = await call('POST', `/sign/acts/${actId}/pep/confirm`, user.token, {
    challengeId: start.json.data.challengeId,
    code,
  });
  if (!confirm.ok) throw new Error(`pep/confirm: ${JSON.stringify(confirm.json)}`);
  return confirm.json.data;
}

const mockCms = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
const tokenOf = (url) => url.split('/s/')[1];

async function main() {
  const owner = await login(SUITE.p1);
  const second = await login(SUITE.p2);
  // +7 7007 RRRR NN — 12 знаков, КЗ-мобильный; RRRR рандомизирован на прогон
  // (лимиты SMS на номер — 5/час, и повторные прогоны не должны в них упираться)
  const rnd = String(Date.now()).slice(-4);
  const guestPhone = (n) => `+77007${rnd}${String(n).padStart(2, '0')}`;

  // --- Организация + найм второго подписанта ---
  const ws = (await call('POST', '/workspaces', owner.token, { name: `Сьют-ЭДО ${Date.now()}` })).json.data;
  await call('POST', `/workspaces/${ws.id}/invitations`, owner.token, { phone: SUITE.p2 });
  const myInv = (await call('GET', '/workspaces/invitations/incoming', second.token)).json?.data?.find?.(
    (i) => i.workspaceId === ws.id,
  );
  await call('POST', `/workspaces/invitations/${myInv?.id}/accept`, second.token);
  check('организация + найм', !!ws?.id && !!myInv?.id);

  // --- Контрагент + контакт ---
  const cpBin = randomBin();
  const contactPhone = guestPhone(1);
  const cp = (
    await call('POST', `/workspaces/${ws.id}/counterparties`, owner.token, {
      kind: 'legal',
      name: 'Ромашка-ЭДО',
      legalName: 'ТОО «Ромашка-ЭДО»',
      bin: cpBin,
      directorName: 'Асель Директор',
      signBasis: 'Устава',
    })
  ).json?.data;
  const contact = (
    await call('POST', `/workspaces/${ws.id}/counterparties/${cp.id}/contacts`, owner.token, {
      name: 'Асель Подписант',
      position: 'Директор',
      phone: contactPhone,
    })
  ).json?.data;
  check('контрагент + контакт', !!cp?.id && !!contact?.id);

  // Группа полей «Контрагент» в реестре шаблонов (дев-резолв)
  const fieldGroups = (await call('GET', '/templates/field-groups', owner.token)).json?.data?.groups ?? [];
  check('группа «Контрагент» в реестре полей', fieldGroups.some((g) => g.tagPrefix === 'Контрагент'));
  const resolved = (
    await call('POST', '/templates/dev/resolve', owner.token, {
      workspaceId: ws.id,
      counterpartyId: cp.id,
      counterpartyContactId: contact.id,
    })
  ).json?.data?.values;
  check(
    'резолв «Контрагент»: БИН и подписант',
    resolved?.['Контрагент']?.['БИН'] === cpBin && resolved?.['Контрагент']?.['Подписант'] === 'Асель Подписант',
    JSON.stringify(resolved?.['Контрагент'] ?? null),
  );

  // --- Виды: ПЭП (дефолт) и ЭЦП ---
  const docsBase = `/workspaces/${ws.id}/documents`;
  const typePep = (await call('POST', `${docsBase}/doc-types`, owner.token, { name: 'Договор (ПЭП)', category: 'external' }))
    .json?.data;
  const typeEcp = (
    await call('POST', `${docsBase}/doc-types`, owner.token, {
      name: 'Договор (ЭЦП)',
      category: 'external',
      signatureLevel: 'ecp',
    })
  ).json?.data;
  check('виды external созданы', typePep?.signatureLevel === 'pep' && typeEcp?.signatureLevel === 'ecp');
  const badType = await call('POST', `${docsBase}/doc-types`, owner.token, {
    name: 'Кривой',
    category: 'external',
    toPersonalFile: true,
  });
  check('external + личное дело → 400', badType.status === 400);

  // Маршрут для external-шаблона не публикуется (валидатор Процессов)
  const tplExt = (
    await call('POST', `${docsBase}/templates`, owner.token, { docTypeId: typePep.id, name: 'Бланк договора', kind: 'builder' })
  ).json?.data;
  const proc = (await call('POST', `/workspaces/${ws.id}/processes`, owner.token, { name: 'Маршрут-сьют', surface: 'documents.hr' }))
    .json?.data;
  if (proc?.id && tplExt?.id) {
    const document = {
      nodes: [
        { id: 'trg', type: 'trigger.document', label: 'Документ отправлен', config: { templateId: tplExt.id } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
      ],
      edges: [{ id: 'e1', from: 'trg', fromPort: 'main', to: 'end' }],
      form: [],
    };
    await call('PUT', `/workspaces/${ws.id}/processes/${proc.id}/document`, owner.token, { document });
    const pub = await call('POST', `/workspaces/${ws.id}/processes/${proc.id}/publish`, owner.token, {});
    check(
      'маршрут на external-шаблон не публикуется',
      pub.status === 400 && JSON.stringify(pub.json).includes('контрагент'),
      `got ${pub.status} ${JSON.stringify(pub.json?.errors ?? pub.json?.message ?? '')}`,
    );
    await call('DELETE', `/workspaces/${ws.id}/processes/${proc.id}`, owner.token);
  } else {
    check('маршрут на external-шаблон не публикуется', false, 'не собрался процесс');
  }

  // Нода «Сформировать документ» на external-шаблон — тот же запрет: она породила бы
  // документ «На маршруте», из которого для категории «С контрагентами» нет выхода
  // (submit его отвергает, «Отправить контрагенту» требует черновика).
  const procGen = (
    await call('POST', `/workspaces/${ws.id}/processes`, owner.token, { name: 'Маршрут-генерация', surface: 'documents.hr' })
  ).json?.data;
  if (procGen?.id && tplExt?.id) {
    const genDocument = {
      nodes: [
        { id: 'st', type: 'start', label: 'Старт', config: {} },
        { id: 'gen', type: 'doc.generate', label: 'Сформировать', config: { templateId: tplExt.id } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'st', fromPort: 'main', to: 'gen' },
        { id: 'e2', from: 'gen', fromPort: 'main', to: 'end' },
      ],
      form: [],
    };
    await call('PUT', `/workspaces/${ws.id}/processes/${procGen.id}/document`, owner.token, { document: genDocument });
    const pubGen = await call('POST', `/workspaces/${ws.id}/processes/${procGen.id}/publish`, owner.token, {});
    check(
      'нода «Сформировать документ» на external-шаблон не публикуется',
      pubGen.status === 400 && JSON.stringify(pubGen.json).includes('Сформировать документ'),
      `got ${pubGen.status} ${JSON.stringify(pubGen.json?.errors ?? pubGen.json?.message ?? '')}`,
    );
    await call('DELETE', `/workspaces/${ws.id}/processes/${procGen.id}`, owner.token);
  } else {
    check('нода «Сформировать документ» на external-шаблон не публикуется', false, 'не собрался процесс');
  }

  // ============================================================
  // Документ A: upload PDF → номер → отправка → подписи ПЭП → штамп
  // ============================================================
  const fileA = await uploadPdf(owner.token, ws.id, 'contract-a.pdf', 'Contract A body');
  const docA = (
    await call('POST', `${docsBase}/upload`, owner.token, {
      docTypeId: typePep.id,
      fileId: fileA,
      title: 'Договор поставки А-1',
      counterpartyId: cp.id,
      counterpartyContactId: contact.id,
    })
  ).json?.data;
  check('upload-документ создан (PDF = отпечаток сразу)', !!docA?.id && docA.pdfFileId === fileA, docA?.id);
  check('DTO несёт контрагента', docA?.counterparty?.id === cp.id && docA?.counterpartyContact?.id === contact.id);
  check('can.sendExternal / assignNumber', docA?.can?.sendExternal === true && docA?.can?.assignNumber === true);
  check('can.submit у external скрыт', docA?.can?.submit === false);

  // Дубль файла второй карточкой — нельзя
  const dupFile = await call('POST', `${docsBase}/upload`, owner.token, { docTypeId: typePep.id, fileId: fileA });
  check('файл уже карточка → 400', dupFile.status === 400);

  // submit (внутренний маршрут) для external закрыт
  const subm = await call('POST', `${docsBase}/${docA.id}/submit`, owner.token);
  check('submit для external → 400', subm.status === 400);

  // Номер до отправки
  const numbered = (await call('POST', `${docsBase}/${docA.id}/assign-number`, owner.token)).json?.data;
  check('номер присвоен черновику', !!numbered?.number, numbered?.number);
  const again = (await call('POST', `${docsBase}/${docA.id}/assign-number`, owner.token)).json?.data;
  check('повторный номер идемпотентен', again?.number === numbered?.number);

  // Отправка контрагенту
  const sentA = await call('POST', `${docsBase}/${docA.id}/send-external`, owner.token, {
    counterpartyContactId: contact.id,
    internalSignerUserIds: [owner.id, second.id],
    sendSms: true,
  });
  check('отправка контрагенту', sentA.ok && sentA.json?.data?.status === 'sent', JSON.stringify(sentA.json?.message ?? ''));
  const extA = sentA.json?.data?.external;
  check('external-блок: ссылка + 2 внутренних акта', !!extA?.link?.url && extA?.internalActs?.length === 2);
  check('срок по умолчанию ~30 дней', !!extA?.expiresAt);

  const dblSend = await call('POST', `${docsBase}/${docA.id}/send-external`, owner.token, {
    counterpartyContactId: contact.id,
    internalSignerUserIds: [owner.id],
  });
  check('повторная отправка → 400', dblSend.status === 400);
  const patchLocked = await call('PATCH', `${docsBase}/${docA.id}`, owner.token, { title: 'Взлом' });
  check('правка при sent закрыта (403)', patchLocked.status === 403);

  // Стопка «Ждут решения»: источник sign у второго подписанта
  const inbox = await call('GET', `/approvals/inbox?workspaceId=${ws.id}`, second.token);
  const signItems = (inbox.json?.data?.items ?? []).filter((i) => i.sourceKey === 'sign');
  check(
    'свободная подпись в стопке (источник sign, без кнопок)',
    signItems.some((i) => i.href?.includes(extA.requestId)) && signItems.every((i) => i.actions.length === 0),
    `items=${signItems.length}`,
  );

  // Внутренние подписи (ПЭП)
  await signPepAsUser(owner, extA.requestId);
  await signPepAsUser(second, extA.requestId);
  check('внутренние подписали (ПЭП)', true);

  // Гость: личность → просмотр → ПЭП-подпись
  const tokA = tokenOf(extA.link.url);
  const gsA = await openGuestSession(tokA, contactPhone, 'Асель Подписант');
  check('гостевая сессия открыта', !!gsA?.sessionToken && gsA?.view?.kind === 'sign');
  check('myAct пуст до действий', gsA.view.myAct === null);

  const pepStart = await guest('POST', `/share-links/guest/${tokA}/actions/sign.pep.start`, gsA.sessionToken, {
    consentAccepted: true,
    pdConsentAccepted: true,
  });
  check('гость: ПЭП-код ушёл', pepStart.ok, JSON.stringify(pepStart.json?.message ?? ''));
  const gCode = await devCode(pepStart.json?.data?.challengeId);
  const pepConfirm = await guest('POST', `/share-links/guest/${tokA}/actions/sign.pep.confirm`, gsA.sessionToken, {
    challengeId: pepStart.json?.data?.challengeId,
    code: gCode,
  });
  check('гость подписал ПЭП', pepConfirm.ok && pepConfirm.json?.data?.status === 'signed');

  // Вернувшийся подписант видит СВОЁ состояние
  const backView = await guest('GET', `/share-links/guest/${tokA}/view`, gsA.sessionToken);
  check('вернувшийся гость: myAct=signed', backView.json?.data?.view?.myAct?.status === 'signed');

  // Документ: sent → signed (хук finished), штамп собирается джобом
  const signedA = await until('doc signed', async () => {
    const d = (await call('GET', `${docsBase}/${docA.id}`, owner.token)).json?.data;
    return d?.status === 'signed' ? d : null;
  });
  check('документ A подписан обеими сторонами', !!signedA, signedA?.status);
  check('guestAct.matchesContact (номер = контакт)', signedA?.external?.guestAct?.matchesContact === true);

  const stamped = await until('stamp ready', async () => {
    const d = (await call('GET', `${docsBase}/${docA.id}`, owner.token)).json?.data;
    return d?.external?.stamped?.ready ? d.external.stamped : null;
  }, 60000);
  check('штампованная копия готова', !!stamped?.url);

  // Штамп: скачиваем, sha256 → публичная проверка находит как stamped_copy
  let stampedSha = null;
  if (stamped?.url) {
    const res = await fetch(stamped.url);
    const buf = Buffer.from(await res.arrayBuffer());
    check('штамп — настоящий PDF', buf.subarray(0, 5).toString() === '%PDF-');
    stampedSha = crypto.createHash('sha256').update(buf).digest('hex');
    const chk = await call('GET', `/sign/check?sha256=${stampedSha}`);
    check(
      'публичная проверка находит штампованную копию',
      chk.json?.data?.found === true && chk.json?.data?.matchedBy === 'stamped_copy',
      chk.json?.data?.matchedBy,
    );
    const chkSubject = await call('GET', `/sign/check?sha256=${signedA?.external ? (gsA.view.subject.sha256 ?? '') : ''}`);
    check(
      'проверка по отпечатку оригинала — subject',
      chkSubject.json?.data?.found === true && (chkSubject.json?.data?.matchedBy ?? 'subject') === 'subject',
    );
  } else {
    check('штамп — настоящий PDF', false, 'нет url');
    check('публичная проверка находит штампованную копию', false);
    check('проверка по отпечатку оригинала — subject', false);
  }

  // Гость скачивает свой экземпляр: штамп и экспортный пакет
  const gStamped = await fetch(`${BASE}/sign/guest/package?session=${encodeURIComponent(gsA.sessionToken)}&kind=stamped`);
  const gStampedBuf = Buffer.from(await gStamped.arrayBuffer());
  check(
    'гость скачал штампованный PDF',
    gStamped.ok && gStampedBuf.subarray(0, 5).toString() === '%PDF-',
    `${gStamped.status} ${gStampedBuf.subarray(0, 120).toString().replace(/\s+/g, ' ')}`,
  );
  const gZip = await fetch(`${BASE}/sign/guest/package?session=${encodeURIComponent(gsA.sessionToken)}&kind=zip`);
  const gZipBuf = Buffer.from(await gZip.arrayBuffer());
  check(
    'гость скачал экспортный ZIP',
    gZip.ok && gZipBuf.subarray(0, 2).toString() === 'PK',
    `${gZip.status} ${gZipBuf.subarray(0, 120).toString().replace(/\s+/g, ' ')}`,
  );

  // Хроника: отправка, подпись контрагента, подшивка штампованной копии
  const chronA = await until('filed chatter', async () => {
    const items = (await call('GET', `/chatter/org_document/${docA.id}`, owner.token)).json?.data?.items ?? [];
    const keys = items.map((e) => e.typeKey);
    return keys.includes('org_document.filed') ? keys : null;
  }, 60000);
  check(
    'хроника: sent_external + counterparty_signed + filed',
    !!chronA &&
      chronA.includes('org_document.sent_external') &&
      chronA.includes('org_document.counterparty_signed') &&
      chronA.includes('org_document.filed'),
    (chronA ?? []).join(','),
  );

  // Подшивка — ПРЯМАЯ проверка узла Диска, не только записи хроники
  const stateA = (await call('POST', `${docsBase}/dev/${docA.id}/state`, owner.token)).json?.data;
  check('карточка знает узел реестра Диска', !!stateA?.registryNodeId, JSON.stringify(stateA ?? null));
  if (stateA?.registryNodeId) {
    const node = await call('GET', `/drive/nodes/${stateA.registryNodeId}?workspaceId=${ws.id}`, owner.token);
    check(
      'узел реестра существует и несёт ПОДПИСАННУЮ копию',
      node.ok && JSON.stringify(node.json?.data ?? {}).includes('подписано'),
      `status ${node.status}`,
    );
  }

  // ============================================================
  // Документ B (ЭЦП): сверка сертификата с карточкой контрагента
  // ============================================================
  const fileB = await uploadPdf(owner.token, ws.id, 'contract-b.pdf', 'Contract B body');
  const docB = (
    await call('POST', `${docsBase}/upload`, owner.token, {
      docTypeId: typeEcp.id,
      fileId: fileB,
      title: 'Договор Б-2 (ЭЦП)',
      counterpartyId: cp.id,
      counterpartyContactId: contact.id,
    })
  ).json?.data;
  const sentB = (
    await call('POST', `${docsBase}/${docB.id}/send-external`, owner.token, {
      counterpartyContactId: contact.id,
      internalSignerUserIds: [owner.id],
    })
  ).json?.data;
  check('документ B отправлен (уровень ЭЦП)', sentB?.status === 'sent' && sentB?.external?.level === 'ecp');

  const tokB = tokenOf(sentB.external.link.url);
  const gsB = await openGuestSession(tokB, guestPhone(2), 'Асель Подписант');
  const subjectShaB = gsB.view.subject.sha256;

  // ЧУЖОЙ ключ: БИН сертификата не совпадает с карточкой → жёсткий отказ
  const wrongCms = await guest('POST', `/share-links/guest/${tokB}/actions/sign.cms`, gsB.sessionToken, {
    cms: mockCms({ sha256: subjectShaB, iin: '800101399999', bin: randomBin(), subjectCn: 'ТОО ЧУЖОЕ' }),
    consentAccepted: true,
    pdConsentAccepted: true,
  });
  check(
    'чужой БИН → sign_counterparty_mismatch',
    wrongCms.status === 400 && wrongCms.code === 'sign_counterparty_mismatch',
    `${wrongCms.status} ${wrongCms.code}`,
  );

  // Верный ключ юрлица контрагента
  const rightCms = await guest('POST', `/share-links/guest/${tokB}/actions/sign.cms`, gsB.sessionToken, {
    cms: mockCms({ sha256: subjectShaB, iin: '800101300123', bin: cpBin, subjectCn: 'ТОО «Ромашка-ЭДО»' }),
    consentAccepted: true,
    pdConsentAccepted: true,
  });
  check('верный БИН — подпись принята', rightCms.ok && rightCms.json?.data?.status === 'signed');

  // Внутренний подписант — ЭЦП mock
  const flowB = (await call('GET', `/sign/requests/${sentB.external.requestId}`, owner.token)).json?.data;
  // БЕЗ iin: у аккаунтов сьюта живёт настоящий users.iin (verify-requisites), и
  // выдуманный ИИН в mock-сертификате честно ловился бы сверкой личности движка.
  const cmsIn = await call('POST', `/sign/acts/${flowB?.myAct?.id}/cms`, owner.token, {
    cms: mockCms({ sha256: subjectShaB }),
  });
  check(
    'внутренний подписал ЭЦП',
    cmsIn.ok && cmsIn.json?.data?.status === 'signed',
    `${cmsIn.status} ${JSON.stringify(cmsIn.json?.message ?? '')} myAct=${flowB?.myAct?.id ?? 'null'}`,
  );

  const signedB = await until('doc B signed', async () => {
    const d = (await call('GET', `${docsBase}/${docB.id}`, owner.token)).json?.data;
    return d?.status === 'signed' ? d : null;
  });
  check('документ B подписан', !!signedB);

  // ============================================================
  // Документ C: отказ → возврат → отзыв → истечение
  // ============================================================
  const fileC = await uploadPdf(owner.token, ws.id, 'contract-c.pdf', 'Contract C body');
  const docC = (
    await call('POST', `${docsBase}/upload`, owner.token, {
      docTypeId: typePep.id,
      fileId: fileC,
      title: 'Договор В-3',
      counterpartyId: cp.id,
      counterpartyContactId: contact.id,
    })
  ).json?.data;

  // -- отказ гостя --
  const sentC1 = (
    await call('POST', `${docsBase}/${docC.id}/send-external`, owner.token, {
      counterpartyContactId: contact.id,
      internalSignerUserIds: [owner.id],
    })
  ).json?.data;
  const tokC1 = tokenOf(sentC1.external.link.url);
  const gsC1 = await openGuestSession(tokC1, guestPhone(3), 'Асель Подписант');
  const dec = await guest('POST', `/share-links/guest/${tokC1}/actions/sign.decline`, gsC1.sessionToken, {
    reason: 'Не согласны с пунктом 4.2',
  });
  check('гость отказал', dec.ok);
  const declined = await until('doc C declined', async () => {
    const d = (await call('GET', `${docsBase}/${docC.id}`, owner.token)).json?.data;
    return d?.status === 'declined_external' ? d : null;
  });
  check('документ → «Контрагент отказал»', !!declined);
  check('can.returnToDraft', declined?.can?.returnToDraft === true);

  const back = (await call('POST', `${docsBase}/${docC.id}/return-to-draft`, owner.token)).json?.data;
  check('возврат в черновик после отказа', back?.status === 'draft');

  // -- отзыв отправки --
  const sentC2 = (
    await call('POST', `${docsBase}/${docC.id}/send-external`, owner.token, {
      counterpartyContactId: contact.id,
      internalSignerUserIds: [owner.id],
    })
  ).json?.data;
  check('повторная отправка = НОВАЯ заявка', sentC2?.external?.requestId !== sentC1?.external?.requestId);
  const tokC2 = tokenOf(sentC2.external.link.url);
  const revoked = (await call('POST', `${docsBase}/${docC.id}/revoke-external`, owner.token)).json?.data;
  check('отзыв вернул в черновик', revoked?.status === 'draft');
  const deadPeek = await guest('GET', `/share-links/guest/${tokC2}`);
  check('ссылка после отзыва мертва (410)', deadPeek.status === 410, `got ${deadPeek.status}`);

  // -- истечение срока (dev-ручка + хук движка) --
  const sentC3 = (
    await call('POST', `${docsBase}/${docC.id}/send-external`, owner.token, {
      counterpartyContactId: contact.id,
      internalSignerUserIds: [owner.id],
    })
  ).json?.data;
  const expired = await call('POST', '/sign/dev/expire', owner.token, { requestId: sentC3.external.requestId });
  check('dev-истечение прогнало крон', expired.ok && expired.json?.data?.closed >= 1);
  const backToDraft = await until('doc C expired→draft', async () => {
    const d = (await call('GET', `${docsBase}/${docC.id}`, owner.token)).json?.data;
    return d?.status === 'draft' ? d : null;
  });
  check('истечение вернуло документ в черновик', !!backToDraft);
  const chronC = (await call('GET', `/chatter/org_document/${docC.id}`, owner.token)).json?.data?.items ?? [];
  check(
    'хроника C: counterparty_declined + external_returned + external_revoked + external_expired',
    [
      'org_document.counterparty_declined',
      'org_document.external_returned',
      'org_document.external_revoked',
      'org_document.external_expired',
    ].every((k) => chronC.some((e) => e.typeKey === k)),
    chronC.map((e) => e.typeKey).join(','),
  );

  // Инвариант гостевых ручек
  check('гость НИКОГДА не получал 401', sawGuest401 === false);

  // ============================================================
  // Документ D: ИЗ ШАБЛОНА с тегами {Контрагент.*} — сквозная сборка бланка
  // ============================================================
  const bankD = buildDocx([
    'Договор с {Контрагент.Название} (БИН {Контрагент.БИН})',
    'Подписант: {Контрагент.Подписант}, {Контрагент.Подписант Должность}',
  ]);
  const bankDId = await uploadDocx(owner.token, `blank-d-${rnd}.docx`, bankD);
  const tplD = (
    await call('POST', `${docsBase}/templates`, owner.token, {
      docTypeId: typePep.id,
      name: `Бланк договора Д ${rnd}`,
      fileId: bankDId,
      selfService: true,
      fields: [],
    })
  ).json?.data;
  const pubD = await call('POST', `${docsBase}/templates/${tplD?.id}/publish`, owner.token);
  check('docx-шаблон с тегами «Контрагент.*» опубликован', pubD.ok, JSON.stringify(pubD.json?.message ?? pubD.status));
  await call('POST', `${docsBase}/templates/${tplD?.id}/grants`, owner.token, {
    principalType: 'user',
    principalId: owner.id,
  });
  const docD = (
    await call('POST', docsBase, owner.token, {
      templateId: tplD?.id,
      title: `Договор Д ${rnd}`,
      counterpartyId: cp.id,
      counterpartyContactId: contact.id,
      fields: {},
    })
  ).json?.data;
  check('документ из шаблона создан', !!docD?.id, JSON.stringify(docD ?? null));
  const genD = await until('generate D', async () => {
    const d = (await call('GET', `${docsBase}/${docD.id}`, owner.token)).json?.data;
    return d?.fileId ? d : null;
  }, 60000);
  check('бланк собрался (строгий рендер: теги разрешились)', !!genD, genD ? genD.fileId : 'файл не появился за 60с');
  if (genD) {
    const dl = await call('GET', `/files/${genD.fileId}/download`, owner.token);
    const bytesD = Buffer.from(await (await fetch(dl.json.data.url)).arrayBuffer());
    const zipD = unzipSync(new Uint8Array(bytesD));
    const xmlD = strFromU8(zipD['word/document.xml']);
    check(
      'в собранном договоре — реквизиты контрагента, тегов не осталось',
      xmlD.includes(cpBin) && xmlD.includes('Асель Подписант') && !xmlD.includes('{Контрагент'),
      `бин=${xmlD.includes(cpBin)} подписант=${xmlD.includes('Асель Подписант')} тегов нет=${!xmlD.includes('{Контрагент')}`,
    );
  }
  // docD НЕ отменяем здесь: на нём ниже проверяется страж пересборки

  // ============================================================
  // Гейты, дописанные по ревью: архивный контрагент и чужой профиль файла
  // ============================================================
  // Отправка обязана видеть архив контрагента (жив ИМЕННО СЕЙЧАС, не «на создании»)
  const cpArch = (
    await call('POST', `/workspaces/${ws.id}/counterparties`, owner.token, {
      kind: 'legal',
      name: `Архивный ${rnd}`,
      bin: randomBin(),
    })
  ).json?.data;
  const ctArch = (
    await call('POST', `/workspaces/${ws.id}/counterparties/${cpArch.id}/contacts`, owner.token, {
      name: 'Ержан Архивный',
      phone: guestPhone(97),
    })
  ).json?.data;
  const fArch = await uploadPdf(owner.token, ws.id, `contract-arch-${rnd}.pdf`, 'Arch body');
  const docArch = (
    await call('POST', `${docsBase}/upload`, owner.token, {
      docTypeId: typePep.id,
      fileId: fArch,
      title: `Договор с архивным ${rnd}`,
      counterpartyId: cpArch.id,
      counterpartyContactId: ctArch.id,
    })
  ).json?.data;
  await call('DELETE', `/workspaces/${ws.id}/counterparties/${cpArch.id}`, owner.token);
  const sendArch = await call('POST', `${docsBase}/${docArch.id}/send-external`, owner.token, {
    counterpartyContactId: ctArch.id,
    internalSignerUserIds: [owner.id],
  });
  check(
    'отправка архивному контрагенту → 400',
    sendArch.status === 400 && JSON.stringify(sendArch.json).includes('архив'),
    `status ${sendArch.status} ${JSON.stringify(sendArch.json?.message ?? '')}`,
  );
  await call('POST', `${docsBase}/${docArch.id}/cancel`, owner.token);

  // Файл ЧУЖОГО профиля документом не становится (гейт профиля `document`)
  const alienFile = await uploadPdf(owner.token, ws.id, `alien-${rnd}.pdf`, 'Alien profile', 'generic');
  const alienDoc = await call('POST', `${docsBase}/upload`, owner.token, {
    docTypeId: typePep.id,
    fileId: alienFile,
    title: `Чужой профиль ${rnd}`,
  });
  check('файл чужого профиля → 400', alienDoc.status === 400, `status ${alienDoc.status}`);

  // ============================================================
  // Находки ревью 2026-08-17
  // ============================================================

  // -- Отказ СВОЕГО подписанта ≠ отказ контрагента --
  // Отказ одного закрывает всю заявку (правило движка), но виновником от этого не
  // становится вторая сторона: пока сторону не различали, документ получал статус
  // «Контрагент отказал», а автору уходило «Контрагент отказал» с причиной,
  // которую написал собственный сотрудник.
  const fileI = await uploadPdf(owner.token, ws.id, `contract-int-${rnd}.pdf`, 'Internal decline body');
  const docI = (
    await call('POST', `${docsBase}/upload`, owner.token, {
      docTypeId: typePep.id,
      fileId: fileI,
      title: `Договор внутр-отказ ${rnd}`,
      counterpartyId: cp.id,
      counterpartyContactId: contact.id,
    })
  ).json?.data;
  const sentI = (
    await call('POST', `${docsBase}/${docI.id}/send-external`, owner.token, {
      counterpartyContactId: contact.id,
      internalSignerUserIds: [owner.id],
    })
  ).json?.data;
  const myActI = (await call('GET', `/sign/requests/${sentI.external.requestId}`, owner.token)).json?.data?.myAct?.id;
  const decI = await call('POST', `/sign/acts/${myActI}/decline`, owner.token, {
    reason: 'Не согласован пункт с нашей стороны',
  });
  check('внутренний подписант отказался', decI.ok, `status ${decI.status}`);
  const afterI = await until('doc I resolved', async () => {
    const d = (await call('GET', `${docsBase}/${docI.id}`, owner.token)).json?.data;
    return d && d.status !== 'sent' ? d : null;
  });
  check(
    'отказ СВОЕГО подписанта → «Отклонён», а не «Контрагент отказал»',
    afterI?.status === 'rejected',
    `status ${afterI?.status}`,
  );
  check('после своего отказа документ снова редактируем и отправляем', afterI?.can?.sendExternal === true);
  check('«Вернуть в черновик» тут не при чём (это путь отказа контрагента)', afterI?.can?.returnToDraft === false);
  const notifI = (await call('GET', '/notifications?limit=30', owner.token)).json?.data?.items ?? [];
  check(
    'автору ушло «Подписант отказал», а не «Контрагент отказал»',
    notifI.some((n) => n.type === 'document.internal_declined') &&
      !notifI.some((n) => n.type === 'document.counterparty_declined' && n.payload?.title === docI.title),
    notifI
      .slice(0, 4)
      .map((n) => n.type)
      .join(','),
  );
  // Ссылка гаснет: собирать по ней подпись больше не будут
  const linkI = await guest('GET', `/share-links/guest/${tokenOf(sentI.external.link.url)}`);
  check('ссылка после своего отказа мертва', linkI.status === 410 || linkI.status === 404, `got ${linkI.status}`);

  // -- «Один файл — одна карточка» держится уникумом, а не проверкой чтением --
  const fileDup = await uploadPdf(owner.token, ws.id, `dup-${rnd}.pdf`, 'Dup body');
  const [dupA, dupB] = await Promise.all([
    call('POST', `${docsBase}/upload`, owner.token, {
      docTypeId: typePep.id,
      fileId: fileDup,
      title: `Дубль A ${rnd}`,
    }),
    call('POST', `${docsBase}/upload`, owner.token, {
      docTypeId: typePep.id,
      fileId: fileDup,
      title: `Дубль B ${rnd}`,
    }),
  ]);
  const created = [dupA, dupB].filter((r) => r.status === 201);
  check(
    'гонка двух загрузок одного файла даёт РОВНО одну карточку',
    created.length === 1,
    `A=${dupA.status} B=${dupB.status}`,
  );

  // -- Отправка контрагенту — Менеджер+; ссылку на подписание видит только Менеджер+ --
  // Вид «команда»: карточку видит вся организация, и до гейта любой сотрудник видел
  // адрес /s/<токен>, по которому можно подтвердить СВОЙ номер и подписать ПЭП
  // «за контрагента».
  const typeTeam = (
    await call('POST', `${docsBase}/doc-types`, owner.token, {
      name: `Договор-команда ${rnd}`,
      category: 'external',
      visibility: 'team',
    })
  ).json?.data;
  const fileTeam = await uploadPdf(owner.token, ws.id, `contract-team-${rnd}.pdf`, 'Team visibility body');
  const docTeam = (
    await call('POST', `${docsBase}/upload`, owner.token, {
      docTypeId: typeTeam.id,
      fileId: fileTeam,
      title: `Договор-команда ${rnd}`,
      counterpartyId: cp.id,
      counterpartyContactId: contact.id,
    })
  ).json?.data;
  await call('POST', `${docsBase}/${docTeam.id}/send-external`, owner.token, {
    counterpartyContactId: contact.id,
    internalSignerUserIds: [owner.id],
  });
  const teamAsOwner = (await call('GET', `${docsBase}/${docTeam.id}`, owner.token)).json?.data;
  const teamAsSecond = (await call('GET', `${docsBase}/${docTeam.id}`, second.token)).json?.data;
  check('менеджер видит адрес ссылки', !!teamAsOwner?.external?.link?.url);
  check(
    'сотрудник видит этап, но НЕ адрес ссылки',
    !!teamAsSecond?.external && teamAsSecond.external.link === null &&
      (teamAsSecond.external.internalActs?.length ?? 0) >= 1,
    JSON.stringify({ link: teamAsSecond?.external?.link, acts: teamAsSecond?.external?.internalActs?.length }),
  );

  const freeAsSecond = (
    await call('POST', `${docsBase}/free`, second.token, {
      docTypeId: typeTeam.id,
      title: `Черновик стажёра ${rnd}`,
      counterpartyId: cp.id,
    })
  ).json?.data;
  check('черновик external готовит кто угодно из команды', !!freeAsSecond?.id);
  check('can.sendExternal у стажёра-автора = false', freeAsSecond?.can?.sendExternal === false);
  const ownerView = (await call('GET', `${docsBase}/${freeAsSecond.id}`, owner.token)).json?.data;
  check('can.sendExternal у Менеджера+ на чужом черновике = true', ownerView?.can?.sendExternal === true);
  const sendAsSecond = await call('POST', `${docsBase}/${freeAsSecond.id}/send-external`, second.token, {
    counterpartyContactId: contact.id,
    internalSignerUserIds: [second.id],
  });
  check(
    'отправка контрагенту стажёром → 403 (Менеджер+)',
    sendAsSecond.status === 403 && JSON.stringify(sendAsSecond.json).includes('Менеджер'),
    `status ${sendAsSecond.status}`,
  );

  // -- Имя вида уникально среди живых (папка реестра на Диске ключуется именем) --
  const dupType = await call('POST', `${docsBase}/doc-types`, owner.token, {
    name: typePep.name.toUpperCase(),
    category: 'general',
  });
  check('одноимённый вид (без учёта регистра) → 409', dupType.status === 409, `status ${dupType.status}`);

  // -- Заморозка не берёт файл, который сейчас пересобирается --
  // PATCH полей ставит пересборку бланка фоном; немедленная отправка обязана
  // получить отказ, а не заморозить документ БЕЗ свежих данных (контрагент
  // подписывал договор с пустой графой номера при заполненной книге регистрации).
  await call('PATCH', `${docsBase}/${docD.id}`, owner.token, { fields: {} });
  const sendWhileRebuilding = await call('POST', `${docsBase}/${docD.id}/send-external`, owner.token, {
    counterpartyContactId: contact.id,
    internalSignerUserIds: [owner.id],
  });
  check(
    'отправка во время пересборки → 400',
    sendWhileRebuilding.status === 400 &&
      JSON.stringify(sendWhileRebuilding.json).includes('пересобирается'),
    `status ${sendWhileRebuilding.status} ${JSON.stringify(sendWhileRebuilding.json?.message ?? '')}`,
  );
  // Пересборка дожёвана → отправка проходит. Таймаут щедрый: у pdf-джоба
  // первая попытка застаёт конвертацию Collabora в полёте («PDF ещё
  // конвертируется» — это ретрай), а бэкофф движка джобов 30с ± джиттер.
  let sentAfterRebuild = null;
  let lastSendReply = null;
  {
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline && !sentAfterRebuild) {
      const r = await call('POST', `${docsBase}/${docD.id}/send-external`, owner.token, {
        counterpartyContactId: contact.id,
        internalSignerUserIds: [owner.id],
      });
      lastSendReply = `${r.status} ${JSON.stringify(r.json?.message ?? '')}`;
      if (r.ok) sentAfterRebuild = r.json?.data;
      else await new Promise((res) => setTimeout(res, 1500));
    }
  }
  check('после пересборки отправка проходит', sentAfterRebuild?.status === 'sent', lastSendReply ?? '');
  await call('POST', `${docsBase}/${docD.id}/revoke-external`, owner.token);

  // -- Штампованную копию нельзя снести обычной ручкой файлов --
  // `uploaderId` у штампа — отправитель, то есть до стены он сносил бы файл, на
  // который смотрят карточка, узел реестра Диска и кнопка контрагента.
  const stampedFileId = (
    await call('POST', '/sign/dev/state', owner.token, { requestId: extA.requestId })
  ).json?.data?.stampedFileId;
  if (stampedFileId) {
    const delStamped = await call('DELETE', `/files/${stampedFileId}`, owner.token);
    check('штампованную копию удалить руками нельзя', delStamped.status === 403, `status ${delStamped.status}`);
  } else {
    check('штампованную копию удалить руками нельзя', false, 'штамп не собрался — проверить нечего');
  }

  // ============================================================
  // Уборка: документы отменяем, карточку в архив (организация — на gc-скрипт)
  // ============================================================
  await call('POST', `${docsBase}/${docC.id}/cancel`, owner.token);
  await call('POST', `${docsBase}/${docI.id}/cancel`, owner.token);
  await call('POST', `${docsBase}/${docD?.id}/cancel`, owner.token);
  await call('POST', `${docsBase}/${docTeam?.id}/revoke-external`, owner.token);
  await call('POST', `${docsBase}/${docTeam?.id}/cancel`, owner.token);
  await call('POST', `${docsBase}/${freeAsSecond?.id}/cancel`, second.token);
  for (const r of created) {
    if (r.json?.data?.id) await call('POST', `${docsBase}/${r.json.data.id}/cancel`, owner.token);
  }
  // A и B подписаны — юридические записи, их не трогаем (организация сьюта уйдёт под gc)

  finish();
}

main().catch((e) => {
  console.error('CRASH', e);
  process.exit(1);
});
