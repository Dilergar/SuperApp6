/* eslint-disable */
// Регрессии security-ревью 2026-07-25 (по образцу verify-files-review-fixes.cjs).
// Каждый блок падал бы ДО правки:
//  #2  ранг «от имени»: менеджер публиковал триггер с runAsUserId владельца и повышал
//      себя до админа (updateMember видел актора-владельца и пропускал гейт).
//  #8a токен вебхука отдавался ЛЮБОМУ члену команды (стажёру), а он стартует процесс
//      от имени сотрудника из runAsUserId.
//  #8b тело публичного вебхука уходило в переменные процесса ЦЕЛИКОМ: можно было
//      подсунуть служебный _subprocessDepth (обход защиты от рекурсии), chatId (увод
//      бота организации в чужой чат) и HTML (сток Telegram шлёт parse_mode:'HTML').
//  #6  revokeStaff не проверял принадлежность витрины: любой авторизованный снимал
//      права со-управляющего на ЧУЖОЙ витрине.
//  #7  списки приглашений отдавали полную анкету человека, который ещё не согласился
//      на связь (фамилия целиком, био, город, соцсети, возраст).
// Run (API up + seeded testers): node scripts/verify-security-fixes.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567', P2 = '+77012345678', P3 = '+77023456789', PW = 'Test1234!';

let fails = 0;
const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };
async function call(method, p, token, body, headers) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}: ${r.status}`); return r.json.data.accessToken; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2), t3 = await login(P3);
  const uid = async (p) => (await prisma.user.findUnique({ where: { phone: p }, select: { id: true } })).id;
  const u1 = await uid(P1), u2 = await uid(P2), u3 = await uid(P3);

  const cleanup = { wsId: null, freshPhone: null, showcaseId: null };
  try {
    // ===== Подготовка: организация, t2 = менеджер, t3 = стажёр =====
    const ws = await call('POST', '/workspaces', t1, { name: 'sec-fixes-e2e' });
    const wsId = ws.json.data.id; cleanup.wsId = wsId;
    const PR = (p) => `/workspaces/${wsId}/processes${p}`;

    for (const [phone, tok, uidv] of [[P2, t2, u2], [P3, t3, u3]]) {
      await call('POST', `/workspaces/${wsId}/invitations`, t1, { phone });
      const myInv = (await call('GET', '/workspaces/invitations/incoming', tok)).json?.data?.find((i) => i.workspaceId === wsId);
      await call('POST', `/workspaces/invitations/${myInv?.id}/accept`, tok);
    }
    const prom = await call('PATCH', `/workspaces/${wsId}/members/${u2}`, t1, { role: 'manager' });
    check('подготовка: t2 повышен до менеджера, t3 остался стажёром', prom.ok, `status ${prom.status}`);

    const docWith = (runAsUserId) => ({
      nodes: [
        { id: 'wh', type: 'trigger.webhook', label: 'Вебхук', config: { runAsUserId } },
        { id: 'n', type: 'notify', label: 'Пришло', config: { to: 'initiator', title: 'Вебхук' } },
        { id: 'end', type: 'end', label: 'Конец', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'wh', fromPort: 'main', to: 'n' },
        { id: 'e2', from: 'n', fromPort: 'main', to: 'end' },
      ],
      form: [],
    });

    // ===== #2 Ранг «от имени» =====
    const defA = (await call('POST', PR(''), t2, { name: 'Эскалация прав' })).json?.data?.id;
    await call('PUT', PR(`/${defA}/document`), t2, { document: docWith(u1) }); // от имени ВЛАДЕЛЬЦА
    const pubEsc = await call('POST', PR(`/${defA}/publish`), t2);
    const escMsg = JSON.stringify(pubEsc.json ?? '');
    check('#2 менеджер НЕ публикует процесс «от имени» владельца → 400', pubEsc.status === 400, `status ${pubEsc.status}`);
    check('#2 причина названа явно (правило ранга)', /не выше вашей роли/.test(escMsg), escMsg.slice(0, 200));

    // Мягкая валидация тем же менеджером показывает ту же проблему заранее
    const val = await call('POST', PR(`/${defA}/validate`), t2);
    check('#2 мягкая валидация (manager+) видит проблему ранга', JSON.stringify(val.json?.data?.issues ?? []).includes('не выше вашей роли'), JSON.stringify(val.json?.data?.issues ?? []).slice(0, 120));
    // Стажёру ранг-ошибку не показываем — иначе это оракул ролей коллег
    const valTrainee = await call('POST', PR(`/${defA}/validate`), t3);
    check('#2 стажёру ранг-ошибка НЕ раскрывается', valTrainee.ok && !JSON.stringify(valTrainee.json?.data?.issues ?? []).includes('не выше вашей роли'), `status ${valTrainee.status}`);

    // «От имени себя» — законно, публикуется
    await call('PUT', PR(`/${defA}/document`), t2, { document: docWith(u2) });
    const pubOk = await call('POST', PR(`/${defA}/publish`), t2);
    check('#2 «от имени себя» публикуется нормально', pubOk.ok, `status ${pubOk.status}`);

    // ===== #8a Токен вебхука =====
    const asManager = await call('GET', PR(`/${defA}`), t2);
    const asTrainee = await call('GET', PR(`/${defA}`), t3);
    const mgrUrl = (asManager.json?.data?.triggers ?? []).find((t) => t.type === 'webhook')?.webhookUrl;
    const trnUrl = (asTrainee.json?.data?.triggers ?? []).find((t) => t.type === 'webhook')?.webhookUrl;
    check('#8a менеджер видит webhookUrl', typeof mgrUrl === 'string' && mgrUrl.length > 0);
    check('#8a стажёр webhookUrl НЕ видит (токен скрыт)', trnUrl === null, JSON.stringify(trnUrl));
    check('#8a стажёр при этом читает сам процесс', asTrainee.ok, `status ${asTrainee.status}`);

    // ===== #8b Санитайзер тела вебхука =====
    const token = String(mgrUrl).split('/').pop();
    const fired = await call('POST', `/processes/webhook/${token}`, null, {
      _subprocessDepth: -1000000,        // служебный ключ движка
      _loopIdx_x: 999,                   // он же, на другой ноде
      chatId: '@attacker_channel',       // увод бота организации
      note: '<b>жирный</b>',             // HTML: экранирует сток, не санитайзер
      nested: { _item: 'служебное', ok: 'да', deep: { s: 'a<b>c' } },
      items: [{ n: 5 }, { n: 10 }],      // структура ДОЛЖНА выжить ({{form.items}})
    });
    check('#8b вебхук принят', fired.ok, `status ${fired.status}`);
    await sleep(800);
    const instId = fired.json?.instanceId;
    const inst = instId ? await prisma.processInstance.findUnique({ where: { id: instId }, select: { variables: true } }) : null;
    const v = (inst?.variables ?? {});
    check('#8b служебный _subprocessDepth отброшен', v._subprocessDepth === undefined, JSON.stringify(v._subprocessDepth));
    check('#8b служебный _loopIdx_x отброшен', v._loopIdx_x === undefined, JSON.stringify(v._loopIdx_x));
    check('#8b chatId из ЧУЖОГО вебхука отброшен', v.chatId === undefined, JSON.stringify(v.chatId));
    // Свободный текст доходит БЕЗ искажений (иначе «5 < 10» от живого человека
    // превращалось бы в «5  10»); за безопасность отвечает экранирование в стоке.
    check('#8b свободный текст не искажён', v.note === '<b>жирный</b>', JSON.stringify(v.note));
    check('#8b служебный ключ отброшен и ВНУТРИ объекта', v.nested && v.nested._item === undefined && v.nested.ok === 'да', JSON.stringify(v.nested));
    check('#8b вложенный текст тоже цел', v.nested?.deep?.s === 'a<b>c', JSON.stringify(v.nested?.deep?.s));
    check('#8b СТРУКТУРА незадекларированных ключей сохранена ({{form.items}})', Array.isArray(v.items) && v.items.length === 2 && v.items[0]?.n === 5, JSON.stringify(v.items));

    // ===== #6 Витрина чужого магазина =====
    const sc = await call('POST', '/shop/showcases', t1, { name: 'Витрина владельца' });
    const showcaseId = sc.json?.data?.id; cleanup.showcaseId = showcaseId;
    check('#6 подготовка: витрина t1 создана', sc.ok, `status ${sc.status}`);
    const revoke = await call('DELETE', `/shop/staff/${u3}?scope=showcase&showcaseId=${showcaseId}`, t2);
    check('#6 снятие прав на ЧУЖОЙ витрине → 404', revoke.status === 404, `status ${revoke.status}`);
    const badScope = await call('DELETE', `/shop/staff/${u3}?scope=nonsense`, t2);
    check('#6 некорректная область → 400', badScope.status === 400, `status ${badScope.status}`);
    const noShowcase = await call('DELETE', `/shop/staff/${u3}?scope=showcase`, t2);
    check('#6 область showcase без витрины → 400', noShowcase.status === 400, `status ${noShowcase.status}`);

    // ===== #7 Анкета до согласия на связь =====
    const stamp = Date.now() % 10_000_000;
    const freshPhone = `+7701${String(stamp).padStart(7, '0')}`;
    cleanup.freshPhone = freshPhone;
    const reg = await call('POST', '/auth/register', null, { phone: freshPhone, password: PW, firstName: 'Диана', lastName: 'Нурланова' });
    check('#7 подготовка: новый пользователь зарегистрирован', reg.ok, `status ${reg.status}`);
    const freshTok = reg.json?.data?.accessToken;
    await call('PATCH', '/users/me', freshTok, { bio: 'Секретное био', city: 'Алматы' });

    await call('POST', '/contacts/invitations', t1, { toPhone: freshPhone, proposedRoleForRecipient: 'Коллега', proposedRoleForSender: 'Коллега' });
    const outgoing = await call('GET', '/contacts/invitations/outgoing', t1);
    const card = (outgoing.json?.data ?? []).find((i) => i.toPhone === freshPhone)?.to;
    check('#7 карточка приглашённого отдаётся', !!card, JSON.stringify(outgoing.json?.data?.length));
    check('#7 фамилия маскирована до инициала', card?.lastName === 'Н.', JSON.stringify(card?.lastName));
    check('#7 имя видно (по нему узнают человека)', card?.firstName === 'Диана', JSON.stringify(card?.firstName));
    check('#7 био скрыто до согласия', card?.bio === null, JSON.stringify(card?.bio));
    check('#7 город скрыт до согласия', card?.city === null, JSON.stringify(card?.city));
    check('#7 соцсети/возраст скрыты', card?.socialLinks === null && card?.age === null);

    // Входящее — та же пре-линк карточка у получателя
    const incoming = await call('GET', '/contacts/invitations/incoming', freshTok);
    const fromCard = (incoming.json?.data ?? [])[0]?.from;
    check('#7 входящее приглашение тоже пре-линк (фамилия маскирована)', !!fromCard && /^.\.$/.test(fromCard.lastName ?? ''), JSON.stringify(fromCard?.lastName));
  } finally {
    if (cleanup.showcaseId) await call('DELETE', `/shop/showcases/${cleanup.showcaseId}`, await login(P1)).catch(() => {});
    if (cleanup.wsId) await call('DELETE', `/workspaces/${cleanup.wsId}`, await login(P1)).catch(() => {});
    if (cleanup.freshPhone) {
      // Приглашение порождает уведомление джобом core/jobs. Если снести пользователя
      // раньше, чем джоб отработает, тот упрётся в FK notifications_user_id_fkey и будет
      // ретраиться до dead-letter, засоряя лог. Даём ему завершиться.
      await sleep(2000);
      const u = await prisma.user.findUnique({ where: { phone: cleanup.freshPhone }, select: { id: true } }).catch(() => null);
      if (u) {
        await prisma.job.deleteMany({ where: { payload: { path: ['userId'], equals: u.id } } }).catch(() => {});
        await prisma.contactInvitation.deleteMany({ where: { toPhone: cleanup.freshPhone } }).catch(() => {});
        await prisma.session.deleteMany({ where: { userId: u.id } }).catch(() => {});
        await prisma.notification.deleteMany({ where: { userId: u.id } }).catch(() => {});
        await prisma.userRole.deleteMany({ where: { userId: u.id } }).catch(() => {});
        await prisma.user.delete({ where: { id: u.id } }).catch(() => {});
      }
    }
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ SECURITY-FIXES РЕГРЕССИИ ПРОЙДЕНЫ' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
