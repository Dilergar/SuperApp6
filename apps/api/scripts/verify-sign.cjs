#!/usr/bin/env node
// ============================================================
// verify-sign.cjs — движок электронной подписи (core/sign, 15-й платформенный)
// ============================================================
// Гоняется ТОЛЬКО под аккаунтами сьюта (suite1/2/3 из _lib.cjs): база общая
// живая, и чистка «по userId» унесла бы реальные данные человека.
//
// Что проверяем (в порядке прогона):
//   Часть 1 — движок сам по себе (дев-полигон, без маршрутов):
//     · заморозка предмета ПЕРЕЖИВАЕТ правку исходника
//     · ПЭП сквозь: соглашение → код → акт → протокол
//     · согласие обязательно (без него код не уходит)
//     · повторная подпись отбивается (двойной клик)
//     · ЭЦП: сверка ИИН, отозванный сертификат, чужое содержимое
//     · публичная проверка по отпечатку и по токену; ИИН замаскирован
//     · протокол append-only, экспортный ZIP полон
//     · одноразовость и протухание QR-токенов
//     · mock-верификатор в прод-режиме отвергает ЭЦП
//   Часть 2 — связка с core/approvals:
//     · requiredSignatureKind блокирует обычный клик
//     · подпись закрывает шаг и двигает маршрут
//     · «нужен каждый» с двумя подписантами
//     · отказ с причиной → маршрут rejected
const crypto = require('crypto');
const { BASE, SUITE, call, login, makeChecker } = require('./_lib.cjs');

const { check, finish } = makeChecker();

/** «Контейнер CMS» для mock-верификатора: JSON, которым сьют управляет вердиктом */
function mockCms(opts = {}) {
  return Buffer.from(JSON.stringify(opts), 'utf8').toString('base64');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Код из dev-ручки движка подтверждений */
async function devCode(challengeId) {
  const r = await call('GET', `/verify/dev/last-code?challengeId=${challengeId}`, null);
  return r.json?.data?.code ?? null;
}

/**
 * Номер из тест-карты движка подтверждений (VERIFY_TEST_PHONES) и его фиксированный
 * код. Для гостя это не удобство, а условие повторяемости: обычный номер упирается
 * в потолок «5 SMS в час» на втором прогоне подряд.
 */
function testMap() {
  const out = new Map();
  for (const pair of (process.env.VERIFY_TEST_PHONES || '').split(',')) {
    const [phone, code] = pair.split(':').map((s) => (s || '').trim());
    if (phone && code) out.set(phone, code);
  }
  return out;
}
function testPhone() {
  // Первый номер карты — «внешний» гость: он не принадлежит ни одному аккаунту.
  return [...testMap().keys()][0] ?? '+77009990009';
}

/**
 * Код подтверждения: у номера из тест-карты он фиксирован в env (SMS не
 * отправлялась, и в Redis его нет), у обычного — берётся dev-ручкой движка.
 */
async function codeFor(phone, challengeId) {
  return testMap().get(phone) ?? (await devCode(challengeId));
}

/**
 * Прогнать крон движка, гасящий просроченные QR-сессии. HTTP-ручки у него нет и
 * быть не должно (это обслуживание, а не API), поэтому дёргаем метод сервиса
 * напрямую через Prisma — тот же приём, что в verify-files с FilesCron.
 */
/**
 * Отмотать срок заявки назад и прогнать крон движка. HTTP-ручки у обслуживания
 * нет и быть не должно, поэтому дёргаем через Prisma — приём verify-files с
 * FilesCron.
 */
async function sweepExpiredRequests(requestId) {
  try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    await prisma.signRequest.update({
      where: { id: requestId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const won = await tx.signRequest.updateMany({
        where: { id: requestId, status: 'pending' },
        data: { status: 'expired', completedAt: now },
      });
      if (won.count === 0) return;
      await tx.signAct.updateMany({
        where: { requestId, status: 'pending' },
        data: { status: 'expired' },
      });
    });
    const row = await prisma.signRequest.findUnique({
      where: { id: requestId },
      include: { acts: { select: { status: true } } },
    });
    await prisma.$disconnect();
    return { status: row?.status, actStatus: row?.acts[0]?.status };
  } catch {
    return null;
  }
}

async function expireQrSessions() {
  try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    const res = await prisma.signQrSession.updateMany({
      where: { status: { in: ['issued', 'claimed'] }, expiresAt: { lt: new Date() } },
      data: { status: 'expired' },
    });
    await prisma.$disconnect();
    return res.count;
  } catch {
    return null;
  }
}

async function main() {
  const status = await call('GET', '/sign/status', null);
  check('GET /sign/status отвечает', status.ok, `methods=${status.json?.data?.methods?.join(',')}`);
  if (!status.ok) return finish();
  const methods = status.json.data.methods;
  check('в dev доступны все три способа', methods.length === 3 && methods.includes('pep_otp'));
  check('mock-верификатор в dev ЭЦП принимает', status.json.data.ecpAccepted === true);

  // Цель `sign_pep` стартует ТОЛЬКО через контроллеры подписи (они проверили: акт
  // мой, соглашение принято). Публичный /verify/start обязан её отвергать — иначе
  // он превращается в бесплатную SMS-пушку на произвольный номер.
  const pushGun = await call('POST', '/verify/start', null, {
    phone: '+77009990009',
    purpose: 'sign_pep',
  });
  check(
    'публичный /verify/start цель sign_pep ОТВЕРГАЕТ',
    pushGun.status === 404 || pushGun.status === 400,
    `status=${pushGun.status}`,
  );

  const u1 = await login(SUITE.p1);
  const u2 = await login(SUITE.p2);

  // ============================================================
  // 1. Заморозка предмета
  // ============================================================
  const body1 = `ИСХОДНОЕ СОДЕРЖИМОЕ ${Date.now()}`;
  const made = await call('POST', '/sign/dev/requests', u1.token, {
    level: 'pep',
    title: 'Тест заморозки',
    body: body1,
  });
  check('дев-полигон завёл заявку', made.ok, JSON.stringify(made.json?.message ?? ''));
  if (!made.ok) return finish();

  const req1 = made.json.data.request;
  const stubFileId = made.json.data.stubFileId;
  check('заявка получила ЗАМОРОЖЕННУЮ копию, а не исходник', req1.subjectFileId !== stubFileId);
  check('отпечаток заморозки = отпечаток содержимого', req1.subjectSha256 === sha256(Buffer.from(body1, 'utf8')));
  check('у заявки один акт (я сам)', req1.acts.length === 1);
  check('акт ждёт подписи', req1.acts[0].status === 'pending');

  const flow1 = await call('GET', `/sign/requests/${req1.id}`, u1.token);
  check('экран подписания открывается', flow1.ok);
  check('в нём есть ссылка на замороженный документ', !!flow1.json?.data?.subject?.url);
  check('предъявлен текст соглашения сторон о ПЭП', (flow1.json?.data?.consentText ?? '').includes('46'));
  check('соглашение версионировано', !!flow1.json?.data?.consentVersion);

  // Чужой человек заявку не видит.
  const foreign = await call('GET', `/sign/requests/${req1.id}`, u2.token);
  check('посторонний заявку не видит (404)', foreign.status === 404);

  // ============================================================
  // 2. ПЭП сквозь
  // ============================================================
  const actId = req1.acts[0].id;

  const noConsent = await call('POST', `/sign/acts/${actId}/pep/start`, u1.token, { consentAccepted: false });
  check('без согласия код не отправляется (400)', noConsent.status === 400);

  const started = await call('POST', `/sign/acts/${actId}/pep/start`, u1.token, { consentAccepted: true });
  check('ПЭП: код отправлен', started.ok, JSON.stringify(started.json?.message ?? ''));
  if (!started.ok) return finish();
  check('номер в ответе маскирован', /\*|•/.test(started.json.data.phoneMasked) || started.json.data.phoneMasked.includes('…'));

  const code = await codeFor(SUITE.p1, started.json.data.challengeId);
  check('dev-код доступен скрипту', !!code);

  const wrong = await call('POST', `/sign/acts/${actId}/pep/confirm`, u1.token, {
    challengeId: started.json.data.challengeId,
    code: code === '000000' ? '111111' : '000000',
  });
  check('неверный код подпись не ставит', wrong.status === 400);

  // Код обязан быть из цепочки, заведённой ПОД ЭТУ подпись: ПЭП равнозначна
  // собственноручной именно как «код под конкретный документ» (ст. 46 п. 4 ЦК).
  const alienChain = await call('POST', `/sign/acts/${actId}/pep/confirm`, u1.token, {
    challengeId: '11111111-1111-4111-8111-111111111111',
    code,
  });
  check(
    'код из ЧУЖОЙ цепочки подпись не ставит',
    alienChain.status === 400 && alienChain.code === 'sign_otp_mismatch',
    `status=${alienChain.status} code=${alienChain.code}`,
  );

  const signed = await call('POST', `/sign/acts/${actId}/pep/confirm`, u1.token, {
    challengeId: started.json.data.challengeId,
    code,
  });
  check('ПЭП: акт подписан', signed.ok && signed.json.data.status === 'signed', JSON.stringify(signed.json?.message ?? ''));
  check('заявка закрылась целиком', signed.json?.data?.requestStatus === 'completed');

  // Повторная подпись тем же человеком.
  const again = await call('POST', `/sign/acts/${actId}/pep/start`, u1.token, { consentAccepted: true });
  check('повторная подпись отбивается', again.status === 400 && again.code === 'sign_already_signed', `code=${again.code}`);

  // Протокол.
  const events = await call('GET', `/sign/acts/${actId}/events`, u1.token);
  const types = (events.json?.data ?? []).map((e) => e.type);
  check('протокол ведётся', events.ok && types.length >= 4, types.join(','));
  check('в протоколе есть согласие', types.includes('consent'));
  check('в протоколе есть отправка и проверка кода', types.includes('otp_sent') && types.includes('otp_verified'));
  check('в протоколе есть сама подпись', types.includes('signed'));
  check('id событий — СТРОКИ (BigInt на проводе)', typeof events.json.data[0].id === 'string');

  // Акт в заявке.
  const after = await call('GET', `/sign/requests/${req1.id}`, u1.token);
  const act1 = after.json.data.request.acts[0];
  check('в акте сохранён снимок соглашения', (act1.consentText ?? '').length > 50);
  check('уровень подписи — простая (pep)', act1.level === 'pep');
  check('способ записан', act1.method === 'pep_otp');
  check('есть ссылка публичной проверки', !!act1.checkUrl && act1.checkUrl.includes('/check/'));

  // ============================================================
  // 3. Заморозка НЕ ЗАВИСИТ от судьбы исходника
  // ============================================================
  // Главное свойство движка: подписанные байты живут своей жизнью. Проверяем
  // прямо — сносим ИСХОДНЫЙ файл и убеждаемся, что замороженная копия цела и
  // по-прежнему отдаётся подписанту.
  check('отпечаток акта = отпечаток заявки', act1.subjectSha256 === req1.subjectSha256);
  const killed = await call('DELETE', `/files/${stubFileId}`, u1.token);
  check('исходник удалён', killed.ok || killed.status === 404, `status=${killed.status}`);
  const gone = await call('GET', `/files/${stubFileId}`, u1.token);
  check('исходника больше нет', gone.status === 404, `status=${gone.status}`);

  const subj = await call('GET', `/sign/requests/${req1.id}`, u1.token);
  check(
    'ЗАМОРОЖЕННАЯ копия пережила удаление исходника',
    subj.ok && subj.json.data.subject.sha256 === req1.subjectSha256,
    `sha=${subj.json?.data?.subject?.sha256?.slice(0, 12)}`,
  );
  const bytes = await fetch(subj.json.data.subject.url);
  const frozen = Buffer.from(await bytes.arrayBuffer());
  check('байты замороженной копии читаются и совпадают', sha256(frozen) === req1.subjectSha256);

  // Доказательства подписания НЕУДАЛЯЕМЫ — и это не про «чужое трогать нельзя»:
  // загрузившим движок записывает самого ПОДПИСАНТА, то есть того, у кого есть
  // мотив отказаться от своей подписи. Пока стены не было, он сносил замороженную
  // копию и контейнер CMS обычной ручкой, а крон ретеншна через неделю стирал байты.
  const killEvidence = await call('DELETE', `/files/${subj.json.data.subject.fileId}`, u1.token);
  check(
    'замороженную копию удалить НЕЛЬЗЯ даже загрузившему',
    killEvidence.status === 403,
    `status=${killEvidence.status}`,
  );
  const afterKill = await call('GET', `/sign/requests/${req1.id}`, u1.token);
  check(
    'после попытки удаления замороженная копия на месте',
    afterKill.ok && afterKill.json.data.subject.sha256 === req1.subjectSha256,
  );

  // ============================================================
  // 4. Публичная проверка (ст. 61 ЦК)
  // ============================================================
  const byHash = await call('GET', `/sign/check?sha256=${req1.subjectSha256}`, null);
  check('проверка по отпечатку файла (без токена)', byHash.ok && byHash.json.data.found === true);
  check('в проверке видна подпись', byHash.json?.data?.signatures?.length === 1);
  check('уровень подписи назван честно', byHash.json.data.signatures[0].level === 'pep');

  const bogus = await call('GET', `/sign/check?sha256=${'0'.repeat(64)}`, null);
  check('чужой отпечаток ничего не находит', bogus.ok && bogus.json.data.found === false);

  const m = /\/check\/([^?]+)\?k=(.+)$/.exec(act1.checkUrl);
  const byToken = await call('GET', `/sign/check?actId=${m[1]}&k=${encodeURIComponent(m[2])}`, null);
  check('проверка по токену из QR', byToken.ok && byToken.json.data.found === true);
  const badToken = await call('GET', `/sign/check?actId=${m[1]}&k=nope-nope-nope`, null);
  check('подделанный токен ничего не открывает', badToken.ok && badToken.json.data.found === false);

  // ============================================================
  // 5. ЭЦП: содержимое, цепочка, ИИН
  // ============================================================
  const ecpBody = `ДОКУМЕНТ ДЛЯ ЭЦП ${Date.now()}`;
  const ecpMade = await call('POST', '/sign/dev/requests', u1.token, {
    level: 'ecp',
    title: 'Тест ЭЦП',
    body: ecpBody,
  });
  check('заявка уровня ЭЦП заведена', ecpMade.ok);
  const ecpReq = ecpMade.json.data.request;
  check('у ЭЦП-заявки только ЭЦП-способы', !ecpReq.methods.includes('pep_otp'), ecpReq.methods.join(','));
  const ecpAct = ecpReq.acts[0].id;
  const ecpSha = ecpReq.subjectSha256;

  const pepOnEcp = await call('POST', `/sign/acts/${ecpAct}/pep/start`, u1.token, { consentAccepted: true });
  check(
    'простой подписью ЭЦП-документ не подписать',
    pepOnEcp.status === 400 && pepOnEcp.code === 'sign_method_not_allowed',
    `code=${pepOnEcp.code}`,
  );

  const wrongData = await call('POST', `/sign/acts/${ecpAct}/cms`, u1.token, {
    cms: mockCms({ sha256: '1'.repeat(64), iin: null }),
  });
  check(
    'подпись под ЧУЖИМ содержимым отвергается',
    wrongData.status === 400 && wrongData.code === 'sign_cms_invalid',
    `code=${wrongData.code}`,
  );

  const revoked = await call('POST', `/sign/acts/${ecpAct}/cms`, u1.token, {
    cms: mockCms({ sha256: ecpSha, ocspStatus: 'revoked' }),
  });
  check(
    'отозванный сертификат отвергается',
    revoked.status === 400 && revoked.code === 'sign_chain_invalid',
    `code=${revoked.code}`,
  );

  // После двух отказов акт «failed» — на новую попытку заводим свежую заявку.
  const ecp2 = await call('POST', '/sign/dev/requests', u1.token, { level: 'ecp', title: 'Тест ИИН', body: ecpBody });
  const act2 = ecp2.json.data.request.acts[0].id;
  const sha2 = ecp2.json.data.request.subjectSha256;

  // Сверка личности работает, только когда ИИН аккаунта заполнен, — поэтому
  // сначала заполняем его и УБЕЖДАЕМСЯ в этом, иначе тест молча проверял бы
  // «подпись прошла» вместо «подпись отвергнута».
  const me = await call('GET', '/users/me', u1.token);
  const testIin = me.json?.data?.iin || '900101300126';
  if (!me.json?.data?.iin) {
    const patched = await call('PATCH', '/users/me', u1.token, { iin: testIin });
    check('ИИН аккаунта заполнен (предусловие сверки личности)', patched.ok, JSON.stringify(patched.json?.message ?? ''));
  }
  const meNow = await call('GET', '/users/me', u1.token);
  check('ИИН виден в профиле', meNow.json?.data?.iin === testIin, `iin=${meNow.json?.data?.iin}`);

  const mismatch = await call('POST', `/sign/acts/${act2}/cms`, u1.token, {
    cms: mockCms({ sha256: sha2, iin: '123456789013' }),
  });
  check(
    'ЧУЖОЙ ключ (несовпадение ИИН) отвергается',
    mismatch.status === 400 && mismatch.code === 'sign_iin_mismatch',
    `code=${mismatch.code}`,
  );
  // Акт после неудачной попытки ОСТАЁТСЯ живым: опечатка в выборе сертификата не
  // должна навсегда лишать человека возможности подписать.
  const retry = await call('POST', `/sign/acts/${act2}/cms`, u1.token, {
    cms: mockCms({ sha256: sha2, iin: testIin }),
  });
  check('после отказа можно подписать заново', retry.ok && retry.json.data.status === 'signed');

  const ecp3 = await call('POST', '/sign/dev/requests', u1.token, { level: 'ecp', title: 'ЭЦП ok', body: ecpBody });
  const act3 = ecp3.json.data.request.acts[0].id;
  const sha3 = ecp3.json.data.request.subjectSha256;
  const okEcp = await call('POST', `/sign/acts/${act3}/cms`, u1.token, {
    cms: mockCms({ sha256: sha3, iin: testIin, subjectCn: 'ТЕСТОВ ТЕСТ' }),
  });
  check('ЭЦП своим ключом принимается', okEcp.ok && okEcp.json.data.status === 'signed', JSON.stringify(okEcp.json?.message ?? ''));

  const ecpFlow = await call('GET', `/sign/requests/${ecp3.json.data.request.id}`, u1.token);
  const signedAct = ecpFlow.json.data.request.acts[0];
  check('вердикт цепочки ЗАМОРОЖЕН в акте', signedAct.certificate?.chainValid === true);
  check('статус OCSP заморожен', signedAct.certificate?.ocspStatus === 'good');
  check('метка времени TSP записана', !!signedAct.certificate?.tspAt);
  check('время подписи = метке TSP', signedAct.signedAt === signedAct.certificate.tspAt);
  check('серийник сертификата сохранён', !!signedAct.certificate?.serial);

  const pub = await call('GET', `/sign/check?sha256=${sha3}`, null);
  check('ИИН на публичной странице МАСКИРОВАН', /•/.test(pub.json.data.signatures[0].iinMasked ?? ''), pub.json.data.signatures[0].iinMasked);
  // Внутри CMS лежит сертификат с ПОЛНЫМ ИИН, поэтому сырые контейнеры получает
  // не всякий, у кого есть файл, а только пришедший по ссылке проверки (QR на
  // протоколе, манифест пакета) — то есть сторона документа. Вердикт открыт всем.
  check('по одному отпечатку сырые контейнеры НЕ раздаются', pub.json.data.downloads.length === 0);
  const em = /\/check\/([^?]+)\?k=(.+)$/.exec(signedAct.checkUrl);
  const pubByToken = await call('GET', `/sign/check?actId=${em[1]}&k=${encodeURIComponent(em[2])}`, null);
  check(
    'по ссылке проверки контейнер CMS отдаётся для сторонней проверки',
    pubByToken.json.data.downloads.some((d) => d.kind === 'cms'),
  );

  // ============================================================
  // 6. QR: одноразовость
  // ============================================================
  const qrReq = await call('POST', '/sign/dev/requests', u1.token, { level: 'ecp', title: 'QR', body: 'QR-документ' });
  const qrAct = qrReq.json.data.request.acts[0].id;
  const qrSha = qrReq.json.data.request.subjectSha256;
  const qr = await call('POST', `/sign/acts/${qrAct}/qr/start`, u1.token, {});
  check('QR-сессия заведена', qr.ok && qr.json.data.qrDataUrl.startsWith('data:image/svg+xml'));
  check('QR помечен как mock (мост не подключён)', qr.json.data.mock === true);

  // mock-мост кладёт в ссылку ОБА адреса — иначе сыграть за телефон невозможно.
  const deep = new URL(qr.json.data.deepLink);
  const dataToken = new URL(deep.searchParams.get('data')).pathname.split('/').pop();
  const signToken = deep.pathname.split('/').pop();

  const claim1 = await call('GET', `/sign/qr/data/${dataToken}`, null);
  check('[eGov] данные на подпись забраны', claim1.ok && !!claim1.json.data.base64);
  check('отданы ЗАМОРОЖЕННЫЕ байты', sha256(Buffer.from(claim1.json.data.base64, 'base64')) === qrSha);
  const claim2 = await call('GET', `/sign/qr/data/${dataToken}`, null);
  check(
    'повторный заход по тому же токену отбивается (одноразовость)',
    claim2.status === 400 && claim2.code === 'sign_qr_session_dead',
    `code=${claim2.code}`,
  );

  const submit1 = await call('POST', `/sign/qr/submit/${signToken}`, null, {
    cms: mockCms({ sha256: qrSha, iin: testIin }),
  });
  check('[eGov] подпись принята мостом', submit1.ok, JSON.stringify(submit1.json?.message ?? ''));
  const submit2 = await call('POST', `/sign/qr/submit/${signToken}`, null, { cms: mockCms({ sha256: qrSha }) });
  check(
    'повторная отправка подписи отбивается',
    submit2.status === 400 && submit2.code === 'sign_qr_session_dead',
    `code=${submit2.code}`,
  );

  const qrState = await call('GET', `/sign/acts/${qrAct}/state`, u1.token);
  check('акт после QR подписан', qrState.json?.data?.status === 'signed');

  // Протухание: сессия живёт минуты (требование паспорта Smart Bridge —
  // ограничение URL по времени). Проверяем и срок в ответе, и то, что крон
  // движка гасит просроченные.
  const qr2Req = await call('POST', '/sign/dev/requests', u1.token, { level: 'ecp', title: 'QR TTL', body: 'ttl' });
  const qr2 = await call('POST', `/sign/acts/${qr2Req.json.data.request.acts[0].id}/qr/start`, u1.token, {});
  const ttlSec = (new Date(qr2.json.data.expiresAt).getTime() - Date.now()) / 1000;
  check('у QR-сессии конечный срок', ttlSec > 0 && ttlSec <= 600, `${Math.round(ttlSec)}с`);
  const expired = await expireQrSessions();
  check('крон гасит просроченные QR-сессии', expired !== null, `погашено: ${expired}`);
  // Новый старт гасит предыдущую сессию: живой QR должен быть ровно один, иначе
  // отсканированный с чужого экрана старый код подписал бы «то же самое» вторым путём.
  const qr3 = await call('POST', `/sign/acts/${qr2Req.json.data.request.acts[0].id}/qr/start`, u1.token, {});
  const oldSign = new URL(qr2.json.data.deepLink).pathname.split('/').pop();
  const stale = await call('POST', `/sign/qr/submit/${oldSign}`, null, { cms: mockCms({}) });
  check(
    'новый QR гасит предыдущую сессию',
    stale.status === 400 && stale.code === 'sign_qr_session_dead',
    `code=${stale.code}`,
  );
  check('новая сессия жива', qr3.ok);

  // ============================================================
  // 7. Отказ подписанта
  // ============================================================
  const decReq = await call('POST', '/sign/dev/requests', u1.token, { level: 'pep', title: 'Отказ', body: 'Отказной' });
  const decAct = decReq.json.data.request.acts[0].id;
  const noReason = await call('POST', `/sign/acts/${decAct}/decline`, u1.token, { reason: '' });
  check('отказ без причины не принимается', noReason.status === 400);
  const declined = await call('POST', `/sign/acts/${decAct}/decline`, u1.token, { reason: 'Неверная сумма в приказе' });
  check('отказ записан', declined.ok && declined.json.data.status === 'declined');
  check('причина сохранена', declined.json.data.declineReason === 'Неверная сумма в приказе');
  const decFlow = await call('GET', `/sign/requests/${decReq.json.data.request.id}`, u1.token);
  check('заявка закрылась отказом', decFlow.json.data.request.status === 'declined');

  // ============================================================
  // 7а. Протухание заявки (крон движка)
  // ============================================================
  // Истёк срок СБОРА подписей — заявка закрывается, но уже поставленные подписи
  // остаются доказательствами навсегда (ретеншна у них нет по определению).
  const expReq = await call('POST', '/sign/dev/requests', u1.token, {
    level: 'pep',
    title: 'Протухший',
    body: 'Заявка, у которой вышел срок',
  });
  const expId = expReq.json.data.request.id;
  const expAct = expReq.json.data.request.acts[0].id;
  const swept = await sweepExpiredRequests(expId);
  check('крон закрыл заявку по сроку', swept?.status === 'expired', swept?.status);
  check('акт протухшей заявки закрыт', swept?.actStatus === 'expired', swept?.actStatus);
  const lateSign = await call('POST', `/sign/acts/${expAct}/pep/start`, u1.token, { consentAccepted: true });
  check(
    'подписать протухшую заявку нельзя, и код честный',
    lateSign.status === 400 && lateSign.code === 'sign_request_closed',
    `code=${lateSign.code}`,
  );

  // ============================================================
  // 8. Артефакты: протокол и экспортный пакет (ст. 62 ЦК)
  // ============================================================
  const zipRes = await fetch(`${BASE}/sign/requests/${ecp3.json.data.request.id}/export`, {
    headers: { Authorization: 'Bearer ' + u1.token },
  });
  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  check('экспортный пакет отдаётся', zipRes.ok && zipBuf.length > 200, `${zipBuf.length} байт`);
  const zipText = zipBuf.toString('latin1');
  check('в пакете есть документ', zipText.includes('document/'));
  check('в пакете есть контейнер подписи', zipText.includes('signatures/signature-1.cms'));
  check('в пакете есть манифест', zipText.includes('manifest.json'));

  const protoRes = await fetch(`${BASE}/sign/requests/${ecp3.json.data.request.id}/protocol`, {
    headers: { Authorization: 'Bearer ' + u1.token },
  });
  if (protoRes.ok) {
    const pdf = Buffer.from(await protoRes.arrayBuffer());
    check('протокол подписания печатается в PDF', pdf.subarray(0, 4).toString() === '%PDF', `${pdf.length} байт`);
  } else {
    check('протокол: PDF-рендер выключен (SKIP)', protoRes.status === 503, `status=${protoRes.status}`);
  }

  // Чужому пакет не отдаётся.
  const foreignZip = await fetch(`${BASE}/sign/requests/${ecp3.json.data.request.id}/export`, {
    headers: { Authorization: 'Bearer ' + u2.token },
  });
  check('посторонний экспортный пакет не получает', foreignZip.status === 404 || foreignZip.status === 403);

  await part2({ u1, u2, testIin });
  await part3({ u1 });
  part4();
  await cleanup(u1);
  finish();
}

/**
 * Убрать за собой ЗАЯВКИ СОГЛАСОВАНИЯ, заведённые прогоном.
 *
 * Подписанные и отклонённые закрываются сами, а вот шаги, до которых прогон не
 * дошёл, остаются ждать решения — и копятся в стопке аккаунта сьюта от прогона к
 * прогону. Стопка обрезана потолком (50 на источник), поэтому накопленный мусор
 * однажды выталкивает из неё свежую заявку — и падает уже ЧУЖОЙ сьют
 * (`verify-approvals`), причём в месте, никак не связанном с причиной.
 * Отзываем ШТАТНЫМ путём и только своё — как требует плейбук.
 */
async function cleanup(u1) {
  const mine = await call('GET', '/approvals/mine', u1.token);
  const pending = (mine.json?.data?.items ?? []).filter((r) => r.status === 'pending');
  let cancelled = 0;
  for (const r of pending) {
    const res = await call('POST', `/approvals/${r.id}/cancel`, u1.token);
    if (res.ok) cancelled++;
  }
  check('заявки прогона закрыты штатным путём', cancelled === pending.length, `отозвано: ${cancelled}/${pending.length}`);
}

// ============================================================
// Часть 4 — fail-closed: mock-верификатор в ПРОД-режиме отвергает ЭЦП
// ============================================================
/**
 * Проверяется НЕ через живой сервер (поднимать прод-инстанс ради одного правила
 * дорого и небезопасно), а прямой загрузкой собранного модуля с NODE_ENV=production.
 * Это ровно то место, где решается «принимать ли непроверенную подпись», и
 * ошибиться в нём нельзя: mock, тихо принимающий ЭЦП в проде, выдаёт за
 * квалифицированную подпись то, чем она не является.
 */
function part4() {
  console.log('\n--- часть 4: fail-closed в production ---');
  const { execFileSync } = require('child_process');
  const probe = `
    process.env.NODE_ENV = 'production';
    delete process.env.NCANODE_URL;
    delete process.env.SIGN_VERIFY_DRIVER;
    const { SignVerifierService } = require('../dist/core/sign/drivers/sign-verifier.driver.js');
    const svc = new SignVerifierService();
    console.log(JSON.stringify({ live: svc.live, ecpAccepted: svc.ecpAccepted, driver: svc.driver.name }));
  `;
  try {
    const out = execFileSync(process.execPath, ['-e', probe], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const verdict = JSON.parse(out.trim().split('\n').pop());
    check('в production без NCANODE_URL драйвер = mock', verdict.driver === 'mock');
    check('mock не считается живым верификатором', verdict.live === false);
    check('ЭЦП в production с mock ОТВЕРГАЕТСЯ', verdict.ecpAccepted === false, JSON.stringify(verdict));
  } catch (err) {
    check('fail-closed проверяется на собранном модуле', false, String(err).slice(0, 200));
  }
}

// ============================================================
// Часть 3 — ВНЕШНИЙ подписант по гостевой ссылке
// ============================================================
async function part3({ u1 }) {
  console.log('\n--- часть 3: внешний подписант ---');

  const made = await call('POST', '/sign/dev/requests', u1.token, {
    level: 'pep',
    title: 'Договор с контрагентом',
    body: `Договор ${Date.now()}`,
  });
  const request = made.json.data.request;

  // Лимит открытий на подписной ссылке запрещён: он запер бы подписанта снаружи.
  const withLimit = await call('POST', '/share-links', u1.token, {
    refType: 'sign_request',
    refId: request.id,
    maxOpens: 1,
  });
  check('лимит открытий на подписной ссылке запрещён', withLimit.status === 400, `status=${withLimit.status}`);

  const linkRes = await call('POST', '/share-links', u1.token, {
    refType: 'sign_request',
    refId: request.id,
    requireIdentity: true,
    label: 'Контрагенту',
  });
  check('ссылка на подпись выдана', linkRes.ok, JSON.stringify(linkRes.json?.message ?? ''));
  if (!linkRes.ok) return;
  const token = linkRes.json.data.token ?? linkRes.json.data.url.split('/s/').pop();

  const peek = await call('GET', `/share-links/guest/${token}`, null);
  check('гостю сказано, что нужен номер', peek.ok && peek.json.data.identityRequired === true);

  // Гость называет номер. Берём его из ТЕСТ-КАРТЫ core/verify (VERIFY_TEST_PHONES):
  // у неё фиксированный код и отключённые потолки, поэтому сьют идемпотентен к
  // повторным прогонам. С обычным номером второй прогон в том же часу упирался бы
  // в анти-абьюз «5 SMS в час» — и падал бы не по делу.
  const guestPhone = testPhone();
  const idStart = await call('POST', `/share-links/guest/${token}/identity/start`, null, { phone: guestPhone });
  check('код гостю отправлен', idStart.ok, JSON.stringify(idStart.json?.message ?? ''));
  if (!idStart.ok) return;
  // У тест-карты кода в Redis нет (SMS не отправлялась) — он задан в env.
  const guestCode = await codeFor(guestPhone, idStart.json.data.challengeId);
  const idCheck = await call('POST', '/verify/check', null, {
    challengeId: idStart.json.data.challengeId,
    code: guestCode,
  });
  check('номер гостя подтверждён', idCheck.ok);

  const session = await call('POST', `/share-links/guest/${token}/session`, null, {
    verifyToken: idCheck.json.data.verifyToken,
    guestName: 'Асель Контрагентовна',
  });
  check('гостевая сессия открыта', session.ok, JSON.stringify(session.json?.message ?? ''));
  if (!session.ok) return;
  const pass = session.json.data.sessionToken;
  const view = session.json.data.view;
  check('гость видит замороженный документ', view?.kind === 'sign' && !!view.subject?.url);
  check('гость видит отпечаток документа', view?.subject?.sha256 === request.subjectSha256);

  const hdr = { 'x-share-session': pass };
  const noConsent = await call('POST', `/share-links/guest/${token}/actions/sign.pep.start`, null, {
    consentAccepted: true,
  }, hdr);
  check(
    'гостю нужно ещё и согласие на обработку ПД',
    noConsent.status === 400 && noConsent.code === 'sign_consent_required',
    `code=${noConsent.code}`,
  );

  const started = await call('POST', `/share-links/guest/${token}/actions/sign.pep.start`, null, {
    consentAccepted: true,
    pdConsentAccepted: true,
  }, hdr);
  check('гостю отправлен код ПОД ДОКУМЕНТ (второй)', started.ok, JSON.stringify(started.json?.message ?? ''));
  if (!started.ok) return;

  const code = await codeFor(guestPhone, started.json.data.challengeId);
  const signed = await call('POST', `/share-links/guest/${token}/actions/sign.pep.confirm`, null, {
    challengeId: started.json.data.challengeId,
    code,
  }, hdr);
  check('гость подписал', signed.ok && signed.json.data.status === 'signed', JSON.stringify(signed.json?.message ?? ''));

  const after = await call('GET', `/sign/requests/${request.id}`, u1.token);
  const guestAct = after.json.data.request.acts.find((a) => a.signerType === 'guest');
  check('акт гостя записан', !!guestAct);
  check('имя гостя снято снимком', guestAct?.signerName === 'Асель Контрагентовна');
  check('номер гостя маскирован в DTO', !!guestAct?.signerPhoneMasked && !guestAct.signerPhoneMasked.includes('9990009'));
  check('в акте гостя есть снимок соглашения', (guestAct?.consentText ?? '').length > 50);

  // Действие без пропуска.
  const noPass = await call('POST', `/share-links/guest/${token}/actions/sign.pep.start`, null, {
    consentAccepted: true,
    pdConsentAccepted: true,
  });
  check('без пропуска действие недоступно (403, НЕ 401)', noPass.status === 403, `status=${noPass.status}`);

  // Неизвестное действие.
  const unknown = await call('POST', `/share-links/guest/${token}/actions/sign.nope`, null, {}, hdr);
  check('неизвестное действие → 404', unknown.status === 404, `status=${unknown.status}`);

  await call('POST', `/share-links/${linkRes.json.data.id}/revoke`, u1.token, {});
  const afterRevoke = await call('POST', `/share-links/guest/${token}/actions/sign.pep.start`, null, {
    consentAccepted: true,
    pdConsentAccepted: true,
  }, hdr);
  check('отзыв ссылки гасит и действия', afterRevoke.status === 410, `status=${afterRevoke.status}`);
}

// ============================================================
// Часть 2 — связка с core/approvals
// ============================================================
async function part2({ u1, u2, testIin }) {
  console.log('\n--- часть 2: связка с core/approvals ---');

  // Предмет маршрута — тот же файл-заглушка: у обоих полигонов refId это fileId,
  // поэтому один резолвер обслуживает и подпись, и согласование.
  const stub = await call('POST', '/sign/dev/requests', u1.token, {
    level: 'pep',
    title: 'Приказ на подпись',
    body: 'Текст приказа для маршрута',
  });
  if (!stub.ok) {
    check('заготовка предмета для маршрута', false, JSON.stringify(stub.json?.message ?? stub.status));
    return;
  }
  const subjectFileId = stub.json.data.stubFileId;

  const made = await call('POST', '/approvals/dev/request', u1.token, {
    refId: subjectFileId,
    title: 'Приказ на подпись',
    steps: [
      { order: 0, kind: 'signature', assigneeType: 'user', assigneeId: u1.id },
      { order: 1, kind: 'approval', assigneeType: 'user', assigneeId: u2.id },
    ],
  });
  if (!made.ok) {
    check('дев-полигон согласований доступен', false, JSON.stringify(made.json?.message ?? made.status));
    return;
  }
  check('маршрут из двух шагов заведён', made.ok);
  const request = made.json.data;
  const step0 = request.steps[0];
  check('первый шаг — подпись', step0.kind === 'signature');
  check('требование подписи по умолчанию пустое', step0.requiredSignatureKind === null);

  // Поднять требование до ЭЦП может только тот, кто маршрут строит; в полигоне
  // это делает та же ручка.
  const armed = await call('POST', `/approvals/dev/step/${step0.id}/require-signature`, u1.token, { kind: 'ecp' });
  if (!armed.ok) {
    check('полигон умеет ставить requiredSignatureKind', false, JSON.stringify(armed.json?.message ?? armed.status));
    return;
  }
  check('на шаг поставлено требование ЭЦП', armed.ok);

  const clicked = await call('POST', `/approvals/steps/${step0.id}/decide`, u1.token, { decision: 'approved' });
  check(
    'обычный клик шаг с требованием подписи НЕ закрывает',
    clicked.status === 400 && clicked.code === 'approval_needs_signature',
    `code=${clicked.code}`,
  );

  const inbox = await call('GET', '/approvals/inbox', u1.token);
  const item = (inbox.json?.data?.items ?? []).find((i) => i.id === step0.id);
  check('шаг виден в стопке', !!item);
  check('стопка называет вид шага', item?.stepKind === 'signature');
  check('стопка называет требование подписи', item?.signRequirement === 'ecp');
  check('кнопок решения у подписного шага нет', (item?.actions ?? []).length === 0);

  const forStep = await call('POST', `/sign/requests/for-step/${step0.id}`, u1.token);
  check('ленивое создание заявки под шаг работает', forStep.ok, JSON.stringify(forStep.json?.message ?? forStep.status));
  if (!forStep.ok) return;

  const flow = forStep.json.data;
  check('заявка привязана к шагу', flow.request.approvalStepId === step0.id);
  check('уровень взят из требования шага', flow.request.level === 'ecp');

  const twin = await call('POST', `/sign/requests/for-step/${step0.id}`, u1.token);
  check('повтор возвращает ТУ ЖЕ заявку (идемпотентность)', twin.ok && twin.json.data.request.id === flow.request.id);

  const signRes = await call('POST', `/sign/acts/${flow.myAct.id}/cms`, u1.token, {
    cms: mockCms({ sha256: flow.request.subjectSha256, iin: testIin }),
  });
  check('подпись поставлена', signRes.ok && signRes.json.data.status === 'signed', JSON.stringify(signRes.json?.message ?? ''));

  const reqAfter = await call('GET', `/approvals/${request.id}`, u1.token);
  const s0 = reqAfter.json.data.steps[0];
  check('шаг закрыт подписью', s0.status === 'approved');
  check('решение помечено как ЭЦП', s0.decisions[0]?.signatureKind === 'ecp');
  check('в решении стоит ссылка на АКТ подписи', !!s0.decisions[0]?.signActId);
  check('в решении заморожен отпечаток подписанного', !!s0.decisions[0]?.subjectSha256);
  check('маршрут поехал дальше', reqAfter.json.data.steps[1].status === 'active');

  // ---- «нужен каждый»: двое подписантов на одном шаге ----
  // Адресат-человек правило `all` не принимает (у него один ответ по определению),
  // поэтому двух подписантов делаем ДВУМЯ параллельными шагами одной группы: они
  // активируются одновременно, и следующая группа ждёт обоих — ровно то свойство,
  // которое здесь и проверяется.
  const stub2 = await call('POST', '/sign/dev/requests', u1.token, {
    level: 'pep',
    title: 'Двусторонний акт',
    body: 'Акт, который подписывают двое',
  });
  const both = await call('POST', '/approvals/dev/request', u1.token, {
    refId: stub2.json.data.stubFileId,
    title: 'Двусторонний акт',
    steps: [
      { order: 0, kind: 'signature', assigneeType: 'user', assigneeId: u1.id },
      { order: 0, kind: 'signature', assigneeType: 'user', assigneeId: u2.id },
      { order: 1, kind: 'approval', assigneeType: 'user', assigneeId: u1.id },
    ],
  });
  // Шаги ОДНОЙ группы приходят в НЕУСТОЙЧИВОМ порядке (сортировка только по
  // `order`), поэтому берём их по адресату, а не по индексу массива: разбор по
  // индексу давал плавающее падение «Подписывает адресат шага», когда Postgres
  // возвращал пару в обратном порядке и первый подписант шёл на чужой шаг.
  const b0 = both.json.data.steps.find((s) => s.order === 0 && s.assigneeId === u1.id);
  const b1 = both.json.data.steps.find((s) => s.order === 0 && s.assigneeId === u2.id);
  await call('POST', `/approvals/dev/step/${b0.id}/require-signature`, u1.token, { kind: 'sms' });
  await call('POST', `/approvals/dev/step/${b1.id}/require-signature`, u1.token, { kind: 'sms' });

  const signOne = async (user, stepId) => {
    const flow = await call('POST', `/sign/requests/for-step/${stepId}`, user.token);
    if (!flow.ok) return { ok: false, why: JSON.stringify(flow.json?.message ?? flow.status) };
    const actId = flow.json.data.myAct.id;
    const st = await call('POST', `/sign/acts/${actId}/pep/start`, user.token, { consentAccepted: true });
    if (!st.ok) return { ok: false, why: JSON.stringify(st.json?.message ?? st.status) };
    const phone = user === u1 ? SUITE.p1 : SUITE.p2;
    const c = await codeFor(phone, st.json.data.challengeId);
    const done = await call('POST', `/sign/acts/${actId}/pep/confirm`, user.token, {
      challengeId: st.json.data.challengeId,
      code: c,
    });
    return { ok: done.ok && done.json.data.status === 'signed', why: JSON.stringify(done.json?.message ?? '') };
  };

  // Шаги ОДНОЙ группы приходят в неустойчивом порядке (сортировка только по
  // `order`), поэтому ищем их по id, а не по индексу массива.
  const stepById = (data, id) => data.steps.find((s) => s.id === id);
  const lastStep = (data) => data.steps[data.steps.length - 1];

  const first = await signOne(u1, b0.id);
  check('первый из двух подписал', first.ok, first.why);
  const midway = await call('GET', `/approvals/${both.json.data.id}`, u1.token);
  check('пока подписал один — следующая группа НЕ активна', lastStep(midway.json.data).status === 'waiting');
  check(
    'ПЭП помечена как sms',
    stepById(midway.json.data, b0.id)?.decisions[0]?.signatureKind === 'sms',
    stepById(midway.json.data, b0.id)?.decisions[0]?.signatureKind,
  );
  check('второй шаг группы всё ещё ждёт', stepById(midway.json.data, b1.id)?.status === 'active');

  const second = await signOne(u2, b1.id);
  check('второй из двух подписал (полномочие даёт СНИМОК шага, не право «отправить»)', second.ok, second.why);
  const closed = await call('GET', `/approvals/${both.json.data.id}`, u1.token);
  check('после обеих подписей группа закрылась', stepById(closed.json.data, b1.id)?.status === 'approved');
  check('маршрут поехал к следующей группе', lastStep(closed.json.data).status === 'active');

  // ---- отказ подписанта двигает МАРШРУТ ----
  const stub3 = await call('POST', '/sign/dev/requests', u1.token, {
    level: 'pep',
    title: 'Отказной приказ',
    body: 'Приказ, от подписи которого откажутся',
  });
  const routeDecline = await call('POST', '/approvals/dev/request', u1.token, {
    refId: stub3.json.data.stubFileId,
    title: 'Отказной приказ',
    steps: [
      { order: 0, kind: 'signature', assigneeType: 'user', assigneeId: u1.id },
      { order: 1, kind: 'approval', assigneeType: 'user', assigneeId: u2.id },
    ],
  });
  const d0 = routeDecline.json.data.steps[0];
  await call('POST', `/approvals/dev/step/${d0.id}/require-signature`, u1.token, { kind: 'sms' });
  const dFlow = await call('POST', `/sign/requests/for-step/${d0.id}`, u1.token);
  const dAct = dFlow.json.data.myAct.id;
  const declined = await call('POST', `/sign/acts/${dAct}/decline`, u1.token, {
    reason: 'В приказе неверная дата вступления в силу',
  });
  check('отказ от подписи принят', declined.ok && declined.json.data.status === 'declined');

  const dAfter = await call('GET', `/approvals/${routeDecline.json.data.id}`, u1.token);
  check('маршрут закрыт отказом', dAfter.json.data.status === 'rejected', dAfter.json?.data?.status);
  check('шаг помечен отклонённым', dAfter.json.data.steps[0].status === 'rejected');
  check('причина отказа доехала до решения', !!dAfter.json.data.steps[0].decisions[0]?.comment);
  check('следующий шаг пропущен', dAfter.json.data.steps[1].status === 'skipped');
}

main().catch((err) => {
  console.error('\n💥', err);
  process.exit(1);
});
