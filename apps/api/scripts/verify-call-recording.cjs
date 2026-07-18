/* eslint-disable */
// Запись звонка (подсистема движка core/calls) — e2e БЕЗ egress-контейнера:
// строка CallRecording+клеймы сидятся напрямую (@prisma/client — прецедент verify-files),
// fixture.ogg кладётся в LIVEKIT_EGRESS_DIR, self-signed вебхук egress_ended запускает
// НАСТОЯЩУЮ финализацию: ingestLocalFile → CallRecording ready → доставка клеймов →
// VoiceRecording source='call' в Диктофоне у клеймантов (общий fileId) + уведомления.
// Требует: API на 3001, LIVEKIT_* + LIVEKIT_EGRESS_DIR в .env, ffmpeg в PATH (фикстура).
// Run: node scripts/verify-call-recording.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const BASE = process.env.API_URL || 'http://localhost:3001/api';
const CREDS = {
  t1: { phone: '+77001234567', password: 'Test1234!' },
  t2: { phone: '+77012345678', password: 'Test1234!' },
  t3: { phone: '+77023456789', password: 'Test1234!' },
};

let passed = 0, failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? `  (${extra})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, p, { token, body } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json };
}
async function login(creds) {
  const { status, json } = await http('POST', '/auth/login', { body: creds });
  if (status !== 200 && status !== 201) throw new Error(`login failed ${status}`);
  const token = json.data.accessToken;
  const me = await http('GET', '/users/me', { token });
  return { token, id: me.json.data.id };
}
function withPrisma(fn) {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  return Promise.resolve(fn(prisma)).finally(() => prisma.$disconnect());
}
async function signedWebhook(payload) {
  const body = JSON.stringify(payload);
  const { AccessToken } = require('livekit-server-sdk');
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { ttl: 600 });
  at.sha256 = crypto.createHash('sha256').update(body).digest('base64');
  const jwt = await at.toJwt();
  const res = await fetch(`${BASE}/calls/livekit/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/webhook+json', Authorization: jwt },
    body,
  });
  return res.status;
}
const joinWebhook = (roomName, userId) =>
  signedWebhook({ event: 'participant_joined', id: `evt_${crypto.randomUUID()}`, room: { name: roomName }, participant: { identity: userId } });
async function waitFor(fn, ms = 8000, step = 300) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(step);
  }
}

async function main() {
  console.log('== verify-call-recording ==');
  const t1 = await login(CREDS.t1), t2 = await login(CREDS.t2), t3 = await login(CREDS.t3);

  const status = await http('GET', '/calls/status', { token: t1.token });
  if (!status.json?.data?.enabled) {
    console.log('LIVEKIT_* не заданы — SKIP.');
    process.exit(0);
  }
  check('GET /calls/status.recordingEnabled=true (LIVEKIT_EGRESS_DIR задан)', status.json.data.recordingEnabled === true);
  if (!status.json.data.recordingEnabled) process.exit(1);

  const egressDir = path.resolve(path.join(__dirname, '..'), process.env.LIVEKIT_EGRESS_DIR);
  fs.mkdirSync(egressDir, { recursive: true });

  // Фикстура: настоящий 1-сек OGG/opus (magic-bytes инжеста должны пройти честно).
  // ffmpeg — тот же, что у движков (npm ffmpeg-static), с фолбэком на PATH.
  const fixtureName = `verify_${crypto.randomUUID().slice(0, 8)}.ogg`;
  const fixturePath = path.join(egressDir, fixtureName);
  let ffmpegBin = 'ffmpeg';
  try { ffmpegBin = require('ffmpeg-static') || 'ffmpeg'; } catch { /* PATH-фолбэк */ }
  try {
    execFileSync(ffmpegBin, ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', '-y', fixturePath], { stdio: 'ignore' });
  } catch {
    console.log('ffmpeg недоступен — фикстуру не собрать, SKIP.');
    process.exit(0);
  }

  // ---------- Подготовка: DM + сессия + участники (self-signed вебхуки) ----------
  await withPrisma(async (p) => {
    await p.callSession.updateMany({ where: { refType: 'chat', status: 'active' }, data: { status: 'ended', endedAt: new Date() } });
    const [a, b] = [t1.id, t2.id].sort();
    await p.contactLink.upsert({
      where: { userAId_userBId: { userAId: a, userBId: b } },
      update: {},
      create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: t1.id },
    });
  });
  const dm = await http('POST', '/messenger/chats/dm', { token: t1.token, body: { userId: t2.id } });
  const dmId = dm.json.data.id;
  const tok = await http('POST', '/calls/token', { token: t1.token, body: { refType: 'chat', refId: dmId } });
  const sessionId = tok.json?.data?.sessionId;
  const roomName = tok.json?.data?.roomName;
  check('сессия звонка создана', !!sessionId && !!roomName, JSON.stringify(tok.json));
  await joinWebhook(roomName, t1.id);
  await joinWebhook(roomName, t2.id);

  // ---------- Гейты записи ----------
  const startByStranger = await http('POST', `/calls/rooms/${sessionId}/recording/start`, { token: t3.token });
  check('⏺ чужаком (не участник звонка) → 403', startByStranger.status === 403, `status ${startByStranger.status}`);
  const claimByStranger = await http('POST', `/calls/rooms/${sessionId}/recording/claim`, { token: t3.token });
  check('claim чужаком без записи → 404/403', claimByStranger.status === 404 || claimByStranger.status === 403, `status ${claimByStranger.status}`);

  // ---------- Сидинг записи (egress-контейнер не нужен: финализацию запускает вебхук) ----------
  const egressId = `EG_verify_${crypto.randomUUID().slice(0, 12)}`;
  const recordingId = crypto.randomUUID();
  await withPrisma(async (p) => {
    await p.callRecording.create({
      data: {
        id: recordingId, sessionId, refType: 'chat', refId: dmId,
        startedById: t1.id, egressId, status: 'recording',
      },
    });
    await p.callRecordingClaim.create({ data: { recordingId, userId: t1.id } }); // авто-клейм инициатора
  });

  // Активная запись видна в снимке звонка (activeCall.recording)
  const detail = await http('GET', `/messenger/chats/${dmId}`, { token: t1.token });
  check('activeCall.recording=true (индикатор «● Запись»)', detail.json?.data?.activeCall?.recording === true, JSON.stringify(detail.json?.data?.activeCall));

  // Дубль ⏺ при активной записи → 409 (partial unique одна активная на сессию)
  const dupStart = await http('POST', `/calls/rooms/${sessionId}/recording/start`, { token: t1.token });
  check('второй ⏺ при идущей записи → 409', dupStart.status === 409, `status ${dupStart.status} ${JSON.stringify(dupStart.json)}`);

  // ---------- egress_ended → настоящая финализация ----------
  const endedPayload = {
    event: 'egress_ended',
    id: `evt_${crypto.randomUUID()}`,
    egressInfo: {
      egressId,
      roomName,
      status: 'EGRESS_COMPLETE',
      fileResults: [{ filename: `/out/${fixtureName}`, duration: '1000000000', size: '4000' }],
    },
  };
  check('вебхук egress_ended → 200', (await signedWebhook(endedPayload)) === 200);

  const t1Rec = await waitFor(async () => {
    const has = await withPrisma(async (p) =>
      p.voiceRecording.findFirst({ where: { ownerId: t1.id, callRecordingId: recordingId }, select: { id: true } }),
    );
    if (!has) return null;
    const r = await http('GET', '/recorder/recordings', { token: t1.token });
    const row = (r.json?.data ?? []).find((x) => x.id === has.id);
    return row?.source === 'call' && row.file ? row : null;
  });
  check('у t1 (инициатор) запись source=call в Диктофоне с файлом', !!t1Rec, JSON.stringify(t1Rec));
  check('файл записи прошёл инжест (mime audio/ogg)', t1Rec?.file?.mime === 'audio/ogg', t1Rec?.file?.mime);
  const fileGone = await waitFor(async () => (!fs.existsSync(fixturePath) ? true : null), 4000);
  check('исходник в egress-каталоге прибран после ready', !!fileGone);

  const notif1 = await waitFor(async () => {
    const n = await http('GET', '/notifications', { token: t1.token });
    return (n.json?.data?.items ?? []).find((x) => x.type === 'call.recording.ready') ?? null;
  });
  check('уведомление call.recording.ready у t1', !!notif1);

  // ---------- Поздний claim (запись уже ready) → доставка сразу ----------
  const t2HadCall = await withPrisma(async (p) =>
    p.voiceRecording.count({ where: { ownerId: t2.id, callRecordingId: recordingId } }),
  );
  check('у t2 записи ещё НЕТ (не клеймился)', t2HadCall === 0, `count ${t2HadCall}`);
  const lateClaim = await http('POST', `/calls/rooms/${sessionId}/recording/claim`, { token: t2.token });
  check('поздний claim t2 → 200/201', lateClaim.status === 200 || lateClaim.status === 201, `status ${lateClaim.status} ${JSON.stringify(lateClaim.json)}`);
  const t2Rec = await waitFor(async () => {
    const has = await withPrisma(async (p) =>
      p.voiceRecording.findFirst({ where: { ownerId: t2.id, callRecordingId: recordingId }, select: { id: true } }),
    );
    if (!has) return null;
    const r = await http('GET', '/recorder/recordings', { token: t2.token });
    return (r.json?.data ?? []).find((x) => x.id === has.id) ?? null;
  });
  check('у t2 запись появилась после claim', !!t2Rec);
  check('файл ОБЩИЙ (один fileId у обоих — общий транскрипт)', !!t2Rec && t2Rec.file?.id === t1Rec.file.id, `${t2Rec?.file?.id} vs ${t1Rec?.file?.id}`);

  // ---------- Идемпотентность: повторный вебхук ничего не задваивает ----------
  await signedWebhook(endedPayload);
  await sleep(1200);
  const t1After = await http('GET', '/recorder/recordings', { token: t1.token });
  const countT1 = (t1After.json?.data ?? []).filter((x) => x.source === 'call').length;
  const t2After = await http('GET', '/recorder/recordings', { token: t2.token });
  const countT2 = (t2After.json?.data ?? []).filter((x) => x.source === 'call').length;
  const seeded = await withPrisma(async (p) => ({
    t1: await p.voiceRecording.count({ where: { ownerId: t1.id, callRecordingId: recordingId } }),
    t2: await p.voiceRecording.count({ where: { ownerId: t2.id, callRecordingId: recordingId } }),
    status: (await p.callRecording.findUnique({ where: { id: recordingId } }))?.status,
  }));
  check('повторный egress_ended: по ОДНОЙ записи на клейманта', seeded.t1 === 1 && seeded.t2 === 1, JSON.stringify(seeded));
  check('CallRecording в статусе ready', seeded.status === 'ready', String(seeded.status));
  void countT1; void countT2;

  // ---------- Уборка сессии ----------
  await http('POST', `/calls/rooms/${sessionId}/end`, { token: t1.token });

  console.log(failed === 0 ? `\nALL PASS (${passed})` : `\nFAILS: ${failed} (passed ${passed})`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
