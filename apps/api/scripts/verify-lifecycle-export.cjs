/* eslint-disable */
// Сьют выгрузок и восстановления арендатора (core/lifecycle Э6).
//
//   1. Архив человека: окно SMS-подтверждения `data_export` обязательно, раз в сутки, сборка
//      фазами, ZIP с манифестом и README, sha256 каждого куска, без секретов, без удалённого,
//      без id чужих людей в переписке; 5 выдач ссылки на часть — шестая 409; ссылка без окна
//      подтверждения — 403; истечение — 409 и байты удалены шагом срока.
//   2. Страж владельца (Google Takeout 2019): дев-подсадка чужой строки → сборка падает
//      `owner_mismatch`, байты не остаются.
//   3. Архив организации: только владелец (админ/сотрудник — 403), IBAN — маской, как в
//      продукте; фича тарифа выключена → 402; суточная квота байтов мала → сборка `quota`.
//   4. Восстановление арендатора (Кабинет): извлечение → потеря строк → импорт возвращает их
//      с теми же id; повтор — всё пропуск; подменённый манифест → 409; реплей стирания:
//      человек, стёртый после снимка, стирается в вернувшихся строках заново.
//
// Запуск: node scripts/verify-lifecycle-export.cjs (API на :3001, NODE_ENV=development)
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { unzipSync, strFromU8 } = require('fflate');
const { BASE, SUITE, makeChecker, crash, call, login, devCode, createSuiteWorkspace, consoleLogin, consoleSudo } = require('./_lib.cjs');
const { registrationConsents, acceptAllPending } = require('./_consents.cjs');
const { lifecycleExportFieldDenied } = require('@superapp/shared');

const { check, finish } = makeChecker();
const PW = SUITE.password;
const STORAGE = path.resolve(__dirname, '..', process.env.FILES_LOCAL_ROOT ?? './storage');
const rnd = () => nodeCrypto.randomBytes(3).toString('hex');
const sha = (buf) => nodeCrypto.createHash('sha256').update(buf).digest('hex');

async function stepUp(token, purpose) {
  const st = await call('POST', '/verify/step-up', token, { purpose, password: PW });
  if (!st.ok) return st;
  const code = await devCode(st.json.data.challengeId);
  const chk = await call('POST', '/verify/check', null, { challengeId: st.json.data.challengeId, code });
  if (!chk.ok) return chk;
  return call('POST', '/verify/step-up/confirm', token, { purpose, verifyToken: chk.json.data.verifyToken });
}

async function download(url) {
  const res = await fetch(url);
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}

/** Все ключи объектов (рекурсивно) — поиск секретов по именам полей. */
function keysDeep(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    out.add(k);
    keysDeep(x, out);
  }
  return out;
}

function readZip(buf) {
  const files = unzipSync(new Uint8Array(buf));
  const manifest = files['manifest.json'] ? JSON.parse(strFromU8(files['manifest.json'])) : null;
  const data = {};
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.startsWith('data/')) continue;
    const policy = name.slice(5).split('.')[0];
    data[policy] = [...(data[policy] ?? []), ...strFromU8(bytes).split('\n').filter(Boolean).map((l) => JSON.parse(l))];
  }
  return { files, manifest, data };
}

// ---------------------------------------------------------------- 1. архив человека
async function personArchive(prisma, s1, s2) {
  console.log('\n-- 1. архив человека --');
  const t1 = s1.token;
  await call('POST', '/verify/step-up/end', t1, { purpose: 'data_export' });
  let r = await call('POST', '/lifecycle/exports', t1);
  check('без окна подтверждения → 403 lifecycle.step_up_required', r.status === 403 && r.code === 'lifecycle.step_up_required', `${r.status} ${r.code}`);

  // Засев: живая и удалённая личная задача — вторая в архив не уходит
  const live = await call('POST', '/tasks', t1, { title: `Сьют экспорт живая ${rnd()}` });
  const gone = await call('POST', '/tasks', t1, { title: `Сьют экспорт в корзине ${rnd()}` });
  await call('POST', `/tasks/${gone.json?.data?.id}/trash`, t1);

  const su = await stepUp(t1, 'data_export');
  check('окно подтверждения data_export открыто (пароль + код)', su.ok, `${su.status} ${su.code ?? ''}`);
  r = await call('POST', '/lifecycle/exports', t1);
  // Раз в сутки: свежий прогон заказывает, повтор в сутках — 429 (прошлый прогон сьюта тоже занимает окно)
  const again = await call('POST', '/lifecycle/exports', t1);
  check('повторный заказ в те же сутки → 429 lifecycle.exportTooSoon', again.status === 429 && again.code === 'lifecycle.exportTooSoon', `${again.status} ${again.code}`);
  let exportId = r.ok ? r.json?.data?.id : null;
  if (r.ok) check('заказ принят: queued, человек — субъект', r.json?.data?.status === 'queued' && r.json?.data?.subjectType === 'user', r.json?.data?.status);
  else {
    check('первый заказ отвергнут только суточным окном прошлого прогона', r.status === 429, `${r.status} ${r.code}`);
    const dev = await call('POST', '/lifecycle/dev/exports', t1, {});
    exportId = dev.json?.data?.id;
  }
  r = await call('POST', `/lifecycle/dev/exports/${exportId}/run`, t1);
  const dto = r.json?.data;
  check('сборка готова: ready, части, срок 7 дней', r.ok && dto?.status === 'ready' && dto.parts.length >= 1 && Date.parse(dto.expiresAt) - Date.now() > 6.9 * 864e5, `${r.status} ${dto?.status} ${dto?.errorCode ?? ''}`);
  const list = await call('GET', '/lifecycle/exports', t1);
  check('список «мои выгрузки» — со сборкой и правом скачать', list.ok && list.json?.data?.items?.some((e) => e.id === exportId && e.canDownload), `${list.status}`);

  // Скачивание: ссылка → ZIP → манифест сходится с содержимым
  r = await call('POST', `/lifecycle/exports/${exportId}/parts/1/link`, t1);
  check('ссылка на часть выдана на 5 минут', r.ok && !!r.json?.data?.url && Date.parse(r.json.data.expiresAt) - Date.now() <= 301_000, `${r.status} ${r.code ?? ''}`);
  const dl = await download(r.json?.data?.url);
  check('часть скачивается по ссылке (ZIP)', dl.status === 200 && dl.buf.slice(0, 2).toString() === 'PK', `${dl.status}`);
  const lastPart = dto?.parts?.length ?? 1;
  let zip = readZip(dl.buf);
  if (lastPart > 1) {
    const l2 = await call('POST', `/lifecycle/exports/${exportId}/parts/${lastPart}/link`, t1);
    zip = readZip((await download(l2.json?.data?.url)).buf);
  }
  const m = zip.manifest;
  check('манифест и README в последней части', !!m && m.schema === 'superapp6.export/1' && m.mode === 'portable' && !!zip.files['README.txt'], `${m?.schema}`);
  if (lastPart === 1 && m) {
    const okHashes = m.entries.every((e) => zip.files[e.path] && sha(Buffer.from(zip.files[e.path])) === e.sha256);
    check('sha256 каждого куска совпадает с манифестом', okHashes);
    const okFiles = m.files.every((f) => zip.files[f.path] && sha(Buffer.from(zip.files[f.path])) === f.sha256);
    check('байты файлов совпадают с манифестом', okFiles, `${m.files.length} files`);
  }
  const users = zip.data.User ?? [];
  check('строка аккаунта — ровно одна, моя', users.length === 1 && users[0].id === s1.id, `${users.length}`);
  const allKeys = [...Object.values(zip.data)].reduce((acc, rows) => keysDeep(rows, acc), new Set());
  // Те же слова, что у сервера (сравниваются СЛОВА имени: thumbhash — не секрет, passwordHash — да)
  const secret = [...allKeys].filter((k) => lifecycleExportFieldDenied(k));
  check('секретов в архиве нет (пароль, хэши, шифротекст, подписи)', secret.length === 0, secret.join(','));
  const tasks = zip.data.Task ?? [];
  check('живая личная задача в архиве, удалённая — нет', tasks.some((t) => t.id === live.json?.data?.id) && !tasks.some((t) => t.id === gone.json?.data?.id), `${tasks.length}`);
  const msgText = JSON.stringify([...(zip.data.Message ?? []), ...(zip.data.Chat ?? [])]);
  check('в переписке нет id другого человека (имя — да, id — нет)', !msgText.includes(s2.id), `${(zip.data.Message ?? []).length} msgs`);
  check('чужие сообщения — без authorId', (zip.data.Message ?? []).every((x) => !('authorId' in x)));

  // Счёт выдач: пять на часть, шестая — 409 (Google Takeout)
  const used = (await prisma.lifecycleExport.findUnique({ where: { id: exportId }, select: { parts: true } })).parts[0].downloads;
  let last = null;
  for (let i = used; i < 5; i++) last = await call('POST', `/lifecycle/exports/${exportId}/parts/1/link`, t1);
  if (last) check('выдачи до пятой проходят', last.ok && last.json?.data?.downloadsLeft === 0, `${last.status} ${last.json?.data?.downloadsLeft}`);
  r = await call('POST', `/lifecycle/exports/${exportId}/parts/1/link`, t1);
  check('шестая выдача части → 409 lifecycle.exportDownloadsExhausted', r.status === 409 && r.code === 'lifecycle.exportDownloadsExhausted', `${r.status} ${r.code}`);
  const ev = await prisma.securityEvent.count({ where: { eventKey: 'data.export', subjectUserId: s1.id, targetId: exportId } });
  check('каждая выдача — data.export{lifecycle} в журнале человека', ev >= 1, `${ev}`);
  r = await call('POST', `/lifecycle/exports/${exportId}/parts/1/link`, s2.token);
  check('чужой архив — 404 (не оракул)', r.status === 404, `${r.status}`);

  // Без окна подтверждения ссылка не выдаётся
  const dev2 = await call('POST', '/lifecycle/dev/exports', t1, {});
  const id2 = dev2.json?.data?.id;
  await call('POST', `/lifecycle/dev/exports/${id2}/run`, t1);
  await call('POST', '/verify/step-up/end', t1, { purpose: 'data_export' });
  r = await call('POST', `/lifecycle/exports/${id2}/parts/1/link`, t1);
  check('ссылка без окна подтверждения → 403', r.status === 403 && r.code === 'lifecycle.step_up_required', `${r.status} ${r.code}`);

  // Истечение: срок прошёл → 409, шаг срока удаляет байты и переводит в expired
  await prisma.lifecycleExport.update({ where: { id: id2 }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await stepUp(t1, 'data_export');
  r = await call('POST', `/lifecycle/exports/${id2}/parts/1/link`, t1);
  check('истёкший архив → 409 lifecycle.exportExpired', r.status === 409 && r.code === 'lifecycle.exportExpired', `${r.status} ${r.code}`);
  const partKey = (await prisma.lifecycleExport.findUnique({ where: { id: id2 }, select: { parts: true } })).parts[0]?.key;
  r = await call('POST', '/lifecycle/dev/purge/run', t1, { policyId: 'derived:lifecycle_exports' });
  const after = await prisma.lifecycleExport.findUnique({ where: { id: id2 }, select: { status: true, parts: true } });
  check('шаг срока: expired, части сняты, байтов нет', r.ok && after?.status === 'expired' && after.parts.length === 0 && (!partKey || !fs.existsSync(path.join(STORAGE, partKey))), `${r.status} ${after?.status}`);
  await call('POST', '/verify/step-up/end', t1, { purpose: 'data_export' });
}

// ---------------------------------------------------------------- 2. страж владельца
async function ownerGuard(prisma, s1) {
  console.log('\n-- 2. перепроверка владельца (Takeout 2019) --');
  const dev = await call('POST', '/lifecycle/dev/exports', s1.token, { injectForeign: true });
  const id = dev.json?.data?.id;
  const r = await call('POST', `/lifecycle/dev/exports/${id}/run`, s1.token);
  check('подсаженная чужая строка → сборка failed owner_mismatch', r.ok && r.json?.data?.status === 'failed' && r.json?.data?.errorCode === 'owner_mismatch', `${r.json?.data?.status} ${r.json?.data?.errorCode}`);
  const leftovers = fs.existsSync(path.join(STORAGE, 'exports', id)) ? fs.readdirSync(path.join(STORAGE, 'exports', id), { recursive: true }).filter((f) => !fs.statSync(path.join(STORAGE, 'exports', id, String(f))).isDirectory()) : [];
  check('упавшая сборка байтов не оставила', leftovers.length === 0, leftovers.join(','));
  // Уведомление доходит фанаутом (джоб) — ждём до 10 секунд
  let n = 0;
  for (let i = 0; i < 40 && !n; i++) {
    n = await prisma.notification.count({ where: { userId: s1.id, type: 'lifecycle.export.failed', event: { refType: 'lifecycle_export', refId: id } } });
    if (!n) await new Promise((r) => setTimeout(r, 250));
  }
  check('заказчику — уведомление «не собран»', n >= 1, `${n}`);
}

// ---------------------------------------------------------------- 3. архив организации
async function workspaceArchive(prisma, s1, s2, ct) {
  console.log('\n-- 3. архив организации --');
  // Владелец — suite2: сотрудник Кабинета (suite1) не может быть целью команд над своей организацией
  const O = s2;
  const M = s1;
  const ws = await createSuiteWorkspace(O.token, 'Сьют-Выгрузка');
  const wsId = ws.json?.data?.id;
  const inv = await call('POST', `/workspaces/${wsId}/invitations`, O.token, { phone: SUITE.p1 });
  const mine = (await call('GET', '/workspaces/invitations/incoming', M.token)).json?.data?.find((i) => i.workspaceId === wsId);
  await call('POST', `/workspaces/invitations/${mine?.id ?? inv.json?.data?.id}/accept`, M.token);
  let r = await call('POST', `/workspaces/${wsId}/lifecycle/exports`, M.token);
  check('не владелец → 403 lifecycle.exportOwnerOnly', r.status === 403 && r.code === 'lifecycle.exportOwnerOnly', `${r.status} ${r.code}`);

  // Строгое поле: IBAN организации владелец видит маской — и в архиве маска
  const mod97 = (s) => { let x = 0; for (const ch of s) x = (x * 10 + Number(ch)) % 97; return x; };
  const body = Array.from({ length: 16 }, () => Math.floor(Math.random() * 10)).join('');
  const iban = `KZ${String(98 - mod97((body + 'KZ00').replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55)))).padStart(2, '0')}${body}`;
  const acc = await call('POST', `/workspaces/${wsId}/requisites/accounts`, O.token, { iban, bankName: 'Kaspi Bank', bik: 'CASPKZKA' });
  check('счёт организации заведён', acc.ok, `${acc.status} ${acc.code ?? ''}`);
  const WSH = { 'X-Workspace-Id': wsId };
  const orgTask = await call('POST', '/tasks', O.token, { title: `Сьют org export ${rnd()}` }, WSH);

  await stepUp(O.token, 'data_export');
  r = await call('POST', `/workspaces/${wsId}/lifecycle/exports`, O.token);
  check('владелец заказал архив организации', r.ok && r.json?.data?.subjectType === 'workspace', `${r.status} ${r.code ?? ''}`);
  const id = r.json?.data?.id;
  r = await call('POST', `/lifecycle/dev/exports/${id}/run`, O.token);
  check('архив организации собран', r.ok && r.json?.data?.status === 'ready', `${r.json?.data?.status} ${r.json?.data?.errorCode ?? ''}`);
  const link = await call('POST', `/lifecycle/exports/${id}/parts/1/link`, O.token);
  const zip = readZip((await download(link.json?.data?.url)).buf);
  const ws0 = (zip.data.Workspace ?? [])[0];
  check('строка организации в архиве', ws0?.id === wsId);
  const bank = (zip.data.WorkspaceBankAccount ?? [])[0];
  check('IBAN — маской, как в продукте (не открытым)', !!bank && typeof bank.iban === 'object' && bank.iban?.masked && !JSON.stringify(zip.data).includes(iban), JSON.stringify(bank?.iban));
  check('задача организации в архиве', (zip.data.Task ?? []).some((t) => t.id === orgTask.json?.data?.id));
  check('манифест называет поля под защитой видимости', Array.isArray(zip.manifest?.guarded?.WorkspaceBankAccount));
  // Ревью Б: качать архив организации заказчик может, ПОКА он её владелец — передал владение или
  // понижен → ссылки нет (иначе бывший владелец неделю качал бы данные организации). Роль гасится
  // строкой на время проверки (передача владения тащила бы тарифы и уведомления)
  const ownerRole = await prisma.userRole.findFirst({ where: { userId: O.id, context: 'workspace', tenantId: wsId, role: 'owner', isActive: true }, select: { id: true } });
  check('роль владельца найдена', !!ownerRole);
  if (ownerRole) {
    await prisma.userRole.update({ where: { id: ownerRole.id }, data: { isActive: false } });
    try {
      r = await call('POST', `/lifecycle/exports/${id}/parts/1/link`, O.token);
      check('бывший владелец ссылку на архив организации не получает (403 lifecycle.exportOwnerOnly)', r.status === 403 && r.code === 'lifecycle.exportOwnerOnly', `${r.status} ${r.code}`);
    } finally {
      await prisma.userRole.update({ where: { id: ownerRole.id }, data: { isActive: true } });
    }
    const back = await call('GET', `/workspaces/${wsId}/lifecycle/exports`, O.token);
    check('владелец снова качает: canDownload в списке', back.ok && (back.json?.data?.items ?? []).find((e) => e.id === id)?.canDownload === true, `${back.status}`);
  }
  const list = await call('GET', `/workspaces/${wsId}/lifecycle/exports`, M.token);
  check('список выгрузок организации — не владельцу/админу 404', list.status === 404, `${list.status}`);
  const chr = await prisma.chatterEntry.count({ where: { refType: 'lifecycle_settings', refId: wsId, typeKey: 'lifecycle_settings.export_requested' } });
  check('хроника раздела «Данные»: заказ архива', chr >= 1, `${chr}`);

  // Тариф: фича выключена → 402; квота байтов мала → сборка `quota`
  const ovr = async (key, value) =>
    call('POST', '/platform/commands/entitlements.override.set', ct, {
      input: { subject: { type: 'workspace', id: wsId }, key, mode: 'set', value, reason: 'suite: export plan conditions', validUntil: new Date(Date.now() + 3600_000).toISOString() },
      idempotencyKey: nodeCrypto.randomUUID(),
      reason: 'suite: export plan conditions',
    });
  const clear = (key) => call('POST', '/platform/commands/entitlements.override.clear', ct, { input: { subject: { type: 'workspace', id: wsId }, key }, idempotencyKey: nodeCrypto.randomUUID(), reason: 'suite: cleanup' });
  if (ct) {
    await prisma.lifecycleExport.updateMany({ where: { subjectId: wsId }, data: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
    let o = await ovr('lifecycle.export', false);
    r = await call('POST', `/workspaces/${wsId}/lifecycle/exports`, O.token);
    check('фича тарифа выключена → 402 entitlement', o.ok && r.status === 402, `${o.status} ${o.code ?? ''} / ${r.status} ${r.code}`);
    await clear('lifecycle.export');
    // Квота байтов в сутки: первый архив уже списан фактом сборки
    const used = Number((await prisma.quotaCounter.findUnique({ where: { subjectType_subjectId_key: { subjectType: 'workspace', subjectId: wsId, key: 'lifecycle.export.bytesPerDay' } } }))?.used ?? 0);
    check('квота списана фактом сборки (байты архива)', used > 0, `${used}`);
    o = await ovr('lifecycle.export.bytesPerDay', used);
    r = await call('POST', `/workspaces/${wsId}/lifecycle/exports`, O.token);
    check('квота исчерпана → заказ 402 entitlement.quota_exhausted', r.status === 402 && r.code === 'entitlement.quota_exhausted', `${r.status} ${r.code}`);
    // Остаток есть, но архив больше остатка → сборка падает `quota` до упаковки
    o = await ovr('lifecycle.export.bytesPerDay', used + 1);
    r = await call('POST', `/workspaces/${wsId}/lifecycle/exports`, O.token);
    const qid = r.json?.data?.id;
    const q = qid ? await call('POST', `/lifecycle/dev/exports/${qid}/run`, O.token) : null;
    check('архив больше остатка квоты → сборка failed quota', !!q && q.json?.data?.status === 'failed' && q.json?.data?.errorCode === 'quota', `${r.status} ${q?.json?.data?.status} ${q?.json?.data?.errorCode}`);
    await clear('lifecycle.export.bytesPerDay');
  }
  await call('POST', '/verify/step-up/end', O.token, { purpose: 'data_export' });
  return { wsId, WSH, O };
}

// ---------------------------------------------------------------- 4. восстановление арендатора
async function tenantRestore(prisma, s1, ct, org) {
  console.log('\n-- 4. восстановление арендатора --');
  if (!ct) return check('вход в Кабинет для команд восстановления', false);
  const { wsId, WSH, O } = org;
  const cmd = (key, input, preview = false) =>
    call('POST', `/platform/commands/${key}${preview ? '/preview' : ''}`, ct, preview ? { input } : { input, idempotencyKey: nodeCrypto.randomUUID(), reason: 'suite: tenant restore' });

  // Одноразовый человек в организации: его имя попадёт в снимок, потом он сотрёт аккаунт
  const phone = `+7700${String(Date.now() % 10_000_000).padStart(7, '0')}`;
  const consents = await registrationConsents(BASE);
  const lastName = `Реплей${rnd()}`;
  const reg = await call('POST', '/auth/register', null, { phone, password: PW, firstName: 'Стирание', lastName, dateOfBirth: '1990-01-01', consents });
  const accToken = reg.json?.data?.accessToken;
  const accId = accToken ? JSON.parse(Buffer.from(accToken.split('.')[1], 'base64url').toString()).sub : null;
  await acceptAllPending(BASE, accToken);
  const inv = await call('POST', `/workspaces/${wsId}/invitations`, O.token, { phone });
  const mine = (await call('GET', '/workspaces/invitations/incoming', accToken)).json?.data?.find((i) => i.workspaceId === wsId);
  await call('POST', `/workspaces/invitations/${mine?.id ?? inv.json?.data?.id}/accept`, accToken);
  const t = await call('POST', '/tasks', accToken, { title: `Сьют restore ${rnd()}` }, WSH);
  const entry = await prisma.chatterEntry.findFirst({ where: { workspaceId: wsId, actorId: accId }, orderBy: { id: 'desc' } });
  check('засев: задача и запись хроники с именем одноразового человека', t.ok && !!entry && String(entry.actorName ?? '').includes(lastName), `${t.status} ${entry?.actorName}`);

  let r = await cmd('lifecycle.restore.extract', { workspaceId: wsId }, true);
  const tables = r.json?.data?.result?.tables ?? [];
  check('предпросмотр извлечения: строки по таблицам', r.ok && tables.some((x) => x.policyId === 'Task' && x.rows >= 1), `${r.status} ${r.code ?? ''}`);
  r = await cmd('lifecycle.restore.extract', { workspaceId: wsId });
  const exportId = r.json?.data?.result?.exportId;
  check('извлечение поставлено (архив восстановления)', r.ok && !!exportId, `${r.status} ${r.code ?? ''} ${r.json?.data?.status}`);
  r = await call('POST', `/lifecycle/dev/exports/${exportId}/run`, s1.token);
  const row = await prisma.lifecycleExport.findUnique({ where: { id: exportId } });
  check('архив восстановления готов, манифест подписан', row?.status === 'ready' && row.mode === 'restore' && !!row.manifest?.signature?.sig, `${row?.status} ${row?.errorCode ?? ''}`);

  // Человек стирается ПОСЛЕ снимка
  const su = await call('POST', '/verify/step-up', accToken, { purpose: 'account_delete', password: PW });
  const code = await devCode(su.json?.data?.challengeId);
  const chk = await call('POST', '/verify/check', null, { challengeId: su.json?.data?.challengeId, code });
  await call('DELETE', '/users/me', accToken, { password: PW, verifyToken: chk.json?.data?.verifyToken });
  const req = await prisma.lifecycleErasureRequest.findFirst({ where: { subjectType: 'user', subjectId: accId }, orderBy: { requestedAt: 'desc' } });
  r = await call('POST', '/lifecycle/dev/erasure/run', s1.token, { requestId: req?.id, now: true });
  const erased = await prisma.chatterEntry.findUnique({ where: { id: entry.id } });
  check('стирание после снимка: имя в хронике уже томбстоун', r.ok && !String(erased?.actorName ?? '').includes(lastName), `${r.json?.data?.status} ${erased?.actorName}`);

  // Потеря данных: задача и запись хроники исчезли из живой базы
  await prisma.chatterEntry.delete({ where: { id: entry.id } });
  await prisma.task.delete({ where: { id: t.json.data.id } });
  r = await cmd('lifecycle.restore.import', { exportId }, true);
  const pv = r.json?.data?.result?.tables ?? [];
  check('предпросмотр импорта: вернётся задача, остальное уже есть', r.ok && pv.some((x) => x.policyId === 'Task' && x.rows > x.present), `${r.status} ${r.code ?? ''}`);
  r = await cmd('lifecycle.restore.import', { exportId });
  const runId = r.json?.data?.result?.runId;
  check('импорт поставлен', r.ok && !!runId, `${r.status} ${r.code ?? ''}`);
  r = await call('POST', `/lifecycle/dev/restores/${runId}/run`, s1.token);
  const rep = r.json?.data;
  const inserted = (rep?.tables ?? []).reduce((a, x) => a + x.inserted, 0);
  check('импорт: строки вернулись, прочее — пропуск, отказов нет', r.ok && rep?.status === 'done' && inserted >= 2 && (rep?.tables ?? []).every((x) => x.failed === 0), `${rep?.status} +${inserted}`);
  const back = await prisma.task.findUnique({ where: { id: t.json.data.id } });
  check('задача вернулась с тем же id', !!back && back.workspaceId === wsId);
  check('реплей стирания: человек, стёртый после снимка, стирается заново', (rep?.erasuresReplayed ?? 0) >= 1, `${rep?.erasuresReplayed}`);
  const replay = await prisma.lifecycleErasureRequest.findFirst({ where: { subjectType: 'user', subjectId: accId, id: { not: req?.id } }, orderBy: { requestedAt: 'desc' } });
  if (replay) await call('POST', '/lifecycle/dev/erasure/run', s1.token, { requestId: replay.id, now: true });
  const restored = await prisma.chatterEntry.findUnique({ where: { id: entry.id } });
  check('вернувшаяся запись хроники после реплея — без имени стёртого', !!restored && !String(restored.actorName ?? '').includes(lastName), restored?.actorName);
  const aud = await prisma.securityEvent.count({ where: { eventKey: 'lifecycle.restore.imported', workspaceId: wsId } });
  check('журнал организации: lifecycle.restore.imported', aud >= 1, `${aud}`);

  // Повтор сходится к тому же состоянию: живое — пропуск (id те же), вставляются только строки
  // стёртого человека (членство, приглашение), и реплей стирает их снова
  r = await cmd('lifecycle.restore.import', { exportId });
  const again = r.ok ? await call('POST', `/lifecycle/dev/restores/${r.json.data.result.runId}/run`, s1.token) : r;
  const ins2 = (again.json?.data?.tables ?? []).filter((x) => x.inserted > 0).map((x) => x.policyId);
  const erasedLeft = (await prisma.workspaceMember.count({ where: { workspaceId: wsId, userId: accId } })) + (await prisma.workspaceInvitation.count({ where: { workspaceId: wsId, toUserId: accId } }));
  check(
    'повторный импорт сходится: живое — пропуск, строки стёртого снова стёрты реплеем',
    again.ok && again.json?.data?.status === 'done' && ins2.every((p) => ['WorkspaceMember', 'WorkspaceInvitation', 'UserRole', 'ChatMember'].includes(p)) && erasedLeft === 0,
    `${again.status} +${ins2.join(',')} left=${erasedLeft}`,
  );

  // Подменённый манифест → отказ
  const mf = path.join(STORAGE, 'exports', exportId, 'manifest.json');
  if (fs.existsSync(mf)) {
    const orig = fs.readFileSync(mf);
    const bad = JSON.parse(orig.toString());
    bad.snapshotAt = new Date(0).toISOString();
    fs.writeFileSync(mf, JSON.stringify(bad));
    r = await cmd('lifecycle.restore.import', { exportId }, true);
    check('подменённый манифест → 409 lifecycle.restoreSignatureInvalid', r.status === 409 && r.code === 'lifecycle.restoreSignatureInvalid', `${r.status} ${r.code}`);
    fs.writeFileSync(mf, orig);
  }
  r = await cmd('lifecycle.restore.extract', { workspaceId: '00000000-0000-4000-8000-000000000000' }, true);
  check('извлечение несуществующей организации — пусто', r.ok && (r.json?.data?.result?.tables ?? []).length === 0, `${r.status}`);
}

async function main() {
  const prisma = new PrismaClient();
  const s1 = await login(SUITE.p1);
  const s2 = await login(SUITE.p2);
  const c = await consoleLogin(SUITE.p1);
  const ct = c.token;
  if (ct) await consoleSudo(ct);
  try {
    await personArchive(prisma, s1, s2);
    await ownerGuard(prisma, s1);
    const org = await workspaceArchive(prisma, s1, s2, ct);
    await tenantRestore(prisma, s1, ct, org);
  } finally {
    await prisma.$disconnect();
  }
  await finish();
}

main().catch(crash);
