/* eslint-disable */
// Phase 3 e2e: Rich Cards + order/event context chats. Reuses the verify-order bootstrap
// (seller currency → fund buyer → showcase+listing → buy) then exercises:
//   - GET /rich-cards/order/:id renders a LIVE card with state-filtered buttons per viewer
//   - seller sees Подтвердить/Отклонить; buyer does NOT (security)
//   - FORGED action denied: buyer calling order.confirm → 403 (capability re-check)
//   - executing order.confirm as seller updates the card in place (buttons vanish)
//   - order chat: GET /messenger/orders/:id/chat (buyer+seller members; outsider 403)
//   - event chat: create event + invite → GET /messenger/events/:id/chat; RSVP via card
//   - share: POST /rich-cards/share drops a card into a chat
// Run (API up): node scripts/verify-richcards.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567', P2 = '+77012345678', P3 = '+77023456789', PW = 'Test1234!';

let fails = 0, pass = 0;
const check = (n, ok, extra) => { console.log(`${ok ? '  PASS' : '  FAIL'} ${n}${extra ? `  (${extra})` : ''}`); ok ? pass++ : fails++; };
async function call(method, p, token, body) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}: ${r.status}`); return r.json.data.accessToken; };

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2), t3 = await login(P3);
  const u1 = (await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } })).id;
  const u2 = (await prisma.user.findUnique({ where: { phone: P2 }, select: { id: true } })).id;
  const u3 = (await prisma.user.findUnique({ where: { phone: P3 }, select: { id: true } })).id;
  const link = async (x, y, by) => { const [a, b] = x < y ? [x, y] : [y, x]; await prisma.contactLink.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: by } }); };
  await link(u1, u2, u1); await link(u1, u3, u1);

  const showcases = [];
  try {
    // ---- bootstrap: seller(t1) currency, fund buyer(t2) via rewarded task, listing shared to t2 ----
    await call('DELETE', '/wallet/currency', t1);
    const curId = (await call('POST', '/wallet/currency', t1, { name: 'КартКоин', icon: '🪙' })).json.data.id;
    await call('POST', '/wallet/currency/mint', t1, { amount: 1000 });
    const fundTask = await call('POST', '/tasks', t1, { title: 'Аванс', executorId: u2, coinReward: 300 });
    await call('POST', `/tasks/${fundTask.json.data.id}/submit`, t2);
    await call('POST', `/tasks/${fundTask.json.data.id}/accept`, t1);
    const sc = (await call('POST', '/shop/showcases', t1, { name: 'Витрина Ф3' })).json.data;
    showcases.push(sc.id);
    const lot = (await call('POST', '/shop/listings', t1, { showcaseId: sc.id, title: 'Гаджет', priceAmount: 100 })).json.data;
    await call('POST', `/shop/showcases/${sc.id}/shares`, t1, { principalType: 'user', principalId: u2 });

    console.log('\n-- listing rich card (live render + talk button) --');
    let r = await call('GET', `/rich-cards/listing/${lot.id}`, t2);
    check('buyer renders listing card', r.ok && r.json.data && r.json.data.cardType === 'listing', `status ${r.status}`);
    const lotKeys = (r.json.data?.actions || []).map((a) => a.key);
    check('listing card offers Купить', lotKeys.includes('listing.buy'));
    check('listing card offers Поговорить', lotKeys.includes('listing.talk'));
    r = await call('GET', `/rich-cards/listing/${lot.id}`, t1);
    check('owner sees NO buy/talk on own lot', !(r.json.data?.actions || []).some((a) => a.key === 'listing.buy'));

    console.log('\n-- buy → order rich card, viewer-filtered buttons --');
    const order = (await call('POST', `/shop/listings/${lot.id}/buy`, t2)).json.data;
    check('order created (pending)', order && order.status === 'pending', `status ${order?.status}`);

    r = await call('GET', `/rich-cards/order/${order.id}`, t1); // seller
    const sellerActions = (r.json.data?.actions || []).map((a) => a.key);
    check('SELLER card has Подтвердить', sellerActions.includes('order.confirm'));
    check('SELLER card has Отклонить', sellerActions.includes('order.reject'));

    r = await call('GET', `/rich-cards/order/${order.id}`, t2); // buyer
    const buyerActions = (r.json.data?.actions || []).map((a) => a.key);
    check('BUYER card has NO Подтвердить (security)', !buyerActions.includes('order.confirm'));
    check('BUYER card has Отменить', buyerActions.includes('order.cancel'));

    r = await call('GET', `/rich-cards/order/${order.id}`, t3); // outsider
    check('outsider cannot render order card (null/403)', !r.json?.data, `status ${r.status}`);

    console.log('\n-- FORGED action is rejected (capability re-check) --');
    r = await call('POST', '/rich-cards/order.confirm/execute', t2, { ref: { type: 'order', id: order.id } });
    check('buyer forging order.confirm → 403', r.status === 403, `status ${r.status}`);
    r = await call('POST', '/rich-cards/order.confirm/execute', t3, { ref: { type: 'order', id: order.id } });
    check('outsider forging order.confirm → 403', r.status === 403, `status ${r.status}`);

    console.log('\n-- execute as seller → card updates in place --');
    r = await call('POST', '/rich-cards/order.confirm/execute', t1, { ref: { type: 'order', id: order.id } });
    check('seller order.confirm ok', r.ok, `status ${r.status}`);
    const updated = r.json?.data?.card;
    check('updated card returned', !!updated);
    check('after confirm: no Подтвердить button (settled)', !(updated?.actions || []).some((a) => a.key === 'order.confirm'));

    console.log('\n-- order context chat --');
    r = await call('GET', `/messenger/orders/${order.id}/chat`, t1);
    check('seller opens order chat', r.ok && r.json.data?.type === 'context', `status ${r.status}`);
    const orderChatId = r.json.data?.id;
    check('order chat parentType=order', r.json.data?.parentType === 'order');
    const partRoles = (r.json.data?.participants || []).map((p) => p.roleTag);
    check('order chat shows Покупатель + Продавец tags', partRoles.includes('Покупатель') && partRoles.includes('Продавец'));
    r = await call('GET', `/messenger/orders/${order.id}/chat`, t2);
    check('buyer opens same order chat', r.ok && r.json.data?.id === orderChatId);
    r = await call('GET', `/messenger/chats/${orderChatId}`, t3);
    check('outsider cannot view order chat (403)', r.status === 403, `status ${r.status}`);

    console.log('\n-- share a card into a chat --');
    // share the (settled) order card into the order chat
    r = await call('POST', '/rich-cards/share', t1, { chatId: orderChatId, refType: 'order', refId: order.id });
    check('seller shares order card into order chat', r.ok, `status ${r.status}`);
    r = await call('GET', `/messenger/chats/${orderChatId}/messages`, t2);
    const hasCard = (r.json.data || []).some((m) => m.type === 'rich_card');
    check('shared rich_card message visible to buyer', hasCard);

    console.log('\n-- event chat + RSVP via card --');
    const ev = await call('POST', '/calendar/events', t1, {
      title: 'Созвон Ф3',
      startTime: new Date(Date.now() + 86400000).toISOString(),
      endTime: new Date(Date.now() + 86400000 + 3600000).toISOString(),
      participantUserIds: [u2],
    });
    check('event created', ev.ok, `status ${ev.status}`);
    const eventId = ev.json?.data?.id;
    if (eventId) {
      r = await call('GET', `/messenger/events/${eventId}/chat`, t1);
      check('organizer opens event chat', r.ok && r.json.data?.parentType === 'event', `status ${r.status}`);
      const evRoles = (r.json.data?.participants || []).map((p) => p.roleTag);
      check('event chat shows Организатор tag', evRoles.includes('Организатор'));
      r = await call('GET', `/messenger/events/${eventId}/chat`, t2);
      check('attendee opens event chat', r.ok);
      r = await call('GET', `/messenger/events/${eventId}/chat`, t3);
      check('non-participant cannot open event chat (403)', r.status === 403, `status ${r.status}`);
      // RSVP via rich-card action
      r = await call('GET', `/rich-cards/event/${eventId}`, t2);
      check('attendee renders event card', r.ok && r.json.data?.cardType === 'event');
      r = await call('POST', '/rich-cards/event.rsvp_accept/execute', t2, { ref: { type: 'event', id: eventId } });
      check('attendee RSVP accept via card', r.ok, `status ${r.status}`);
    }

    console.log(`\nRESULT ${pass} passed, ${fails} failed`);
  } finally {
    for (const id of showcases) { try { await call('DELETE', `/shop/showcases/${id}`, t1); } catch {} }
    await prisma.$disconnect();
  }
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
