#!/usr/bin/env node
/* eslint-disable */
// ============================================================
// Церемония корневого ключа движка core/keys (KEYS_ROOT_KEY_FILE).
//
// Генерирует 32 байта CSPRNG, пишет их hex-строкой в файл с правами 0600 и печатает
// отпечаток (SHA-256, первые 16 hex — он же `rootKid` каждой версии в keystore и
// строка в Кабинете платформы для сверки). Существующий файл НИКОГДА не перезаписывается.
//
// Правила церемонии (PCI DSS 3.6, split knowledge): две офлайн-копии у двух разных
// людей (владелец + доверенное лицо), отпечаток — в кабинете платформы; учение
// восстановления — `keys-verify-root.cjs` перед прод-запуском и раз в квартал.
//
// Run: node apps/api/scripts/keys-init-root.cjs [path]   (пусто → ./.keys/root.key)
// ============================================================
const fs = require('fs');
const path = require('path');
const { randomBytes, createHash } = require('crypto');

const target = path.resolve(process.argv[2] || process.env.KEYS_ROOT_KEY_FILE || path.join(process.cwd(), '.keys', 'root.key'));

if (fs.existsSync(target)) {
  const raw = fs.readFileSync(target);
  const parsed = parseRoot(raw);
  if (!parsed) {
    console.error(`✗ ${target} exists but does not hold a 32-byte key — refusing to touch it`);
    process.exit(2);
  }
  console.log(`= root key already exists: ${target}`);
  console.log(`  fingerprint (rootKid): ${fingerprint(parsed)}`);
  console.log('  Nothing was changed. To rotate the root use the console command keys.root.rotate with a NEW file.');
  process.exit(0);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
const root = randomBytes(32);
fs.writeFileSync(target, root.toString('hex') + '\n', { mode: 0o600 });
try {
  fs.chmodSync(target, 0o600);
} catch {}

console.log(`✓ root key written: ${target}`);
console.log(`  fingerprint (rootKid): ${fingerprint(root)}`);
console.log('');
console.log('CEREMONY — do this now, not later:');
console.log('  1. Copy the file to TWO offline media (USB/paper), held by TWO different people.');
console.log('  2. Record the fingerprint above in the platform console (Keys → Root) for verification.');
console.log('  3. Set KEYS_ROOT_KEY_FILE to this path on EVERY API instance (same file, mode 600).');
console.log('  4. Rehearse recovery: node apps/api/scripts/keys-verify-root.cjs <copy> — before go-live and quarterly.');
console.log('  Losing the root = losing every encrypted field and every issued key. There is no recovery without it.');

function parseRoot(raw) {
  if (raw.length === 32) return Buffer.from(raw);
  const text = raw.toString('utf8').trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  if (/^[A-Za-z0-9+/=_-]{43,44}$/.test(text)) {
    const b = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length === 32) return b;
  }
  return null;
}

function fingerprint(root) {
  return createHash('sha256').update(root).digest('hex').slice(0, 16);
}
