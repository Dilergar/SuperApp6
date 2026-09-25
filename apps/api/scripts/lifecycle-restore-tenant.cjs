/* eslint-disable */
// Восстановление ОДНОЙ организации из бэкапа — шаги рунбука docs/operations_backup_dr.md
// (core/lifecycle Э6). Скрипт не ходит в базу сам: он зовёт команды Кабинета платформы
// `lifecycle.restore.extract` и `lifecycle.restore.import` (critical, через второго
// сотрудника) и печатает, что будет сделано, ДО того как это сделано.
//
//   node scripts/lifecycle-restore-tenant.cjs --workspace=<uuid> [--snapshot=<ISO>]         — предпросмотр извлечения
//   node scripts/lifecycle-restore-tenant.cjs --workspace=<uuid> --snapshot=<ISO> --apply   — извлечь (архив восстановления)
//   node scripts/lifecycle-restore-tenant.cjs --export=<uuid>                               — предпросмотр импорта
//   node scripts/lifecycle-restore-tenant.cjs --export=<uuid> --apply                       — вернуть строки
//
// Доступ: `LIFECYCLE_CONSOLE_TOKEN` — токен кабинета сотрудника с правом lifecycle.restore.write и
// открытым окном sudo (вход в Кабинет → «Подтвердить личность»). В development без токена —
// вход аккаунтом сьюта (дев-код SMS). Паролей и кодов скрипт не спрашивает и не хранит.
//
// Порядок на проде: поднять кластер из бэкапа на точку времени (pgBackRest --type=time) →
// LIFECYCLE_RESTORE_SOURCE_URL на него (роль только на чтение) → извлечение → импорт →
// сверка счётчиков (печатается здесь же) → кластер-источник погасить.
const nodeCrypto = require('node:crypto');
const { BASE, call, consoleLogin, consoleSudo, SUITE } = require('./_lib.cjs');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const UUID = /^[0-9a-f-]{36}$/i;

async function token() {
  if (process.env.LIFECYCLE_CONSOLE_TOKEN) return process.env.LIFECYCLE_CONSOLE_TOKEN;
  if (process.env.NODE_ENV === 'production') throw new Error('LIFECYCLE_CONSOLE_TOKEN is required outside development');
  const c = await consoleLogin(SUITE.p1);
  if (!c.token) throw new Error('console login failed (development suite account)');
  await consoleSudo(c.token);
  return c.token;
}

const cmd = (t, key, input, preview) =>
  call('POST', `/platform/commands/${key}${preview ? '/preview' : ''}`, t, preview ? { input } : { input, idempotencyKey: nodeCrypto.randomUUID(), reason: String(args.reason ?? 'tenant restore (runbook)') });

function table(rows, cols) {
  for (const r of rows) console.log('  ' + cols.map((c) => String(r[c] ?? '').padEnd(c === 'policyId' ? 28 : 10)).join(' '));
}

async function waitArchive(t, exportId) {
  for (let i = 0; i < 240; i++) {
    const r = await call('GET', '/platform/data/restores', t);
    const a = (r.json?.data?.archives ?? []).find((x) => x.exportId === exportId);
    if (a && a.status !== 'queued' && a.status !== 'running') return a;
    await new Promise((res) => setTimeout(res, 5000));
  }
  throw new Error('the restore archive is not ready after 20 minutes — check the dashboard «Данные»');
}

async function waitRun(t, exportId, runId) {
  for (let i = 0; i < 720; i++) {
    const r = await call('GET', '/platform/data/restores', t);
    const a = (r.json?.data?.archives ?? []).find((x) => x.exportId === exportId);
    const run = a?.imports.find((x) => x.runId === runId);
    if (run && run.status !== 'running') return run;
    await new Promise((res) => setTimeout(res, 5000));
  }
  throw new Error('the import is still running after an hour — check the dashboard «Данные»');
}

async function main() {
  console.log(`API: ${BASE}`);
  const t = await token();
  if (args.workspace) {
    if (!UUID.test(String(args.workspace))) throw new Error('--workspace must be a uuid');
    const input = { workspaceId: String(args.workspace), ...(args.snapshot ? { snapshotAt: new Date(String(args.snapshot)).toISOString() } : {}) };
    const pv = await cmd(t, 'lifecycle.restore.extract', input, true);
    if (!pv.ok) throw new Error(`preview: ${pv.status} ${pv.code ?? ''}`);
    const tables = pv.json.data.result.tables;
    console.log(`\nИзвлечение организации ${input.workspaceId}: ${tables.length} таблиц, ${tables.reduce((a, x) => a + x.rows, 0)} строк`);
    table(tables, ['policyId', 'rows']);
    if (!args.apply) return console.log('\nПредпросмотр. Запуск: добавьте --apply (нужен второй сотрудник, если включены «четыре глаза»).');
    const r = await cmd(t, 'lifecycle.restore.extract', input, false);
    if (!r.ok) throw new Error(`extract: ${r.status} ${r.code ?? ''}`);
    if (r.json.data.status === 'pending') return console.log(`\nЗаявка ${r.json.data.requestId} ждёт второго сотрудника (Кабинет → «Заявки»). После одобрения — снова этот шаг не нужен: смотрите архив на вкладке «Бэкапы».`);
    const exportId = r.json.data.result.exportId;
    console.log(`\nАрхив восстановления ${exportId} собирается…`);
    const a = await waitArchive(t, exportId);
    console.log(`Архив: ${a.status}, строк ${a.rows ?? '—'}. Дальше: --export=${exportId}`);
    return;
  }
  if (args.export) {
    if (!UUID.test(String(args.export))) throw new Error('--export must be a uuid');
    const exportId = String(args.export);
    const pv = await cmd(t, 'lifecycle.restore.import', { exportId }, true);
    if (!pv.ok) throw new Error(`preview: ${pv.status} ${pv.code ?? ''} (подпись архива, стёртая организация или срок архива)`);
    const p = pv.json.data.result;
    console.log(`\nИмпорт в организацию ${p.workspaceId} (снимок ${p.snapshotAt}):`);
    table(p.tables.map((x) => ({ ...x, back: x.rows - x.present })), ['policyId', 'rows', 'present', 'back']);
    if (!args.apply) return console.log('\nПредпросмотр. Запуск: добавьте --apply.');
    const r = await cmd(t, 'lifecycle.restore.import', { exportId }, false);
    if (!r.ok) throw new Error(`import: ${r.status} ${r.code ?? ''}`);
    if (r.json.data.status === 'pending') return console.log(`\nЗаявка ${r.json.data.requestId} ждёт второго сотрудника.`);
    const runId = r.json.data.result.runId;
    console.log(`\nИмпорт ${runId} идёт…`);
    const run = await waitRun(t, exportId, runId);
    console.log(`Импорт: ${run.status}; стираний повторено: ${run.erasuresReplayed}; файлов без байтов: ${run.missingBlobs} (восстановить версиями S3)`);
    table(run.tables, ['policyId', 'inserted', 'skipped', 'failed']);
    if (run.tables.some((x) => x.failed > 0)) process.exitCode = 2;
    return;
  }
  console.log('Нужен --workspace=<uuid> (извлечение) или --export=<uuid> (импорт). См. заголовок файла.');
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
