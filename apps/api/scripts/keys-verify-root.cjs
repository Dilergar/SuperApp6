#!/usr/bin/env node
/* eslint-disable */
// ============================================================
// Учение восстановления корня (core/keys): доказывает, что КОПИЯ файла корня открывает
// keystore — без запуска API. Читает файл, печатает отпечаток, берёт из БД версии
// платформенных ключей и распаковывает каждую (тот же формат обёртки, что у
// SoftwareProvider: 1 | iv(12) | tag(16) | ct, AES-256-GCM, AAD = `<kid>|<purpose>`).
//
// Run: node apps/api/scripts/keys-verify-root.cjs <path-to-copy>   (пусто → KEYS_ROOT_KEY_FILE / ./.keys/root.key)
// Exit 0 — копия годна; 1 — не открывает (не та копия или чужой keystore); 2 — файл/БД недоступны.
// ============================================================
const fs = require('fs');
const path = require('path');
const { createDecipheriv, createHash } = require('crypto');
const { PrismaClient } = require('@prisma/client');

// .env API (тот же мини-парсер, что в _lib.cjs) — ради DATABASE_URL
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const file = path.resolve(process.argv[2] || process.env.KEYS_ROOT_KEY_FILE || path.join(process.cwd(), '.keys', 'root.key'));

async function main() {
  if (!fs.existsSync(file)) {
    console.error(`✗ file not found: ${file}`);
    process.exit(2);
  }
  const root = parseRoot(fs.readFileSync(file));
  if (!root) {
    console.error(`✗ ${file} does not hold a 32-byte key`);
    process.exit(2);
  }
  const kid = createHash('sha256').update(root).digest('hex').slice(0, 16);
  console.log(`file: ${file}`);
  console.log(`fingerprint (rootKid): ${kid}`);

  const prisma = new PrismaClient();
  try {
    const versions = await prisma.cryptoKeyVersion.findMany({
      where: { state: { not: 'destroyed' }, key: { scope: 'platform' } },
      include: { key: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!versions.length) {
      console.log('keystore has no platform versions yet — start the API once with this root, then rehearse again');
      process.exit(0);
    }
    let ok = 0;
    let foreign = 0;
    let bad = 0;
    for (const v of versions) {
      if (v.rootKid !== kid) {
        foreign++;
        continue;
      }
      try {
        unwrap(root, Buffer.from(v.wrappedMaterial), `${v.id}|${v.key.purpose}`);
        ok++;
      } catch {
        bad++;
        console.error(`  ✗ ${v.key.purpose}/${v.key.name} v${v.version} (${v.id}) does not open`);
      }
    }
    console.log(`versions: ${versions.length} · opened: ${ok} · wrapped by another root: ${foreign} · failed: ${bad}`);
    if (bad > 0 || (ok === 0 && foreign > 0)) {
      console.log('❌ this copy does NOT open the keystore');
      process.exit(1);
    }
    console.log('✅ this copy opens the keystore — recovery rehearsal passed');
  } finally {
    await prisma.$disconnect();
  }
}

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

function unwrap(root, wrapped, aad) {
  if (wrapped[0] !== 1) throw new Error('format');
  const iv = wrapped.subarray(1, 13);
  const tag = wrapped.subarray(13, 29);
  const ct = wrapped.subarray(29);
  const d = createDecipheriv('aes-256-gcm', root, iv);
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(2);
});
