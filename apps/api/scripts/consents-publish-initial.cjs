/* eslint-disable */
// ============================================================
// Публикация юридических документов ПРИ ПЕРВОМ ЗАПУСКЕ платформы (core/consents).
//
// Зачем скрипт вообще существует. На чистой боевой базе замкнутый круг: регистрация
// закрыта, пока обязательные документы не опубликованы (fail-closed, согласие задним
// числом не появляется) → живого аккаунта нет → владельца Кабинета нет → публиковать
// некому. Скрипт разрывает круг ровно один раз и сам себя запирает: он отказывается
// работать, как только на платформе появился хотя бы один человек — дальше Кабинет
// достижим, и любая новая версия идёт ТОЛЬКО оттуда (дата вступления, уведомления,
// баннер, «четыре глаза», step-up, журнал).
//
// Свойства, на которых держится доверие к скрипту:
//  - публикует только документы БЕЗ единой опубликованной версии — живой документ не
//    трогает никогда, ни первым, ни сотым запуском;
//  - ПРАВДА — ФАЙЛЫ `apps/api/consents-texts/<документ>.<язык>.md`. Засев создаёт черновик
//    только документу без версий, поэтому файл, поправленный после первого старта API,
//    в базу сам не попадает: скрипт сверяет черновик с файлами и перед публикацией
//    переписывает его из файлов (до первого человека Кабинета нет — править черновик
//    больше некому, расхождение бывает только «файлы новее»);
//  - всё публикуется ОДНОЙ транзакцией: сбой посередине не оставляет платформу
//    запущенной наполовину (регистрация открыта, условия для организаций — нет);
//  - публикация идёт движком, а не сырым SQL: хэши, цепочка манифестов, подпись
//    платформы, триггеры неизменяемости; в журнал Кабинета пишется строка на документ
//    (`consents.document.bootstrap_publish`, actorId = null — как у bootstrap владельца);
//  - без `--publish` скрипт только печатает план и ничего не меняет.
//
//   node apps/api/scripts/consents-publish-initial.cjs                      # план
//   node apps/api/scripts/consents-publish-initial.cjs --publish            # публикация
//   node apps/api/scripts/consents-publish-initial.cjs --publish --receipt=launch-receipt.json
//
// `--receipt` — копия распечатки хэшей в JSON (существующий файл не перезаписывается):
// экземпляр доказательства целостности опубликованных текстов ВНЕ базы.
//
// Порядок запуска платформы:
//   1) этот скрипт          2) обычная регистрация своего аккаунта с галочками
//   3) platform-bootstrap-owner.cjs +7XXXXXXXXXX     4) вход в Кабинет
//
// Требует собранного `dist` (`npx nest build`). Вывод — английский (текст для разработчика).
// ============================================================
const fs = require('fs');
const path = require('path');

// Место запуска скрипта: относительный путь `--receipt` человек пишет от НЕГО, а не от apps/api
const INVOKED_FROM = process.cwd();

// Рабочая папка — apps/api, как у самого API. Путь корневого ключа движка ключей по
// умолчанию ОТНОСИТЕЛЬНЫЙ (`.keys/`), и запуск из корня репозитория подхватил бы чужой
// корень: бут падает на «key versions are wrapped by another root». То же и с папкой
// текстов. Скрипт обязан вести себя одинаково из любого места.
process.chdir(path.join(__dirname, '..'));

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const DIST = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(path.join(DIST, 'app.module.js'))) {
  console.error('refused: dist is not built — run `npx nest build` in apps/api first');
  process.exit(2);
}

const PUBLISH = process.argv.includes('--publish');
const receiptArg = process.argv.find((a) => a.startsWith('--receipt='));
const RECEIPT = receiptArg ? path.resolve(INVOKED_FROM, receiptArg.slice('--receipt='.length)) : null;
const unknown = process.argv.slice(2).filter((a) => a !== '--publish' && !a.startsWith('--receipt='));
if (unknown.length) {
  console.error(`usage: node apps/api/scripts/consents-publish-initial.cjs [--publish] [--receipt=<file.json>]   (unknown: ${unknown.join(' ')})`);
  process.exit(2);
}
if (RECEIPT && !PUBLISH) {
  console.error('refused: --receipt makes sense only with --publish');
  process.exit(2);
}
if (RECEIPT) {
  // Проверки ДО публикации: узнать после необратимого шага, что распечатку некуда сохранить, — поздно
  if (fs.existsSync(RECEIPT)) {
    console.error(`refused: ${RECEIPT} already exists — a launch receipt is never overwritten`);
    process.exit(2);
  }
  try {
    fs.accessSync(path.dirname(RECEIPT), fs.constants.W_OK);
  } catch {
    console.error(`refused: the directory of ${RECEIPT} does not exist or is not writable`);
    process.exit(2);
  }
}

const AUDIT_COMMAND = 'consents.document.bootstrap_publish';
const REASON = 'initial launch publication (consents-publish-initial.cjs)';

// Транзакция запуска закоммичена: с этого момента любой сбой — уже НЕ «ничего не опубликовано»
let committed = false;

const sameTexts = (a, b, locales) => locales.every((l) => (a?.[l] ?? '') === (b?.[l] ?? ''));

async function main() {
  // Fail-fast на сломанном окружении — как `main.ts`: полу-рабочий бут хуже отказа
  require(path.join(DIST, 'shared/config/env.validation.js')).validateEnv();

  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require(path.join(DIST, 'app.module.js'));
  const { DatabaseService } = require(path.join(DIST, 'shared/database/database.service.js'));
  const { ConsentsDocumentsService } = require(path.join(DIST, 'core/consents/consents.documents.service.js'));
  const { ConsentsSeedService } = require(path.join(DIST, 'core/consents/consents.seed.service.js'));
  const { AuditService } = require(path.join(DIST, 'core/audit/audit.service.js'));
  const { CONSENT_TEXT_DOCUMENT_KEYS, CONSENT_BUNDLES, SUPPORTED_LOCALES } = require('@superapp/shared');

  // Контекст без HTTP: нужен контейнер (движок ключей для подписи, jobs, i18n), не сервер.
  // Ошибки бута остаются видимыми: в production они говорят о сломанной среде.
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const db = app.get(DatabaseService);
    const documents = app.get(ConsentsDocumentsService);
    const seed = app.get(ConsentsSeedService);
    const audit = app.get(AuditService);

    // Скрипт запирает сам себя. Считаются ВСЕ люди, включая удалённых: был хоть один человек —
    // значит Кабинет был достижим, и публикация мимо него уже ничем не оправдана.
    const people = await db.user.count({ where: { kind: 'person' } });
    if (people > 0) {
      console.error(`refused: the platform already has ${people} registered ${people === 1 ? 'person' : 'people'} — publish from the platform console (consents.document.publish)`);
      return 1;
    }

    // Черновики версии 1 документам без версий (идемпотентно). Явный вызов: в production
    // ошибка засева на буте только логируется, а здесь она обязана остановить запуск.
    await seed.ensure();

    const rows = await db.consentVersion.findMany({
      select: { documentKey: true, status: true, bodies: true, summaries: true },
      orderBy: [{ documentKey: 'asc' }, { version: 'asc' }],
    });
    const live = new Set(rows.filter((r) => r.status !== 'draft').map((r) => r.documentKey));
    const draftOf = new Map(rows.filter((r) => r.status === 'draft').map((r) => [r.documentKey, r]));

    const plan = [];
    const problems = [];
    console.log('\nDocuments:');
    for (const key of CONSENT_TEXT_DOCUMENT_KEYS) {
      const label = key.padEnd(20);
      if (live.has(key)) {
        console.log(`  ${label} already published — skipped (a new version goes through the console only)`);
        continue;
      }
      const source = seed.sourceTexts(key);
      if (!source) {
        // Файлы — правда: без них не с чем сверить черновик, публиковать «что нашлось в базе» нельзя
        problems.push(key);
        console.log(`  ${label} NO SOURCE FILES (consents-texts/${key}.{${SUPPORTED_LOCALES.join(',')}}.md)`);
        continue;
      }
      const draft = draftOf.get(key);
      const stale = !draft || !sameTexts(draft.bodies, source.bodies, SUPPORTED_LOCALES) || !sameTexts(draft.summaries, source.summaries, SUPPORTED_LOCALES);
      plan.push({ key, source, stale });
      const sizes = SUPPORTED_LOCALES.map((l) => `${l} ${source.bodies[l].length}`).join(' · ');
      console.log(`  ${label} v1 to publish — body chars: ${sizes}${stale ? '   [the draft in the database differs from the files — it will be rewritten from the files]' : ''}`);
    }

    // Пакеты, без которых действие закрыто (регистрация, создание организации): платформа
    // не запускается наполовину
    const missing = [];
    for (const [bundleKey, def] of Object.entries(CONSENT_BUNDLES)) {
      for (const key of def.documents) if (!live.has(key) && !plan.some((p) => p.key === key)) missing.push(`${bundleKey} → ${key}`);
    }
    if (problems.length || missing.length) {
      console.error(`\nrefused: ${[problems.length ? `no source files: ${problems.join(', ')}` : '', missing.length ? `mandatory bundle documents cannot be published: ${missing.join(', ')}` : ''].filter(Boolean).join('; ')}`);
      return 1;
    }
    if (!plan.length) {
      console.log('\nNothing to publish — every document already has a published version.');
      return 0;
    }
    if (!PUBLISH) {
      console.log('\nThis is the plan; nothing was changed. To publish: node apps/api/scripts/consents-publish-initial.cjs --publish');
      return 0;
    }

    // ОДНА транзакция на весь пакет запуска. Подпись внутри — локальная операция движка ключей;
    // потолок времени с запасом: дефолтные 5 секунд Prisma для девяти документов — впритык.
    const published = await db.$transaction(
      async (tx) => {
        // Человек не мог появиться (регистрация закрыта до коммита), но страж дешёв, а шаг необратим
        if ((await tx.user.count({ where: { kind: 'person' } })) > 0) throw new Error('a person registered while the script was running — publish from the platform console');
        const out = [];
        for (const { key, source, stale } of plan) {
          if (stale) await documents.saveDraft(tx, null, { documentKey: key, bodies: source.bodies, summaries: source.summaries, material: true });
          // Первая версия вступает в силу сразу: заменять нечего, и принимать её задним числом некому
          const res = await documents.publish(tx, { userId: null, reason: REASON }, { documentKey: key });
          // След в журнале безопасности (core/audit): команда Кабинета от имени системы, клиент — скрипт
          await audit.record(tx, {
            key: 'platform.command.executed',
            op: AUDIT_COMMAND,
            actor: { kind: 'system' },
            ctx: { client: 'script' },
            target: { type: 'consent_document', id: key },
            details: {
              version: 1,
              input: { documentKey: key, draftRewrittenFromFiles: stale },
              before: null,
              after: { version: res.version, effectiveFrom: res.effectiveFrom.toISOString(), manifestHash: res.manifestHash },
              readOnly: false,
              risk: 'critical',
              reason: REASON,
              dryRun: false,
              durationMs: 0,
            },
          });
          out.push(res);
        }
        return out;
      },
      { timeout: 120_000, maxWait: 15_000 },
    );
    committed = true;

    const receipt = [];
    console.log('');
    for (const res of published) {
      // Чтение ЧЕРЕЗ проверку целостности: распечатка выдаётся только за то, что движок сам признаёт подлинным
      const row = await documents.loadVerified(res.versionId);
      const entry = {
        documentKey: row.documentKey,
        version: row.version,
        effectiveFrom: row.effectiveFrom.toISOString(),
        manifestHash: row.manifestHash,
        prevManifestHash: row.prevManifestHash,
        signatureKid: row.signatureKid,
        signedAt: row.signedAt.toISOString(),
        contentSha256: Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l, row.hashes[l]])),
      };
      receipt.push(entry);
      console.log(`${entry.documentKey} v${entry.version} — in force since ${entry.effectiveFrom}`);
      console.log(`  manifest   ${entry.manifestHash}`);
      console.log(`  signature  kid ${entry.signatureKid} · ${entry.signedAt}`);
      for (const l of SUPPORTED_LOCALES) console.log(`  sha256 ${l}  ${entry.contentSha256[l]}`);
    }
    if (RECEIPT) {
      // `wx`: существующий файл не перезаписывается даже гонкой двух запусков
      fs.writeFileSync(RECEIPT, JSON.stringify({ publishedAt: new Date().toISOString(), tool: 'consents-publish-initial.cjs', documents: receipt }, null, 2) + '\n', { flag: 'wx' });
      console.log(`\nReceipt written: ${RECEIPT}`);
    }
    console.log('\nDone. Keep this output: it is your copy of the integrity proof of the published texts.');
    console.log('Next: register your own account the usual way → platform-bootstrap-owner.cjs +7XXXXXXXXXX → sign in to the console.');
    console.log('A running API needs no restart: the version micro-cache refreshes within seconds.');
    return 0;
  } finally {
    // Фоновые задачи бута (партиции, кроны) ещё могут идти — их ошибки «соединение закрыто»
    // при остановке контекста не несут смысла и не должны тонуть в распечатке хэшей
    app.useLogger(false);
    await app.close().catch(() => undefined);
  }
}

main()
  .then((code) => finish(code))
  .catch((err) => {
    // Сообщение Prisma многострочное и начинается с пустой строки — причина лежит в конце
    const text = String(err && err.message ? err.message : err).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join(' | ');
    console.error(
      committed
        ? `failed AFTER the publication: the documents ARE published, only the printout broke. Read the hashes from GET /api/v1/consents/documents/<key> — ${text.slice(0, 800)}`
        : `failed — nothing was published (the launch package is one transaction): ${text.slice(0, 800)}`,
    );
    finish(1);
  });

// Не `process.exit()` сразу: вывод в файл или конвейер на Windows асинхронный, и немедленный
// выход обрезал бы распечатку хэшей. Код выставляется, процесс завершается сам; таймер — страховка
// от зависшего дескриптора (он `unref`, поэтому сам процесс не держит).
function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 5000).unref();
}
