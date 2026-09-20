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
// Публикует только документы БЕЗ единой опубликованной версии. Живой документ скрипт
// не трогает никогда — ни первым, ни вторым запуском.
//
// Тексты берутся из `apps/api/consents-texts/<документ>.<язык>.md` — их засевает
// `ConsentsSeedService` черновиком версии 1. Правки юриста обязаны быть в этих файлах
// ДО запуска: опубликуется ровно то, что в них лежит.
//
//   node apps/api/scripts/consents-publish-initial.cjs             # план, ничего не меняет
//   node apps/api/scripts/consents-publish-initial.cjs --publish   # публикация
//
// Порядок запуска платформы:
//   1) этот скрипт          2) обычная регистрация своего аккаунта с галочками
//   3) platform-bootstrap-owner.cjs +7XXXXXXXXXX     4) вход в Кабинет
//
// Требует собранного `dist` (`npx nest build`): публикация идёт через сам движок —
// хэши, цепочка манифестов, подпись платформы, триггеры неизменяемости.
// ============================================================
const fs = require('fs');
const path = require('path');

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

async function main() {
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require(path.join(DIST, 'app.module.js'));
  const { DatabaseService } = require(path.join(DIST, 'shared/database/database.service.js'));
  const { ConsentsDocumentsService } = require(path.join(DIST, 'core/consents/consents.documents.service.js'));
  const { ConsentsSeedService } = require(path.join(DIST, 'core/consents/consents.seed.service.js'));
  const { CONSENT_TEXT_DOCUMENT_KEYS, CONSENT_BUNDLES } = require('@superapp/shared');

  // Контекст без HTTP: нужен контейнер (движок ключей для подписи, jobs, i18n), не сервер
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  let code = 0;
  try {
    const db = app.get(DatabaseService);
    const documents = app.get(ConsentsDocumentsService);

    // Скрипт запирает сам себя: есть люди — значит Кабинет достижим, и публикация идёт туда
    const people = await db.user.count({ where: { kind: 'person', deletedAt: null } });
    if (people > 0) {
      console.error(`refused: the platform already has ${people} registered ${people === 1 ? 'person' : 'people'} — publish from the platform console (consents.document.publish)`);
      return 1;
    }

    // Черновики версии 1 из файлов (идемпотентно: документ с версиями не трогается)
    await app.get(ConsentsSeedService).ensure();

    const rows = await db.consentVersion.findMany({
      select: { documentKey: true, version: true, status: true },
      orderBy: [{ documentKey: 'asc' }, { version: 'asc' }],
    });
    const drafts = new Set(rows.filter((r) => r.status === 'draft').map((r) => r.documentKey));
    const live = new Set(rows.filter((r) => r.status !== 'draft').map((r) => r.documentKey));

    const plan = [];
    console.log('\nДокументы:');
    for (const key of CONSENT_TEXT_DOCUMENT_KEYS) {
      if (live.has(key)) console.log(`  ${key.padEnd(20)} — уже опубликован, пропуск (новая версия — только из Кабинета)`);
      else if (drafts.has(key)) { plan.push(key); console.log(`  ${key.padEnd(20)} — черновик v1 → будет опубликован`); }
      else console.log(`  ${key.padEnd(20)} — ЧЕРНОВИКА НЕТ (нет файлов consents-texts/${key}.{kk,ru,en}.md)`);
    }

    // Пакеты, без которых действие закрыто: регистрация и создание организации
    const missing = [];
    for (const [bundleKey, def] of Object.entries(CONSENT_BUNDLES)) {
      for (const key of def.documents) if (!live.has(key) && !drafts.has(key)) missing.push(`${bundleKey} → ${key}`);
    }
    if (missing.length) {
      console.error(`\nrefused: mandatory documents of a bundle have neither a published version nor a draft: ${missing.join(', ')}`);
      return 1;
    }
    if (!plan.length) {
      console.log('\nПубликовать нечего — всё уже опубликовано.');
      return 0;
    }
    if (!PUBLISH) {
      console.log(`\nЭто план. Публикация: node apps/api/scripts/consents-publish-initial.cjs --publish`);
      return 0;
    }

    console.log('');
    for (const documentKey of plan) {
      // Первая версия документа вступает в силу сразу: заменять нечего, и принимать её
      // задним числом некому. Причина уезжает в `urgentReason` только у срочной публикации,
      // а первая версия срочной не бывает — поле остаётся пустым.
      const res = await db.$transaction((tx) =>
        documents.publish(tx, { userId: null, reason: 'initial launch publication (consents-publish-initial.cjs)' }, { documentKey }),
      );
      const row = await db.consentVersion.findUnique({ where: { id: res.versionId } });
      console.log(`${documentKey} v${res.version} — действует с ${res.effectiveFrom.toISOString()}`);
      console.log(`  manifest  ${res.manifestHash}`);
      console.log(`  подпись   kid ${row.signatureKid} · ${row.signedAt.toISOString()}`);
      for (const l of ['kk', 'ru', 'en']) console.log(`  sha256 ${l}  ${row.hashes[l]}`);
    }
    console.log('\nГотово. Сохраните вывод — это ваш экземпляр доказательства целостности опубликованных текстов.');
    console.log('Дальше: обычная регистрация своего аккаунта → platform-bootstrap-owner.cjs +7XXXXXXXXXX → вход в Кабинет.');
    console.log('Работающему API рестарт не нужен: микрокэш версий обновится за пару секунд.');
    return 0;
  } catch (err) {
    console.error(`failed: ${err && err.message ? err.message : err}`);
    code = 1;
  } finally {
    await app.close().catch(() => undefined);
  }
  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
