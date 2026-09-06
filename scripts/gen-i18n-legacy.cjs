#!/usr/bin/env node
'use strict';

// ============================================================
// Перезаписывает файлы-ратчеты `i18n.legacy.json` СПИСКОМ файлов, где правило
// `no-cyrillic-literal` сейчас срабатывает.
//
// Зачем отдельный скрипт: список обязан строиться ТЕМ ЖЕ правилом, что его
// проверяет. Собранный руками (или grep'ом) он немедленно разъезжается —
// комментарии, эмодзи и белые списки правило считает иначе, чем регулярка.
//
// Запускается ОДИН раз при заведении ратчета и потом — никогда: список только
// сокращается руками, по мере перевода. Ровно поэтому здесь есть защита от
// расширения: без `--allow-grow` скрипт откажется добавлять в список файлы,
// которых там не было.
// ============================================================

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PACKAGES = ['apps/web', 'apps/api', 'packages/shared', 'packages/i18n'];
const ALLOW_GROW = process.argv.includes('--allow-grow');

/**
 * Путь к самому ESLint. `eslint/bin/eslint.js` закрыт полем exports пакета,
 * поэтому идём от package.json — это работает на любой версии.
 */
function eslintBin(dir) {
  const pkgJson = require.resolve('eslint/package.json', { paths: [dir] });
  return path.join(path.dirname(pkgJson), 'bin', 'eslint.js');
}

let failed = false;

for (const pkg of PACKAGES) {
  const dir = path.join(ROOT, pkg);
  const legacyPath = path.join(dir, 'i18n.legacy.json');
  const prev = fs.existsSync(legacyPath)
    ? new Set((JSON.parse(fs.readFileSync(legacyPath, 'utf8')).files ?? []))
    : new Set();

  // Считаем с ПУСТЫМ списком: иначе правило само себя выключит на этих файлах.
  fs.writeFileSync(legacyPath, JSON.stringify({ files: [] }, null, 2) + '\n', 'utf8');

  let out = '';
  try {
    // ESLint зовём НАПРЯМУЮ через node: `npx.cmd` на Windows — .cmd-файл, и
    // execFileSync без shell отдаёт по нему EINVAL.
    out = execFileSync(
      process.execPath,
      [eslintBin(dir), 'src', '--format', 'json'],
      { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err) {
    // ESLint выходит с кодом 1, когда есть ошибки — это ожидаемо.
    out = err.stdout ?? '';
    if (!out) {
      console.error(`[i18n:legacy] ${pkg}: eslint не отдал отчёт`);
      console.error(err.stderr ?? err.message);
      process.exitCode = 1;
      continue;
    }
  }

  const report = JSON.parse(out);
  const files = report
    .filter((f) => f.messages.some((m) => m.ruleId === 'i18n/no-cyrillic-literal'))
    .map((f) => path.relative(dir, f.filePath).split(path.sep).join('/'))
    .sort();

  const added = files.filter((f) => !prev.has(f));
  if (added.length && !ALLOW_GROW && prev.size > 0) {
    console.error(
      `[i18n:legacy] ${pkg}: список ратчета РАСТЁТ (${added.length}). Он только сокращается — переведите файл, а не вписывайте его:\n  ` +
        added.join('\n  '),
    );
    // Возвращаем прежний список: расширять ратчет автоматом нельзя.
    fs.writeFileSync(legacyPath, JSON.stringify({ files: [...prev].sort() }, null, 2) + '\n', 'utf8');
    failed = true;
    continue;
  }

  fs.writeFileSync(legacyPath, JSON.stringify({ files }, null, 2) + '\n', 'utf8');
  console.log(`[i18n:legacy] ${pkg}: ${files.length} файлов ждут перевода`);
}

if (failed) process.exitCode = 1;
