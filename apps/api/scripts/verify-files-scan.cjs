/* eslint-disable */
// Files Engine — антивирус (ClamAV, docker compose --profile scan up -d):
// EICAR-строка → scanStatus='infected' → выдача 403 + уведомление; чистый файл → clean + 200.
// Если контейнер clamav не поднят (нет TCP на CLAMAV_HOST:PORT или CLAMAV_HOST не задан) — SKIP.
// Run: node scripts/verify-files-scan.cjs
const fs = require('fs');
const path = require('path');
const net = require('net');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const BASE = 'http://localhost:3001/api';
const P1 = '+77009990001', PW = 'Test1234!';
// Стандартная тест-строка EICAR (не настоящий вирус; детектится всеми антивирусами).
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

let fails = 0;
const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };
async function call(method, p, token, body) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
async function uploadBytes(id, token, bytes, filename, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: mime }), filename);
  const res = await fetch(`${BASE}/files/${id}/content`, { method: 'PUT', headers: { Authorization: 'Bearer ' + token }, body: fd });
  return res.status;
}
const login = async (phone) => (await call('POST', '/auth/login', null, { phone, password: PW })).json.data.accessToken;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probe(host, port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(1500);
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.on('timeout', () => done(false));
  });
}

async function uploadWhole(token, { name, mime, bytes, profile = 'generic' }) {
  const init = await call('POST', '/files', token, { profile, name, mime, size: bytes.length });
  const id = init.json.data.file.id;
  await uploadBytes(id, token, bytes, name, mime);
  await call('POST', `/files/${id}/complete`, token, {});
  return id;
}

async function main() {
  const host = process.env.CLAMAV_HOST;
  const port = Number(process.env.CLAMAV_PORT || 3310);
  if (!host || !(await probe(host, port))) {
    console.log('SKIP: ClamAV не поднят (CLAMAV_HOST не задан или нет TCP). Запуск: docker compose --profile scan up -d');
    process.exit(0);
  }

  const prisma = new PrismaClient();
  const t1 = await login(P1);
  const u1 = (await prisma.user.findUnique({ where: { phone: P1 }, select: { id: true } })).id;

  try {
    // заражённый файл
    const badId = await uploadWhole(t1, { name: 'eicar.txt', mime: 'text/plain', bytes: Buffer.from(EICAR) });
    let scan = 'none';
    for (let i = 0; i < 60; i++) {
      const row = await prisma.fileObject.findUnique({ where: { id: badId }, select: { scanStatus: true } });
      scan = row?.scanStatus;
      if (scan === 'infected' || scan === 'clean') break;
      await sleep(1000);
    }
    check('EICAR → scanStatus=infected', scan === 'infected', scan);
    const badDl = await call('GET', `/files/${badId}/download`, t1);
    check('заражённый → выдача 403', badDl.status === 403, `status ${badDl.status}`);
    const notif = await prisma.notification.findFirst({ where: { userId: u1, type: 'files.scan.infected' }, orderBy: { createdAt: 'desc' } });
    check('уведомление files.scan.infected загрузившему', !!notif, notif?.title);

    // чистый файл
    const okId = await uploadWhole(t1, { name: 'clean.txt', mime: 'text/plain', bytes: Buffer.from('обычный текст без вирусов') });
    let scan2 = 'none';
    for (let i = 0; i < 60; i++) {
      const row = await prisma.fileObject.findUnique({ where: { id: okId }, select: { scanStatus: true } });
      scan2 = row?.scanStatus;
      if (scan2 === 'clean' || scan2 === 'infected') break;
      await sleep(1000);
    }
    check('чистый файл → scanStatus=clean', scan2 === 'clean', scan2);
    const okDl = await call('GET', `/files/${okId}/download`, t1);
    check('чистый → выдача 200', okDl.ok, `status ${okDl.status}`);

    // ===== Политика «что вообще проверяем» (решение продукта 2026-07-26) =====
    // Офисный документ НЕ проверяем: его правит наш редактор, и полный скан на каждое
    // автосохранение — дорогая работа впустую. Кладём внутрь EICAR: если бы файл ушёл
    // в скан, вердикт был бы 'infected'.
    const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const officeId = await uploadWhole(t1, { name: 'смета.xlsx', mime: XLSX_MIME, bytes: Buffer.from(EICAR) });
    let officeScan = 'none';
    for (let i = 0; i < 15; i++) {
      officeScan = (await prisma.fileObject.findUnique({ where: { id: officeId }, select: { scanStatus: true } }))?.scanStatus;
      if (officeScan !== 'none' && officeScan !== 'pending') break;
      await sleep(1000);
    }
    check('офисный документ антивирусом НЕ гоняется (scanStatus=skipped)', officeScan === 'skipped', officeScan);
    check('…и выдаётся нормально', (await call('GET', `/files/${officeId}/download`, t1)).ok);

    // Архив — единственный класс, внутрь которого не смотрит ни один наш конвейер:
    // его антивирус обязан вскрывать сам.
    const zipId = await uploadWhole(t1, { name: 'вложение.zip', mime: 'application/zip', bytes: Buffer.from(EICAR) });
    let zipScan = 'none';
    for (let i = 0; i < 60; i++) {
      zipScan = (await prisma.fileObject.findUnique({ where: { id: zipId }, select: { scanStatus: true } }))?.scanStatus;
      if (zipScan === 'infected' || zipScan === 'clean') break;
      await sleep(1000);
    }
    check('архив проверяется → EICAR внутри найден', zipScan === 'infected', zipScan);

    // Макро-формат — исключением НЕ является: макрос в офисном файле это классический
    // способ разослать вирус коллегам.
    const macroId = await uploadWhole(t1, {
      name: 'отчёт.xlsm',
      mime: 'application/vnd.ms-excel.sheet.macroEnabled.12',
      bytes: Buffer.from(EICAR),
    });
    let macroScan = 'none';
    for (let i = 0; i < 60; i++) {
      macroScan = (await prisma.fileObject.findUnique({ where: { id: macroId }, select: { scanStatus: true } }))?.scanStatus;
      if (macroScan === 'infected' || macroScan === 'clean') break;
      await sleep(1000);
    }
    check('макро-офис проверяется (.xlsm)', macroScan === 'infected', macroScan);

    // Системные/конфигурационные расширения не принимаются вовсе
    for (const bad of ['вирус.exe', 'дамп.bin', 'настройки.conf', 'ключи.ini', 'правка.reg']) {
      const res = await call('POST', '/files', t1, { profile: 'generic', name: bad, mime: 'application/octet-stream', size: 10 });
      check(`«${bad}» не принимается вовсе`, res.status === 400, `status ${res.status}`);
    }

    for (const id of [officeId, zipId, macroId]) {
      await prisma.fileObject.deleteMany({ where: { id } });
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(fails === 0 ? '\nALL PASS' : `\nFAILED: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
