#!/usr/bin/env node
// ============================================================
// Генератор `src/messages/index.ts` — карта «локаль → неймспейс → каталог».
//
// Почему не читаем папку в рантайме: и Next (turbopack/webpack), и NestJS
// собирают код в бандл/dist, где `fs.readdir` по исходникам ничего не найдёт.
// Статические импорты JSON видит сборщик — файлы едут вместе с кодом.
//
// Почему НЕ ленивые `() => import(...)`: каталоги нужны СИНХРОННО (фильтр
// исключений API рендерит текст отказа прямо в обработчике ответа), а на клиент
// они и так не попадают — веб отдаёт в браузер только выбранные неймспейсы
// через NextIntlClientProvider. Ленивость здесь стоила бы асинхронности везде и
// не экономила бы ни байта.
//
// Запускается сам перед сборкой (`prebuild`) и вручную: `pnpm --filter @superapp/i18n gen`.
// ============================================================
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const MSG = path.join(SRC, 'messages');

/** SUPPORTED_LOCALES / NAMESPACES читаем из ИСТОЧНИКОВ, а не из dist: генератор
 *  работает до сборки (prebuild), когда dist ещё старый или отсутствует. */
function listFromSource(file, constName) {
  const text = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`);
  const m = re.exec(text);
  if (!m) throw new Error(`${constName} не найден в ${file}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const LOCALES = listFromSource(
  path.join(SRC, '..', '..', 'shared', 'src', 'constants', 'i18n.ts'),
  'SUPPORTED_LOCALES',
);
const NAMESPACES = listFromSource(path.join(SRC, 'namespaces.ts'), 'NAMESPACES');

const missing = [];
for (const locale of LOCALES) {
  for (const ns of NAMESPACES) {
    const file = path.join(MSG, locale, `${ns}.json`);
    if (!fs.existsSync(file)) missing.push(path.relative(SRC, file).replace(/\\/g, '/'));
  }
}
if (missing.length) {
  console.error('[i18n:gen] нет файлов каталогов:\n  ' + missing.join('\n  '));
  process.exit(1);
}

const lines = [];
lines.push('// СГЕНЕРИРОВАНО `pnpm --filter @superapp/i18n gen` — правки затрутся.');
lines.push('// Источник: src/messages/<locale>/<namespace>.json + src/namespaces.ts.');
lines.push("import type { Locale } from '@superapp/shared';");
lines.push("import type { Namespace } from '../namespaces';");
lines.push('');
for (const locale of LOCALES) {
  for (const ns of NAMESPACES) {
    lines.push(`import ${ident(locale, ns)} from './${locale}/${ns}.json';`);
  }
}
lines.push('');
lines.push('/** Дерево сообщений одного неймспейса (значения — ICU-строки). */');
lines.push('export type MessageTree = { [key: string]: string | MessageTree };');
lines.push('');
lines.push('export const MESSAGES: Record<Locale, Record<Namespace, MessageTree>> = {');
for (const locale of LOCALES) {
  lines.push(`  ${locale}: {`);
  for (const ns of NAMESPACES) {
    lines.push(`    ${JSON.stringify(ns)}: ${ident(locale, ns)},`);
  }
  lines.push('  },');
}
lines.push('};');
lines.push('');

function ident(locale, ns) {
  return `m_${locale}_${ns.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

const out = path.join(MSG, 'index.ts');
const next = lines.join('\n');
const prev = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
if (prev !== next) {
  fs.writeFileSync(out, next, 'utf8');
  console.log(`[i18n:gen] messages/index.ts обновлён (${LOCALES.length} локали × ${NAMESPACES.length} неймспейсов)`);
} else {
  console.log('[i18n:gen] messages/index.ts уже актуален');
}

// ---- Маркер томбстоуна стёртого человека (core/lifecycle) ----
// Имя стёртого в базе — метка `common.labels.deletedUser` на языке ИСТОЧНИКА. Лёгкий модуль
// с одной строкой (без каталогов) нужен вебу и рендеру хроники: подпуть `./person-marker`
// уходит в браузер, и тянуть за ним все каталоги нельзя.
const SOURCE_LOCALE = 'en';
const commonSource = JSON.parse(fs.readFileSync(path.join(MSG, SOURCE_LOCALE, 'common.json'), 'utf8'));
const marker = commonSource?.labels?.deletedUser;
if (typeof marker !== 'string' || !marker.trim()) throw new Error('common.labels.deletedUser отсутствует в каталоге-источнике');
const markerOut = path.join(SRC, 'person-marker.generated.ts');
const markerNext = [
  '// Сгенерировано scripts/gen-messages.cjs — не править руками.',
  '/** Маркер томбстоуна: имя стёртого человека в базе (`common.labels.deletedUser` языка-источника). */',
  `export const DELETED_USER_MARKER = ${JSON.stringify(marker)};`,
  '',
].join('\n');
if ((fs.existsSync(markerOut) ? fs.readFileSync(markerOut, 'utf8') : null) !== markerNext) {
  fs.writeFileSync(markerOut, markerNext, 'utf8');
  console.log('[i18n:gen] person-marker.generated.ts обновлён');
}
