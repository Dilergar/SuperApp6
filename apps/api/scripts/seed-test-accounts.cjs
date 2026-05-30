/* eslint-disable */
// Seed the three dev test accounts (tester1/2/3) via the register API. Idempotent: an account
// that already exists is skipped (409). Run after a clean DB reset, with the API running:
//   node scripts/seed-test-accounts.cjs
const BASE = process.env.API_BASE || 'http://localhost:3001/api';
const PW = 'Test1234!';
const ACCOUNTS = [
  { phone: '+77001234567', firstName: 'Тестер', lastName: 'Первый' },
  { phone: '+77012345678', firstName: 'Тестер', lastName: 'Второй' },
  { phone: '+77023456789', firstName: 'Тестер', lastName: 'Третий' },
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
  for (const a of ACCOUNTS) {
    const r = await call('POST', '/auth/register', { ...a, password: PW });
    if (r.ok) console.log(`✓ создан  ${a.phone}`);
    else if (r.status === 409) console.log(`• уже есть ${a.phone}`);
    else console.log(`✗ ${a.phone} → ${r.status} ${JSON.stringify(r.json)}`);
  }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
