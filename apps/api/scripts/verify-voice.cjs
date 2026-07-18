/* eslint-disable */
// Голосовой движок (core/voice) + Диктофон — e2e:
// волна в конвейере, голосовое в чат, транскрипция (mock-драйвер: API должен быть
// запущен с VOICE_STT_MOCK=true — иначе STT-часть SKIP), идемпотентность (1 файл =
// 1 транскрипт), доступ (собеседник читает, чужак 403), Диктофон CRUD + уведомление.
// Run: node scripts/verify-voice.cjs
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
async function call(method, p, token, body) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => (await call('POST', '/auth/login', null, { phone, password: PW })).json.data.accessToken;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 2-сек WAV (RIFF/PCM 16кГц mono, синус 440 Гц) — фикстура без бинарей и ffmpeg */
function makeWav(seconds = 2, rate = 16000) {
  const n = Math.floor(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, t * 4, (seconds - t) * 4);
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * t) * 8000 * env), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function uploadWhole(token, { name, mime, bytes, profile }) {
  const init = await call('POST', '/files', token, { profile, name, mime, size: bytes.length });
  if (!init.ok) throw new Error(`init upload: ${init.status} ${JSON.stringify(init.json)}`);
  const id = init.json.data.file.id;
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: mime }), name);
  const put = await fetch(`${BASE}/files/${id}/content`, { method: 'PUT', headers: { Authorization: 'Bearer ' + token }, body: fd });
  if (!put.ok) throw new Error(`put bytes: ${put.status}`);
  const done = await call('POST', `/files/${id}/complete`, token, {});
  if (!done.ok) throw new Error(`complete: ${done.status} ${JSON.stringify(done.json)}`);
  return id;
}

async function waitPipeline(prisma, fileId, timeoutSec = 30) {
  for (let i = 0; i < timeoutSec; i++) {
    const row = await prisma.fileObject.findUnique({ where: { id: fileId }, select: { meta: true } });
    const meta = row?.meta ?? {};
    if (meta.pipeline === 'done' || meta.pipeline === 'exhausted' || meta.pipeline === 'failed') return meta;
    await sleep(1000);
  }
  return (await prisma.fileObject.findUnique({ where: { id: fileId }, select: { meta: true } }))?.meta ?? {};
}

async function pollTranscript(token, fileId, timeoutSec = 30) {
  let last = null;
  for (let i = 0; i < timeoutSec; i++) {
    const res = await call('GET', `/voice/transcripts/${fileId}`, token);
    last = res.json?.data ?? null;
    if (last && (last.status === 'ready' || last.status === 'error')) return last;
    await sleep(1000);
  }
  return last;
}

async function main() {
  const prisma = new PrismaClient();
  const [t1, t2, t3] = await Promise.all([login(P1), login(P2), login(P3)]);
  const uid = async (phone) => (await prisma.user.findUnique({ where: { phone }, select: { id: true } })).id;
  const [u1, u2] = await Promise.all([uid(P1), uid(P2)]);

  try {
    // ---------- 0. Статус движка ----------
    const status = await call('GET', '/voice/status', t1);
    check('GET /voice/status отвечает', status.ok, `status ${status.status}`);
    // Жёсткие STT-проверки — только на mock-драйвере (у живого Whisper текст
    // непредсказуем, а фикстура — синус); live/off → SKIP STT-части.
    const sttEnabled = !!status.json?.data?.mock;
    const sttOff = !status.json?.data?.enabled;
    console.log(`    STT: ${status.json?.data?.mock ? 'mock' : status.json?.data?.enabled ? 'live (STT-чеки SKIP — нужен VOICE_STT_MOCK=true)' : 'ВЫКЛЮЧЕН (STT-чеки SKIP)'}`);

    // ---------- 1. Волна в конвейере (voice_message) ----------
    const wav = makeWav(2);
    const voiceFileId = await uploadWhole(t1, { name: 'voice-test.wav', mime: 'audio/wav', bytes: wav, profile: 'voice_message' });
    const meta1 = await waitPipeline(prisma, voiceFileId);
    check('конвейер voice_message done', meta1.pipeline === 'done', String(meta1.pipeline));
    if (meta1.pipeline === 'done' && meta1.durationMs == null) {
      console.log('    (ffmpeg недоступен — волна/длительность SKIP)');
    } else {
      check('meta.durationMs ≈ 2с', typeof meta1.durationMs === 'number' && meta1.durationMs > 1500 && meta1.durationMs < 2600, String(meta1.durationMs));
      check('meta.waveform — непустой массив', Array.isArray(meta1.waveform) && meta1.waveform.length > 10, `len ${Array.isArray(meta1.waveform) ? meta1.waveform.length : 'нет'}`);
      if (Array.isArray(meta1.waveform)) {
        check('волна нормирована 0..100', meta1.waveform.every((v) => typeof v === 'number' && v >= 0 && v <= 100) && Math.max(...meta1.waveform) === 100, `max ${Math.max(...meta1.waveform)}`);
      }
    }

    // ---------- 2. Голосовое в чат (существующий attachment-путь) ----------
    // связь t1↔t2 (канонический порядок) — идемпотентный upsert
    const [a, b] = [u1, u2].sort();
    await prisma.contactLink.upsert({
      where: { userAId_userBId: { userAId: a, userBId: b } },
      update: {},
      create: { userAId: a, userBId: b, roleAForB: 'Друг', roleBForA: 'Друг', initiatedBy: u1 },
    });
    const dm = await call('POST', '/messenger/chats/dm', t1, { userId: u2 });
    check('DM создан/найден', dm.ok, `status ${dm.status}`);
    const chatId = dm.json?.data?.id;
    const sent = await call('POST', `/messenger/chats/${chatId}/messages/attachments`, t1, { fileIds: [voiceFileId] });
    check('голосовое отправлено attachment-сообщением', sent.ok, `status ${sent.status}`);
    const sentMsg = sent.json?.data;
    check('payload: kind=audio, profile=voice_message', sentMsg?.payload?.files?.[0]?.kind === 'audio' && sentMsg?.payload?.files?.[0]?.profile === 'voice_message', JSON.stringify(sentMsg?.payload?.files?.[0] ?? null));

    // ---------- 3. Транскрипция (mock) ----------
    if (sttOff) {
      const r = await call('POST', '/voice/transcripts', t1, { fileId: voiceFileId });
      check('движок выключен → POST /voice/transcripts 400', r.status === 400, `status ${r.status}`);
    }
    if (!sttEnabled) {
      console.log('    SKIP: транскрипция/идемпотентность/доступ (нужен VOICE_STT_MOCK=true)');
    } else {
      const req1 = await call('POST', '/voice/transcripts', t1, { fileId: voiceFileId });
      check('запрос расшифровки принят', req1.ok, `status ${req1.status} ${JSON.stringify(req1.json)}`);
      const tr = await pollTranscript(t1, voiceFileId);
      check('транскрипт ready', tr?.status === 'ready', tr?.status);
      check('текст непустой', !!tr?.text && tr.text.length > 10, tr?.text?.slice(0, 40));
      check('сегменты со спикерами (диаризация)', Array.isArray(tr?.segments) && tr.segments.length >= 2 && tr.segments.some((s) => s.speaker), `segments ${tr?.segments?.length}`);

      // идемпотентность: повторный запрос → та же строка
      const req2 = await call('POST', '/voice/transcripts', t1, { fileId: voiceFileId });
      check('повторный POST → тот же транскрипт (кэш навсегда)', req2.ok && req2.json.data.status === 'ready' && req2.json.data.createdAt === tr.createdAt, req2.json?.data?.createdAt);

      // доступ: собеседник видит (canView через chat_message), чужак — нет
      const asPeer = await call('GET', `/voice/transcripts/${voiceFileId}`, t2);
      check('собеседник читает транскрипт голосового', asPeer.ok && asPeer.json.data.status === 'ready', `status ${asPeer.status}`);
      const asStranger = await call('GET', `/voice/transcripts/${voiceFileId}`, t3);
      check('чужак → 403/404', asStranger.status === 403 || asStranger.status === 404, `status ${asStranger.status}`);
    }

    // ---------- 4. Диктофон: CRUD + доступ ----------
    const dictFileId = await uploadWhole(t1, { name: 'meeting.wav', mime: 'audio/wav', bytes: makeWav(3), profile: 'dictaphone' });
    const created = await call('POST', '/recorder/recordings', t1, { fileId: dictFileId, title: 'Планёрка по движку' });
    check('запись Диктофона создана', created.ok, `status ${created.status} ${JSON.stringify(created.json)}`);
    const recId = created.json?.data?.id;
    check('файл привязан к записи', created.json?.data?.file?.id === dictFileId, created.json?.data?.file?.id);

    const list1 = await call('GET', '/recorder/recordings', t1);
    check('запись в списке владельца', list1.ok && list1.json.data.some((r) => r.id === recId));
    const list2 = await call('GET', '/recorder/recordings', t2);
    check('в чужом списке записи нет', list2.ok && !list2.json.data.some((r) => r.id === recId));

    const foreignPatch = await call('PATCH', `/recorder/recordings/${recId}`, t2, { title: 'взлом' });
    check('чужой PATCH → 403', foreignPatch.status === 403, `status ${foreignPatch.status}`);
    const foreignDel = await call('DELETE', `/recorder/recordings/${recId}`, t2);
    check('чужой DELETE → 403', foreignDel.status === 403, `status ${foreignDel.status}`);

    const renamed = await call('PATCH', `/recorder/recordings/${recId}`, t1, { title: 'Планёрка (переименована)' });
    check('rename работает', renamed.ok && renamed.json.data.title === 'Планёрка (переименована)');

    if (sttEnabled) {
      // расшифровка записи Диктофона (diarize) + уведомление владельцу
      const reqD = await call('POST', '/voice/transcripts', t1, { fileId: dictFileId, language: 'ru', diarize: true });
      check('расшифровка записи Диктофона принята', reqD.ok, `status ${reqD.status}`);
      const trD = await pollTranscript(t1, dictFileId);
      check('транскрипт Диктофона ready', trD?.status === 'ready', trD?.status);

      let notif = null;
      for (let i = 0; i < 12 && !notif; i++) {
        notif = await prisma.notification.findFirst({
          where: { userId: u1, type: 'voice.transcript.ready', createdAt: { gt: new Date(Date.now() - 60_000) } },
          orderBy: { createdAt: 'desc' },
        });
        if (!notif) await sleep(1000);
      }
      check('уведомление voice.transcript.ready владельцу', !!notif, notif?.title);
      check('дип-линк ведёт в Диктофон', !!notif?.actionUrl && notif.actionUrl.includes(`/recorder?id=${recId}`), notif?.actionUrl);

      // чужой файл Диктофона: посторонний не может ни читать, ни заказывать
      const strangerReq = await call('POST', '/voice/transcripts', t2, { fileId: dictFileId });
      check('чужой файл Диктофона → запрос 403/404', strangerReq.status === 403 || strangerReq.status === 404, `status ${strangerReq.status}`);
    }

    // ---------- 5. Удаление записи: связи сняты, файл прибран, транскрипт удалён ----------
    const del = await call('DELETE', `/recorder/recordings/${recId}`, t1);
    check('владелец удалил запись', del.ok, `status ${del.status}`);
    const linksLeft = await prisma.fileLink.count({ where: { refType: 'voice_recording', refId: recId } });
    check('fileLink снят', linksLeft === 0, `осталось ${linksLeft}`);
    const fileRow = await prisma.fileObject.findUnique({ where: { id: dictFileId }, select: { status: true, deletedAt: true } });
    check('файл записи прибран (soft-delete)', fileRow?.status === 'deleted' && !!fileRow?.deletedAt, fileRow?.status);
    const trLeft = await prisma.voiceTranscript.count({ where: { fileId: dictFileId } });
    check('транскрипт удалён вместе с записью', trLeft === 0, `осталось ${trLeft}`);

    // ---------- 6. Шаренный файл: удаление записи НЕ убивает транскрипт чата ----------
    // voiceFileId живёт вложением в DM (секция 2); создаём из него запись Диктофона
    // (профиль voice_message разрешён) и удаляем — файл и транскрипт чата должны выжить
    const rec2 = await call('POST', '/recorder/recordings', t1, { fileId: voiceFileId, title: 'Из чат-голосового' });
    check('запись из чат-голосового создана (шаренный файл)', rec2.ok, `status ${rec2.status}`);
    if (rec2.ok) {
      const del2 = await call('DELETE', `/recorder/recordings/${rec2.json.data.id}`, t1);
      check('удаление записи с шаренным файлом ок', del2.ok, `status ${del2.status}`);
      const sharedFile = await prisma.fileObject.findUnique({ where: { id: voiceFileId }, select: { status: true } });
      check('файл чат-голосового жив (линк чата остался)', sharedFile?.status === 'ready', sharedFile?.status);
      if (sttEnabled) {
        const trShared = await prisma.voiceTranscript.count({ where: { fileId: voiceFileId } });
        check('транскрипт чат-голосового ПЕРЕЖИЛ удаление записи', trShared === 1, `count ${trShared}`);
        const asPeerAfter = await call('GET', `/voice/transcripts/${voiceFileId}`, t2);
        check('собеседник по-прежнему читает транскрипт', asPeerAfter.ok && asPeerAfter.json.data.status === 'ready', `status ${asPeerAfter.status}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(fails === 0 ? '\nALL PASS' : `\nFAILED: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
