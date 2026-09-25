/* eslint-disable */
// Реплей журнала стираний после восстановления базы из бэкапа — шаг 3 рунбука
// docs/operations_backup_dr.md «Восстановление всей базы (PITR)», ДО открытия трафика
// (core/lifecycle; Dropbox 2017: «карантин» вернул удалённое). Восстановленная база не знает о
// стираниях после точки восстановления — их знает журнал, выгруженный NDJSON в объектное
// хранилище (`lifecycle/erasure-journal/ГГГГ/ММ/ДД/*.ndjson`, оба репозитория).
//
//   node scripts/lifecycle-replay-erasures.cjs --dir=<каталог с NDJSON> --since=<точка восстановления ISO>          — предпросмотр
//   node scripts/lifecycle-replay-erasures.cjs --dir=<каталог с NDJSON> --since=<точка восстановления ISO> --apply  — реплей
//
// Каталог — копия префикса `lifecycle/erasure-journal/` (`aws s3 cp --recursive …`); в разработке
// по умолчанию — local-хранилище API. Берутся строки этапов «точки невозврата» (скрыт, горячее
// стёрто, ключи уничтожены, завершено, повторено) не раньше `--since`: субъект, найденный живым в
// восстановленной базе, скрывается сразу и стирается заново без грейса (команда Кабинета
// `lifecycle.erasure.replay`: критично, через второго сотрудника; заморозки действуют).
//
// Доступ: `LIFECYCLE_CONSOLE_TOKEN` — токен Кабинета сотрудника с правом lifecycle.erasure.write и
// открытым окном sudo. В development без токена — вход аккаунтом сьюта (дев-код SMS). Скрипт в
// базу не ходит и псевдонимы не расшифровывает (их сверяет API ключом `lifecycle`).
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { BASE, call, consoleLogin, consoleSudo, SUITE } = require('./_lib.cjs');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
  }),
);
/** Этапы, после которых стирание не отменяется: субъект обязан остаться стёртым и после восстановления */
const FINAL_STAGES = new Set(['hidden', 'hot_purged', 'keys_destroyed', 'completed', 'replayed']);
/** Потолок псевдонимов одной команды (`LIFECYCLE_REPLAY_MAX_PSEUDONYMS`) */
const BATCH = 2000;
const PSEUDONYM = /^[A-Za-z0-9_:.-]{16,160}$/;

async function token() {
  if (process.env.LIFECYCLE_CONSOLE_TOKEN) return process.env.LIFECYCLE_CONSOLE_TOKEN;
  if (process.env.NODE_ENV === 'production') throw new Error('LIFECYCLE_CONSOLE_TOKEN is required outside development');
  const c = await consoleLogin(SUITE.p1);
  if (!c.token) throw new Error('console login failed (development suite account)');
  await consoleSudo(c.token);
  return c.token;
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.ndjson')) yield p;
  }
}

/** Псевдонимы субъектов, дошедших до точки невозврата не раньше `since`. */
function collect(dir, since) {
  const out = new Set();
  let files = 0;
  let lines = 0;
  let bad = 0;
  for (const file of walk(dir)) {
    files++;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      lines++;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        bad++;
        continue;
      }
      if (!FINAL_STAGES.has(j.stage) || typeof j.pseudonym !== 'string' || !PSEUDONYM.test(j.pseudonym)) continue;
      if (since && !(new Date(j.at).getTime() >= since.getTime())) continue;
      out.add(j.pseudonym);
    }
  }
  return { pseudonyms: [...out], files, lines, bad };
}

const cmd = (t, input, preview) =>
  call('POST', `/platform/commands/lifecycle.erasure.replay${preview ? '/preview' : ''}`, t, preview ? { input } : { input, idempotencyKey: nodeCrypto.randomUUID(), reason: String(args.reason ?? 'erasure journal replay after a database restore (runbook)') });

async function main() {
  const storageRoot = path.resolve(__dirname, '..', process.env.FILES_LOCAL_ROOT ?? './storage');
  const dir = path.resolve(String(args.dir ?? path.join(storageRoot, 'lifecycle', 'erasure-journal')));
  if (!fs.existsSync(dir)) throw new Error(`no journal directory ${dir} — copy the prefix lifecycle/erasure-journal/ of the object storage first`);
  if (!args.since && process.env.NODE_ENV === 'production') throw new Error('--since=<restore point ISO> is required in production');
  const since = args.since ? new Date(String(args.since)) : null;
  if (since && Number.isNaN(since.getTime())) throw new Error('--since must be an ISO date-time');

  const { pseudonyms, files, lines, bad } = collect(dir, since);
  console.log(`API: ${BASE}`);
  console.log(`Журнал: ${dir} — файлов ${files}, строк ${lines}${bad ? `, битых ${bad}` : ''}; с ${since ? since.toISOString() : 'начала'}`);
  console.log(`Субъектов на реплей (точка невозврата пройдена): ${pseudonyms.length}`);
  if (!pseudonyms.length) return;
  const t = await token();
  const pv = await cmd(t, { pseudonyms: pseudonyms.slice(0, BATCH) }, true);
  if (!pv.ok) throw new Error(`preview: ${pv.status} ${pv.code ?? ''}`);
  if (!args.apply) return console.log(`\nПредпросмотр. Запуск: добавьте --apply (${Math.ceil(pseudonyms.length / BATCH)} команд; нужен второй сотрудник, если включены «четыре глаза»).`);

  for (let i = 0; i < pseudonyms.length; i += BATCH) {
    const r = await cmd(t, { pseudonyms: pseudonyms.slice(i, i + BATCH) }, false);
    if (!r.ok) throw new Error(`replay: ${r.status} ${r.code ?? ''}`);
    if (r.json.data.status === 'pending') console.log(`Пачка ${i / BATCH + 1}: заявка ${r.json.data.requestId} ждёт второго сотрудника (Кабинет → «Заявки»).`);
    else console.log(`Пачка ${i / BATCH + 1}: прогон ${r.json.data.result.runId} (${r.json.data.result.pseudonyms} псевдонимов) — идёт джобом.`);
  }
  console.log('\nПрогресс — вкладка «Стирания и заморозки» дашборда «Данные»: воскресшие субъекты появятся в очереди со сроком «сейчас». Трафик — после того, как их этап «скрыт» пройден.');
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
