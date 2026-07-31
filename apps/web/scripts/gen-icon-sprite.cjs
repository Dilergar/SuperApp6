#!/usr/bin/env node
// ============================================================
// Генератор SVG-спрайта интерфейсных иконок (Phosphor, ТОЛЬКО Light).
//
// Зачем: @phosphor-icons/react несёт в JS-бандле все 6 начертаний каждой
// иконки (defs-модуль = Map<weight, element>), хотя дизайн-система использует
// одно — Light. Это ~60–80 КБ gzip лишних в чанке кита НА КАЖДОЙ странице.
// Спрайт выносит рисунки в статический кэшируемый файл (public/icons/
// sprite.svg, immutable-заголовок в next.config.ts), а в бандле остаётся
// только <use href> — сам пакет из рантайма уходит совсем.
//
// Источник правды — src/components/ui/icons.manifest.json
// (семантический ключ → имя компонента Phosphor). Добавил иконку в манифест →
// перегенерируй спрайт:  pnpm --filter ./apps/web gen:icons
// Незнакомое имя валит скрипт с списком — молча пустых символов не бывает.
// ============================================================
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const manifest = require('../src/components/ui/icons.manifest.json');

async function main() {
// require() нельзя: у пакета "type": "module", и его index.cjs.js Node парсит
// как ESM («exports is not defined») — берём честный ESM через import()
const Ph = await import('@phosphor-icons/react');

const symbols = [];
const missing = [];
for (const [key, phName] of Object.entries(manifest)) {
  const Comp = Ph[phName];
  if (!Comp) {
    missing.push(`${key} -> ${phName}`);
    continue;
  }
  const svg = renderToStaticMarkup(
    React.createElement(Comp, { weight: 'light', size: 256, color: 'currentColor' }),
  );
  const m = svg.match(/^<svg[^>]*>([\s\S]*)<\/svg>$/);
  if (!m) {
    missing.push(`${key}: неожиданная разметка (${svg.slice(0, 60)}…)`);
    continue;
  }
  symbols.push(`<symbol id="${key}" viewBox="0 0 256 256">${m[1]}</symbol>`);
}

if (missing.length) {
  console.error('Иконки не найдены в @phosphor-icons/react:');
  for (const s of missing) console.error('  ' + s);
  process.exit(1);
}

const out = `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join('')}</svg>`;
// Контент-хэш в имени: /icons/* закрыт вечным immutable-кэшем (next.config.ts),
// и без хэша вернувшийся браузер держал бы СТАРЫЙ спрайт — новая иконка
// рисовалась бы пустотой. Имя меняется вместе с содержимым, константу URL
// пишет генератор — руками её не править.
const hash = require('node:crypto').createHash('sha1').update(out).digest('hex').slice(0, 8);
const dir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const f of fs.readdirSync(dir)) if (/^sprite\.[0-9a-f]{8}\.svg$/.test(f) || f === 'sprite.svg') fs.rmSync(path.join(dir, f));
const name = `sprite.${hash}.svg`;
fs.writeFileSync(path.join(dir, name), out);
const genTs = `// Сгенерировано scripts/gen-icon-sprite.cjs — НЕ править руками.\nexport const ICON_SPRITE_URL = '/icons/${name}';\n`;
fs.writeFileSync(path.join(__dirname, '..', 'src', 'components', 'ui', 'icon-sprite.generated.ts'), genTs);
console.log(`${name}: ${symbols.length} символов, ${(out.length / 1024).toFixed(1)} КБ`);
}

main().catch((e) => { console.error(e); process.exit(1); });
