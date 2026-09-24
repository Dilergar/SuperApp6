/* eslint-disable */
// verify-partitions — партиции журналов под функциями владельца (core/lifecycle, миграция core_lifecycle).
//
// Проверяет то, что обещает план §5.3, на ЖИВОЙ базе dev-стенда:
//   - ATTACH-путь создания листа не берёт ACCESS EXCLUSIVE на родителя (проба pg_locks);
//   - создание идемпотентно, лист принадлежит владельцу данных, DEFAULT-партиция запрещена;
//   - пол срока: свежий лист функция не сбрасывает; старый — сбрасывает;
//   - «detach pending» (оборванный DETACH CONCURRENTLY) функция доводит FINALIZE и сбрасывает;
//   - заморозка держит сброс: класс на всю платформу — всегда, прочие — до отметки извлечения;
//   - очередь: лист с необработанной строкой не сбрасывается;
//   - событийный триггер режет DROP защищённой таблицы вне роли владельца;
//   - append-only денег и заморозок (UPDATE/DELETE/TRUNCATE падают);
//   - реальные родители: ≥ 3 листов вперёд, нет DEFAULT и зависших detach, правила = реестр;
//   - доставки уведомлений: created_at = момент события; вебхуки: created_at у времени id (v7);
//   - дев-ручка движка: здоровье и ночное обслуживание отвечают.
// Разрушительное — на пробном родителе `lc_probe.events` (своя схема, правило вставляется и
// удаляется сьютом) или в транзакциях, которые откатываются: следов в базе не остаётся.
//
// Запуск (API поднят, db-roles.sql применён — иначе проверки триггера пропускаются): node scripts/verify-partitions.cjs
const { PrismaClient } = require('@prisma/client');
const { LIFECYCLE_POLICIES, LIFECYCLE_POLICY_IDS, uuidVersion, uuidv7Time } = require('@superapp/shared');
const { SUITE, login, call, makeChecker, crash } = require('./_lib.cjs');

const { check, finish } = makeChecker();
const PARENT = 'lc_probe.events';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const monthStart = (y, m) => new Date(Date.UTC(y, m, 1));
const leafOf = (d) => `events_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/** Ошибка базы как текст (Prisma заворачивает сообщение PostgreSQL). */
const errText = (e) => String(e?.meta?.message ?? e?.message ?? e);

/** Выполнить и вернуть текст ошибки (или null, если прошло). */
async function failsWith(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return errText(e);
  }
}

/**
 * Разрушительная проба ВСЕГДА в откатываемой транзакции: если страж вдруг не сработал,
 * данные dev-базы не пострадают (TRUNCATE и DDL в PostgreSQL транзакционны).
 */
async function inRollback(prisma, sql) {
  let err = null;
  await prisma
    .$transaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(sql);
      } catch (e) {
        err = errText(e);
      }
      throw new Error('rollback-probe');
    })
    .catch((e) => {
      if (!String(e.message).includes('rollback-probe') && !err) err = errText(e);
    });
  return err;
}

/** Отдельный клиент с ОДНИМ соединением: SET сессии держится между запросами. */
function singleConnectionClient() {
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('connection_limit', '1');
  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}

async function setupProbe(prisma) {
  await prisma.$executeRawUnsafe(`DELETE FROM lifecycle_partition_specs WHERE parent = '${PARENT}'`);
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS lc_probe CASCADE');
  await prisma.$executeRawUnsafe('CREATE SCHEMA lc_probe');
  await prisma.$executeRawUnsafe(`CREATE TABLE lc_probe.events (
      id bigint GENERATED ALWAYS AS IDENTITY,
      at timestamptz NOT NULL,
      note text,
      processed_at timestamptz,
      PRIMARY KEY (id, at)
    ) PARTITION BY RANGE (at)`);
  const owner = (await prisma.$queryRawUnsafe(`SELECT 1 FROM pg_roles WHERE rolname = 'sa6_data_owner'`)).length > 0;
  if (owner) {
    await prisma.$executeRawUnsafe('GRANT USAGE, CREATE ON SCHEMA lc_probe TO sa6_data_owner');
    await prisma.$executeRawUnsafe('ALTER TABLE lc_probe.events OWNER TO sa6_data_owner');
  }
  await prisma.$executeRawUnsafe(`INSERT INTO lifecycle_partition_specs
      (parent, column_name, period, floor_days, require_archive, ahead_periods, insert_scale, lz4_columns, always_triggers, no_truncate_function, policy_id, data_class, hold_aware, require_processed)
      VALUES ('${PARENT}', 'at', 'month', 30, false, 3, 0.05, ARRAY['note'], ARRAY[]::text[], NULL, 'lc_probe', 'operational', true, false)`);
  return owner;
}

async function teardownProbe(prisma) {
  // Сперва правило (иначе событийный триггер примет листья пробы за защищённые), потом схема
  await prisma.$executeRawUnsafe(`DELETE FROM lifecycle_partition_specs WHERE parent = '${PARENT}'`).catch(() => undefined);
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS lc_probe CASCADE').catch((e) => console.log('teardown:', errText(e)));
}

async function main() {
  const prisma = new PrismaClient();
  const solo = singleConnectionClient();
  let probeReady = false;
  try {
    const now = new Date();
    const cur = monthStart(now.getUTCFullYear(), now.getUTCMonth());
    const old = monthStart(now.getUTCFullYear(), now.getUTCMonth() - 4);
    const older = monthStart(now.getUTCFullYear(), now.getUTCMonth() - 5);
    const oldest = monthStart(now.getUTCFullYear(), now.getUTCMonth() - 6);

    // ============================================================
    console.log('\n-- 1. создание листа: ATTACH без ACCESS EXCLUSIVE, идемпотентность, владелец --');
    const ownerRole = await setupProbe(prisma);
    probeReady = true;
    const locks = await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT lifecycle_ensure_partition($1, $2::timestamptz)`, PARENT, cur.toISOString());
      return tx.$queryRawUnsafe(`SELECT mode FROM pg_locks WHERE relation = 'lc_probe.events'::regclass AND pid = pg_backend_pid()`);
    });
    const modes = locks.map((l) => l.mode);
    check('ATTACH держит на родителе не сильнее SHARE UPDATE EXCLUSIVE', !modes.includes('AccessExclusiveLock') && modes.includes('ShareUpdateExclusiveLock'), modes.join(','));
    // Живая вставка в родителя (ROW EXCLUSIVE в открытой транзакции) не мешает завести следующий месяц
    const next = monthStart(now.getUTCFullYear(), now.getUTCMonth() + 1);
    let attachedWhileWriting = null;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO lc_probe.events (at, note) VALUES ($1::timestamptz, 'writer')`, cur.toISOString());
      const t0 = Date.now();
      attachedWhileWriting = await failsWith(() => solo.$queryRawUnsafe(`SELECT lifecycle_ensure_partition($1, $2::timestamptz)`, PARENT, next.toISOString()));
      attachedWhileWriting = attachedWhileWriting ?? `ok ${Date.now() - t0}ms`;
      throw new Error('rollback-writer');
    }).catch((e) => { if (!String(e.message).includes('rollback-writer')) throw e; });
    check('лист следующего месяца заводится, пока идёт вставка в родителя', /^ok /.test(attachedWhileWriting), attachedWhileWriting);
    const again = await prisma.$queryRawUnsafe(`SELECT lifecycle_ensure_partition($1, $2::timestamptz) AS leaf`, PARENT, new Date(cur.getTime() + 5 * 86_400_000).toISOString());
    check('повторное создание того же месяца идемпотентно', again[0]?.leaf === leafOf(cur), again[0]?.leaf);
    const leafOwner = await prisma.$queryRawUnsafe(`SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'lc_probe.${leafOf(cur)}'::regclass`);
    check('лист принадлежит владельцу данных', !ownerRole || leafOwner[0]?.owner === 'sa6_data_owner', leafOwner[0]?.owner);
    const comp = await prisma.$queryRawUnsafe(`SELECT attcompression AS c FROM pg_attribute WHERE attrelid = 'lc_probe.${leafOf(cur)}'::regclass AND attname = 'note'`);
    check('колонка из правила получила lz4 на листе', comp[0]?.c === 'l', comp[0]?.c);
    const bounds = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'lc_probe.${leafOf(cur)}'::regclass AND conname LIKE '%_bounds'`);
    check('временный CHECK границ снят после ATTACH', bounds[0]?.n === 0, bounds[0]?.n);

    // ============================================================
    console.log('\n-- 2. DEFAULT-партиция запрещена --');
    await prisma.$executeRawUnsafe('CREATE TABLE lc_probe.events_default PARTITION OF lc_probe.events DEFAULT');
    const withDefault = await failsWith(() => prisma.$queryRawUnsafe(`SELECT lifecycle_ensure_partition($1, $2::timestamptz)`, PARENT, monthStart(now.getUTCFullYear(), now.getUTCMonth() + 2).toISOString()));
    check('при DEFAULT-партиции создание отказывает', !!withDefault && /DEFAULT partition/.test(withDefault), withDefault);
    await prisma.$executeRawUnsafe('DROP TABLE lc_probe.events_default');

    // ============================================================
    console.log('\n-- 3. пол срока: свежий лист не сбрасывается, старый — сбрасывается --');
    const fresh = await failsWith(() => prisma.$queryRawUnsafe(`SELECT lifecycle_drop_partition($1, $2)`, PARENT, leafOf(cur)));
    check('лист текущего месяца моложе пола — отказ', !!fresh && /younger than the 30 day floor/.test(fresh), fresh);
    await prisma.$queryRawUnsafe(`SELECT lifecycle_ensure_partition($1, $2::timestamptz)`, PARENT, oldest.toISOString());
    const droppedOld = await prisma.$queryRawUnsafe(`SELECT lifecycle_drop_partition($1, $2) AS d`, PARENT, leafOf(oldest));
    const goneOld = await prisma.$queryRawUnsafe(`SELECT to_regclass('lc_probe.${leafOf(oldest)}')::text AS r`);
    check('лист старше пола сброшен функцией владельца', droppedOld[0]?.d === true && goneOld[0]?.r === null, JSON.stringify(droppedOld[0]));
    const alien = await failsWith(() => prisma.$queryRawUnsafe(`SELECT lifecycle_drop_partition($1, $2)`, PARENT, 'users'));
    check('чужое имя (не лист родителя) — отказ', !!alien && /not a partition name/.test(alien), alien);
    const unregistered = await failsWith(() => prisma.$queryRawUnsafe(`SELECT lifecycle_drop_partition($1, $2)`, 'public.users', 'users_2020_01'));
    check('незарегистрированный родитель — отказ', !!unregistered && /not a registered partitioned parent/.test(unregistered), unregistered);

    // ============================================================
    console.log('\n-- 4. «detach pending» доводится FINALIZE --');
    await prisma.$queryRawUnsafe(`SELECT lifecycle_ensure_partition($1, $2::timestamptz)`, PARENT, older.toISOString());
    // Держатель старого снимка — пока он жив, вторая фаза DETACH CONCURRENTLY ждёт и обрывается таймаутом
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT count(*) FROM lc_probe.events');
      await sleep(4000);
    }, { isolationLevel: 'RepeatableRead', timeout: 15_000 });
    await sleep(500);
    // Своими руками (суперпользователь dev) — это и есть «оборванный DETACH» прошлых хелперов
    await solo.$executeRawUnsafe(`SET statement_timeout = '1500ms'`);
    const detachErr = await failsWith(() => solo.$executeRawUnsafe(`ALTER TABLE lc_probe.events DETACH PARTITION lc_probe.${leafOf(older)} CONCURRENTLY`));
    await solo.$executeRawUnsafe(`SET statement_timeout = 0`);
    await holder;
    const pending = await prisma.$queryRawUnsafe(`SELECT inhdetachpending AS p FROM pg_inherits WHERE inhrelid = 'lc_probe.${leafOf(older)}'::regclass`);
    check('подготовка: лист завис в «detach pending»', pending[0]?.p === true, `${detachErr ?? 'detach finished'}; pending=${pending[0]?.p}`);
    const finalized = await failsWith(() => prisma.$queryRawUnsafe(`SELECT lifecycle_drop_partition($1, $2)`, PARENT, leafOf(older)));
    const goneOlder = await prisma.$queryRawUnsafe(`SELECT to_regclass('lc_probe.${leafOf(older)}')::text AS r`);
    check('функция сброса довела FINALIZE и сбросила лист', finalized === null && goneOlder[0]?.r === null, finalized ?? '');

    // ============================================================
    console.log('\n-- 5. заморозка держит сброс (всё — в откатываемой транзакции) --');
    await prisma.$queryRawUnsafe(`SELECT lifecycle_ensure_partition($1, $2::timestamptz)`, PARENT, old.toISOString());
    const actor = SUITE.p1; // только маркер в заметке; id актора — случайный uuid
    const holdResults = await prisma.$transaction(async (tx) => {
      const out = {};
      const tryDrop = async (name) => {
        await tx.$executeRawUnsafe(`SAVEPOINT s_${name}`);
        const e = await failsWith(() => tx.$queryRawUnsafe(`SELECT lifecycle_drop_partition($1, $2)`, PARENT, leafOf(old)));
        await tx.$executeRawUnsafe(e ? `ROLLBACK TO SAVEPOINT s_${name}` : `RELEASE SAVEPOINT s_${name}`);
        out[name] = e;
      };
      const platformHold = (await tx.$queryRawUnsafe(`INSERT INTO lifecycle_holds (scope, data_class, reason_code, note, created_by_id, created_by_kind)
          VALUES ('class', 'operational', 'suite_probe', $1, gen_random_uuid(), 'platform_staff') RETURNING id`, `verify-partitions ${actor}`))[0].id;
      await tryDrop('platform');
      await tx.$executeRawUnsafe(`UPDATE lifecycle_holds SET released_at = now(), released_by_id = gen_random_uuid() WHERE id = $1::uuid`, platformHold);
      const wsHold = (await tx.$queryRawUnsafe(`INSERT INTO lifecycle_holds (scope, workspace_id, data_class, reason_code, created_by_id)
          VALUES ('class', gen_random_uuid(), 'operational', 'suite_probe', gen_random_uuid()) RETURNING id`))[0].id;
      await tryDrop('workspace');
      await tx.$executeRawUnsafe(`INSERT INTO lifecycle_hold_extractions (hold_id, partition, rows) VALUES ($1::uuid, $2, 0)`, wsHold, `lc_probe.${leafOf(old)}`);
      await tryDrop('extracted');
      const tamper = await failsWith(async () => {
        await tx.$executeRawUnsafe('SAVEPOINT s_tamper');
        try {
          await tx.$executeRawUnsafe(`UPDATE lifecycle_holds SET reason_code = 'x' WHERE id = $1::uuid`, wsHold);
        } finally {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT s_tamper');
        }
      });
      out.tamper = tamper;
      throw Object.assign(new Error('rollback-holds'), { out });
    }, { timeout: 30_000 }).catch((e) => {
      if (e.message !== 'rollback-holds') throw e;
      return e.out;
    });
    check('заморозка класса на всю платформу держит сброс', !!holdResults.platform && /under legal hold/.test(holdResults.platform), holdResults.platform);
    check('заморозка организации держит сброс до отметки извлечения', !!holdResults.workspace && /under legal hold/.test(holdResults.workspace), holdResults.workspace);
    check('после отметки «строки извлечены» сброс проходит', holdResults.extracted === null, holdResults.extracted ?? '');
    check('заморозку нельзя переписать (кроме снятия)', !!holdResults.tamper && /only the release fields/.test(holdResults.tamper), holdResults.tamper);
    const leftHolds = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM lifecycle_holds WHERE reason_code = 'suite_probe'`);
    check('пробные заморозки откатились вместе с транзакцией', leftHolds[0]?.n === 0, leftHolds[0]?.n);
    const oldStill = await prisma.$queryRawUnsafe(`SELECT to_regclass('lc_probe.${leafOf(old)}')::text AS r`);
    check('откат транзакции вернул и лист (DDL транзакционен)', oldStill[0]?.r !== null);

    // ============================================================
    console.log('\n-- 6. очередь: необработанная строка держит сброс --');
    await prisma.$executeRawUnsafe(`UPDATE lifecycle_partition_specs SET hold_aware = false, require_processed = true WHERE parent = '${PARENT}'`);
    const queue = await prisma.$transaction(async (tx) => {
      const out = {};
      await tx.$executeRawUnsafe(`INSERT INTO lc_probe.events (at, note) VALUES ($1::timestamptz, 'unprocessed')`, new Date(old.getTime() + 86_400_000).toISOString());
      await tx.$executeRawUnsafe('SAVEPOINT s_q');
      out.unprocessed = await failsWith(() => tx.$queryRawUnsafe(`SELECT lifecycle_drop_partition($1, $2)`, PARENT, leafOf(old)));
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT s_q');
      await tx.$executeRawUnsafe(`UPDATE lc_probe.events SET processed_at = now() WHERE note = 'unprocessed'`);
      out.processed = await failsWith(() => tx.$queryRawUnsafe(`SELECT lifecycle_drop_partition($1, $2)`, PARENT, leafOf(old)));
      throw Object.assign(new Error('rollback-queue'), { out });
    }, { timeout: 30_000 }).catch((e) => {
      if (e.message !== 'rollback-queue') throw e;
      return e.out;
    });
    check('лист с необработанной строкой очереди не сбрасывается', !!queue.unprocessed && /unprocessed rows/.test(queue.unprocessed), queue.unprocessed);
    check('когда всё обработано — сбрасывается', queue.processed === null, queue.processed ?? '');

    // ============================================================
    console.log('\n-- 7. событийный триггер: DROP защищённого — только роли владельца --');
    const guard = await prisma.$queryRawUnsafe(`SELECT evtenabled AS e FROM pg_event_trigger WHERE evtname = 'lifecycle_guard_drop'`);
    if (!guard.length) {
      console.log('  (db-roles.sql не применён — событийного триггера нет, проверки пропущены)');
    } else {
      const direct = await inRollback(prisma, `DROP TABLE lc_probe.${leafOf(old)}`);
      check('DROP листа зарегистрированного родителя мимо функции — отказ', !!direct && /protected table/.test(direct), direct);
      const col = await inRollback(prisma, 'ALTER TABLE lifecycle_holds DROP COLUMN note');
      check('DROP COLUMN защищённой таблицы — отказ', !!col && /protected table/.test(col), col);
      const asOwner = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE sa6_data_owner');
        await tx.$executeRawUnsafe(`ALTER TABLE lc_probe.events DETACH PARTITION lc_probe.${leafOf(old)}`);
        await tx.$executeRawUnsafe(`DROP TABLE lc_probe.${leafOf(old)}`);
        throw new Error('rollback-owner');
      }).then(() => null, (e) => (e.message === 'rollback-owner' ? null : errText(e)));
      check('осознанный DROP от роли владельца проходит', asOwner === null, asOwner ?? '');
    }

    // ============================================================
    console.log('\n-- 8. append-only: деньги, история, заморозки --');
    const ledgerRows = (await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM ledger_transfers'))[0].n;
    const ledger = await inRollback(prisma, 'UPDATE ledger_transfers SET memo = memo WHERE id = (SELECT min(id) FROM ledger_transfers)');
    check('проводку леджера изменить нельзя', ledgerRows === 0 || (!!ledger && /append-only/.test(ledger)), ledger ?? `rows=${ledgerRows}`);
    const ledgerDel = await inRollback(prisma, 'DELETE FROM ledger_transfers WHERE id = (SELECT min(id) FROM ledger_transfers)');
    check('проводку леджера удалить нельзя', ledgerRows === 0 || (!!ledgerDel && /append-only/.test(ledgerDel)), ledgerDel ?? `rows=${ledgerRows}`);
    const ledgerTrunc = await inRollback(prisma, 'TRUNCATE ledger_transfers');
    check('леджер не TRUNCATE-ится', !!ledgerTrunc && /truncate is forbidden/.test(ledgerTrunc), ledgerTrunc);
    const escrowDel = await inRollback(prisma, 'DELETE FROM escrow_agreements WHERE id = (SELECT id FROM escrow_agreements LIMIT 1)');
    const escrowCount = await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM escrow_agreements');
    check('договор эскроу удалить нельзя', escrowCount[0].n === 0 || (!!escrowDel && /delete is forbidden/.test(escrowDel)), escrowDel ?? `rows=${escrowCount[0].n}`);
    const holdsTrunc = await inRollback(prisma, 'TRUNCATE lifecycle_holds');
    check('журнал заморозок не TRUNCATE-ится', !!holdsTrunc && /truncate is forbidden/.test(holdsTrunc), holdsTrunc);
    const journalTrunc = await inRollback(prisma, 'TRUNCATE lifecycle_erasure_journal');
    check('журнал стираний не TRUNCATE-ится', !!journalTrunc && /truncate is forbidden/.test(journalTrunc), journalTrunc);

    // ============================================================
    console.log('\n-- 9. реальные родители: вперёд, DEFAULT, зависшие detach, правила = реестр --');
    const specs = await prisma.$queryRawUnsafe(`SELECT parent, floor_days, data_class, hold_aware, policy_id, period FROM lifecycle_partition_specs WHERE parent <> '${PARENT}' ORDER BY parent`);
    for (const s of specs) {
      const [schema, table] = s.parent.split('.');
      const rows = await prisma.$queryRawUnsafe(
        `SELECT c.relname AS name, i.inhdetachpending AS pending FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent JOIN pg_namespace n ON n.oid = p.relnamespace
         WHERE n.nspname = $1 AND p.relname = $2`, schema, table);
      const start = s.period === 'day' ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) : cur;
      const ahead = rows.filter((r) => {
        const m = /_(\d{4})_(\d{2})(?:_(\d{2}))?$/.exec(r.name);
        if (!m) return false;
        const from = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1));
        return from >= start;
      }).length;
      const def = await prisma.$queryRawUnsafe(
        `SELECT pt.partdefid <> 0 AS d FROM pg_partitioned_table pt JOIN pg_class p ON p.oid = pt.partrelid JOIN pg_namespace n ON n.oid = p.relnamespace WHERE n.nspname = $1 AND p.relname = $2`, schema, table);
      const pol = LIFECYCLE_POLICIES[s.policy_id];
      const floor = typeof pol?.retention.floorDays === 'number' ? pol.retention.floorDays : 0;
      check(`${s.parent}: листов от текущего периода ≥ 3, DEFAULT нет, зависших detach нет`, ahead >= 3 && def[0]?.d === false && rows.every((r) => !r.pending), `ahead=${ahead}`);
      check(`${s.parent}: правило = реестр (${s.policy_id}: класс, hold, пол ≥ закона)`, !!pol && pol.dataClass === s.data_class && pol.holdAware === s.hold_aware && s.floor_days >= floor, pol ? `${s.data_class}/${s.hold_aware}/${s.floor_days} vs ${pol.dataClass}/${pol.holdAware}/${floor}` : 'нет политики');
    }
    const dropPolicies = LIFECYCLE_POLICY_IDS.filter((id) => LIFECYCLE_POLICIES[id].enforcement.kind === 'drop_partition' && id !== 'SecurityEvent');
    const specPolicies = new Set(specs.map((s) => s.policy_id));
    check('каждая политика drop_partition имеет правило родителя (security_events — у core/audit)', dropPolicies.every((id) => specPolicies.has(id)), dropPolicies.filter((id) => !specPolicies.has(id)).join(', '));

    // ============================================================
    console.log('\n-- 10. доставки: время строки = время события / время id --');
    const nd = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id WHERE d.created_at <> e.created_at`);
    check('у доставок уведомлений created_at = момент события (уникум между месяцами)', nd[0].n === 0, nd[0].n);
    const wd = await prisma.$queryRawUnsafe(`SELECT id::text AS id, created_at AS at FROM webhook_deliveries ORDER BY created_at DESC LIMIT 200`);
    const v7 = wd.filter((r) => uuidVersion(r.id) === 7);
    const drift = v7.filter((r) => Math.abs(uuidv7Time(r.id).getTime() - new Date(r.at).getTime()) > 3_600_000);
    check('у доставок вебхуков created_at в окне подсказки времени id (±1 ч)', drift.length === 0, `${v7.length} v7, drift ${drift.length}`);

    // ============================================================
    console.log('\n-- 11. дев-ручка движка --');
    const s1 = await login(SUITE.p1);
    const h = await call('GET', '/lifecycle/dev/partitions', s1.token);
    const probeHealth = h.json?.data?.find?.((x) => x.parent === PARENT);
    check('здоровье отвечает по всем родителям (+ security_events)', h.ok && h.json.data.some((x) => x.parent === 'public.security_events') && h.json.data.some((x) => x.parent === 'public.notification_deliveries'), h.status);
    check('проба видна в здоровье (правило из БД, не из кода)', !!probeHealth, JSON.stringify(probeHealth ?? null));
    const m = await call('POST', '/lifecycle/dev/partitions/maintain', s1.token, {});
    check('ночное обслуживание по запросу проходит', m.ok && Array.isArray(m.json?.data?.health), `${m.status} ${m.code ?? ''}`);
  } finally {
    if (probeReady) await teardownProbe(prisma);
    await solo.$disconnect().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
  await finish();
}

main().catch(crash);
