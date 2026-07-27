/* eslint-disable */
// Seed the dev test accounts via the register API. Idempotent: an account that already
// exists is skipped (409). Run after a clean DB reset, with the API running:
//   node scripts/seed-test-accounts.cjs
//
// ДВЕ РАЗНЫЕ ТРОЙКИ, и смешивать их нельзя:
//   • tester1/2/3 — РУЧНЫЕ аккаунты человека, он в них живёт в браузере. Verify-скрипты
//     сюда не ходят: сьют по природе своей стирает состояние между прогонами, и общий
//     аккаунт означал потерю живых данных (verify-files так сносил аватарки и вложения
//     задач/чатов, verify-cardskins — купленные скины).
//   • suite1/2/3 — аккаунты САМОГО СЬЮТА (verify-*.cjs). Их не жалко: весь мусор от
//     прогонов (организации, задачи, файлы, скины) копится здесь и человеку не мешает.
const BASE = process.env.API_BASE || 'http://localhost:3001/api';
const PW = 'Test1234!';
const ACCOUNTS = [
  // Ручные — для входа в браузере
  { phone: '+77001234567', firstName: 'Тестер', lastName: 'Первый' },
  { phone: '+77012345678', firstName: 'Тестер', lastName: 'Второй' },
  { phone: '+77023456789', firstName: 'Тестер', lastName: 'Третий' },
  // Сьют — для verify-*.cjs
  { phone: '+77009990001', firstName: 'Сьют', lastName: 'Первый' },
  { phone: '+77009990002', firstName: 'Сьют', lastName: 'Второй' },
  { phone: '+77009990003', firstName: 'Сьют', lastName: 'Третий' },
];

async function call(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}

async function main() {
  let fails = 0;
  for (const a of ACCOUNTS) {
    const r = await call('POST', '/auth/register', { ...a, password: PW });
    if (r.ok) console.log(`✓ создан  ${a.phone}`);
    else if (r.status === 409) console.log(`• уже есть ${a.phone}`);
    else { console.log(`✗ ${a.phone} → ${r.status} ${JSON.stringify(r.json)}`); fails++; }
  }
  if (fails > 0) process.exit(1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
