// Генератор знака «№6»: одна геометрия → 9 SVG-файлов + JSON-пакет + витрина index.html
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });

// Палитра DESIGN.md (Organic Bento warm matte)
const P = { ink: '#1d1b1d', paper: '#eae6de', block: '#fafbf8', accent: '#588cd3', accentDim: '#3f6aa8', muted: '#6b655e' };

// ---------- Концепт A «Алты» — одна непрерывная линия, яблоко Алматы ----------
const A_TAIL = 'M74 16C60 6 38 12 33 34';
const A_LOOP = 'M33 34C30 42 26 52 26 62C26 78 36 89 50 89C64 89 74 78 74 64C74 52 68 40 61 39C53 38 43 50 32 44';
const A_PATH = 'M74 16C60 6 38 12 33 34C30 42 26 52 26 62C26 78 36 89 50 89C64 89 74 78 74 64C74 52 68 40 61 39C53 38 43 50 32 44';
const A_STROKE = 'fill="none" stroke="currentColor" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"';

// ---------- Концепт B «Совершенное число» — 1:2:3, шестиугольный просвет ----------
const B_BOWL = 'M80 65A30 30 0 1 1 20 65A30 30 0 1 1 80 65Z';
const B_TAIL = 'M20 65A60 60 0 0 1 80 5L80 20A45 45 0 0 0 35 65Z';
const B_HEX = 'M46.54 52L40.47 55.5Q37.01 57.5 37.01 61.5L37.01 68.5Q37.01 72.5 40.47 74.5L46.54 78Q50 80 53.46 78L59.53 74.5Q62.99 72.5 62.99 68.5L62.99 61.5Q62.99 57.5 59.53 55.5L53.46 52Q50 50 46.54 52Z';
const B_PATH = B_BOWL + B_TAIL + B_HEX;

// ---------- Концепт C «Плюс семь» — семёрка в шестёрке ----------
const C_RING = 'M82 66A32 32 0 1 1 18 66A32 32 0 1 1 82 66ZM68 66A18 18 0 1 0 32 66A18 18 0 1 0 68 66Z';
const C_SEVEN = 'M36.83 6H76.85L36.21 54.43L25.49 45.43L46.83 20H36.83Z';
const C_PATH = C_RING + C_SEVEN;

const svg = (vb, body, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" role="img"${extra}>${body}</svg>`;

const V = {
  a1: svg('0 0 100 100', `<path d="${A_PATH}" ${A_STROKE}/>`, ` color="${P.ink}" aria-label="№6 — Алты"`),
  a2: svg('0 0 100 100',
    `<ellipse cx="50" cy="50" rx="47" ry="33" fill="${P.accent}"/>` +
    `<ellipse cx="50" cy="50" rx="42.5" ry="28.5" fill="none" stroke="${P.block}" stroke-width="1.2" opacity=".55"/>` +
    `<path d="${A_PATH}" fill="none" stroke="${P.block}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" transform="translate(50 50) scale(.52) translate(-50 -50)"/>`,
    ` aria-label="№6 — стикер"`),
  a3: svg('0 0 172 100',
    `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M16 90V10L48 90V10" stroke-width="11"/><circle cx="70" cy="22" r="8" stroke-width="8"/><path d="M60 42H80" stroke-width="8"/>` +
    `<path d="${A_PATH}" stroke-width="11" transform="translate(82 0)"/></g>`,
    ` color="${P.ink}" aria-label="№6 — лок-ап"`),

  b1: svg('0 0 100 100', `<path fill="currentColor" d="${B_PATH}"/>`, ` color="${P.ink}" aria-label="№6 — Совершенное число"`),
  b2: svg('0 0 100 100',
    `<path d="M50 2L91.57 26V74L50 98L8.43 74V26Z" fill="${P.accent}"/>` +
    `<path fill="${P.block}" d="${B_PATH}" transform="translate(50 50) scale(.6) translate(-50 -50)"/>`,
    ` aria-label="№6 — сота"`),
  b3: svg('0 0 186 100',
    `<path fill="currentColor" d="M10 5H25V95H10ZM45 5H60V95H45ZM10 5H25L60 95H45ZM90 20A12 12 0 1 1 66 20A12 12 0 1 1 90 20ZM83 20A5 5 0 1 0 73 20A5 5 0 1 0 83 20ZM66 40H90V47H66Z"/>` +
    `<path fill="currentColor" d="${B_PATH}" transform="translate(96 0)"/>`,
    ` color="${P.ink}" aria-label="№6 — лок-ап"`),

  c1: svg('0 0 100 100', `<path fill="currentColor" d="${C_PATH}"/>`, ` color="${P.ink}" aria-label="№6 — Плюс семь"`),
  c2: svg('0 0 100 100', `<path fill="${P.ink}" d="${C_RING}"/><path fill="${P.accent}" d="${C_SEVEN}"/>`, ` aria-label="№6 — семёрка раскрыта"`),
  c3: svg('0 0 186 100',
    `<path fill="currentColor" d="M10 6H24V98H10ZM44 6H58V98H44ZM10 6H24L58 98H44ZM88 20A12 12 0 1 1 64 20A12 12 0 1 1 88 20ZM81 20A5 5 0 1 0 71 20A5 5 0 1 0 81 20ZM64 40H88V47H64Z"/>` +
    `<path fill="currentColor" d="${C_PATH}" transform="translate(94 0)"/>`,
    ` color="${P.ink}" aria-label="№6 — лок-ап"`),
};

const CONCEPTS = [
  {
    id: 'alty', letter: 'A', name: 'Алты', technique: 'двойное прочтение + место',
    idea: 'Шестёрка — яблоко Алматы, нарисованное одной непрерывной линией.',
    elements: [
      ['Петля', 'яблоко: Алматы — «яблочное место», апорт. Тело шире, чем выше, как у плода.'],
      ['Хвост', 'черенок яблока и одновременно хвост цифры — растёт из ямки, где петля встречает линию.'],
      ['Одна линия', 'знак рисуется одним росчерком, без стыков: сделано одной рукой; один сервис — без переключений.'],
      ['Круглые концы', 'ни одного острого угла — всё отполировано.'],
    ],
    egg: 'Цифра — это яблоко: круглое тело, ямка сверху, черенок. Второй слой — язык: «алты» (шесть) спрятано в слове АЛ·МА·ТЫ и на одну букву короче слова «алтын» (золото). Шестёрка живёт внутри города и внутри золота.',
    eggLabel: 'Показать яблоко',
    font: 'Manrope 800 для слов семьи («Магазин», «Brand»): это шрифт продукта, у него такая же круглая шестёрка. Сам знак рисованный, не набранный.',
    colors: [['Чернила', P.ink], ['Бумага', P.paper], ['Стикер', P.accent]],
    colorNote: 'Красный апорта намеренно не берём: в продукте красный — только опасность.',
    variants: [
      { id: 'a1', title: 'Знак', role: 'основной', vb: '0 0 100 100' },
      { id: 'a2', title: 'Стикер', role: 'наклейка на фрукт — этикетка товаров семьи', vb: '0 0 100 100' },
      { id: 'a3', title: 'Лок-ап №6', role: 'для «Магазин №6», «Brand №6»', vb: '0 0 172 100' },
    ],
  },
  {
    id: 'perfect', letter: 'B', name: 'Совершенное число', technique: 'геометрия со значением + негативное пространство',
    idea: '6 — первое совершенное число: 1 + 2 + 3 = 1 × 2 × 3 = 6. Знак построен из собственных делителей.',
    elements: [
      ['Просвет Ø 1', 'единица — один аккаунт, один человек, который всё это построил.'],
      ['Чаша Ø 2', 'полный круг, а не полумера. Двойка — две стороны: люди и бизнес.'],
      ['Высота 3', 'хвост поднимается ровно на радиус чаши. Три — kk · ru · en, три языка платформы.'],
      ['Хвост', 'дуга окружности вдвое большего радиуса, касательная к чаше слева: линия перетекает без шва.'],
    ],
    egg: 'Внутри шестёрки — шестиугольник: шесть сторон в цифре шесть. Виден от 48 px, на 16 px цифра остаётся обычной. Второй слой — пропорции 1 : 2 : 3, которые и делают число совершенным. Шестиугольник — ещё и сота: сервисы экосистемы стыкуются без зазоров.',
    eggLabel: 'Показать делители',
    font: 'Manrope 800. Геометрия знака (круг + дуга) совпадает с логикой цифр Manrope, поэтому лок-ап и текст стоят рядом без спора.',
    colors: [['Чернила', P.ink], ['Бумага', P.paper], ['Сота', P.accent]],
    colorNote: 'Один цвет на знак. Акцент — только заливка соты и иконки приложения.',
    variants: [
      { id: 'b1', title: 'Знак', role: 'основной', vb: '0 0 100 100' },
      { id: 'b2', title: 'Сота', role: 'аватар, иконка, печать на товаре', vb: '0 0 100 100' },
      { id: 'b3', title: 'Лок-ап №6', role: 'для «Магазин №6», «Brand №6»', vb: '0 0 186 100' },
    ],
  },
  {
    id: 'plus7', letter: 'C', name: 'Плюс семь', technique: 'спрятанное число + координата',
    idea: 'Прикрой ладонью кольцо — останется семёрка. +7 — код страны, 76° — меридиан Алматы.',
    elements: [
      ['Кольцо', 'один аккаунт без швов. Толщина одна везде — ни одной «тонкой» части.'],
      ['Диагональ', 'единственная прямая в знаке. Шестёрка сделана из круга, семёрка — из линии: две цифры из противоположных материалов.'],
      ['Флажок сверху', 'перекладина семёрки. Для цифры — плоский терминал, как у инженерных гарнитур.'],
      ['Касание', 'диагональ входит в кольцо по касательной: сделано с линейкой и циркулем, не на глаз.'],
    ],
    egg: 'В шестёрке спрятана семёрка: перекладина + диагональ. Вход в экосистему — по номеру телефона, а номер начинается с +7: ключ к №6 буквально вписан в знак. Вместе цифры дают 76 — восточную долготу Алматы.',
    eggLabel: 'Прикрыть кольцо',
    font: 'Manrope 800. Прямая диагональ знака рифмуется с прямыми штрихами Manrope в «7» и «4».',
    colors: [['Чернила', P.ink], ['Бумага', P.paper], ['Семёрка', P.accent]],
    colorNote: 'Двухцветная версия — только для раскрытия пасхалки в коммуникации, не для иконки.',
    variants: [
      { id: 'c1', title: 'Знак', role: 'основной', vb: '0 0 100 100' },
      { id: 'c2', title: 'Раскрытие', role: 'семёрка подсвечена — для презентации и мерча', vb: '0 0 100 100' },
      { id: 'c3', title: 'Лок-ап №6', role: 'для «Магазин №6», «Brand №6»', vb: '0 0 186 100' },
    ],
  },
];

// ---------- Файлы ----------
for (const c of CONCEPTS) for (const v of c.variants) writeFileSync(join(OUT, `${v.id}-${c.id}.svg`), V[v.id] + '\n');

const json = {
  brand: '№6',
  generatedAt: '2026-09-25',
  palette: P,
  note: 'Все знаки — чистый вектор, без растровых эффектов. currentColor — цвет через атрибут color на корне.',
  concepts: CONCEPTS.map((c) => ({
    id: c.id, name: c.name, technique: c.technique, idea: c.idea,
    elements: Object.fromEntries(c.elements), easterEgg: c.egg, font: c.font,
    colors: Object.fromEntries(c.colors), colorNote: c.colorNote,
    variants: c.variants.map((v) => ({ id: v.id, title: v.title, role: v.role, viewBox: v.vb, file: `${v.id}-${c.id}.svg`, svg: V[v.id] })),
  })),
};
writeFileSync(join(OUT, 'logo-concepts.json'), JSON.stringify(json, null, 2) + '\n');

// ---------- Витрина ----------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sym = (id, vb, body) => `<symbol id="s-${id}" viewBox="${vb}">${body}</symbol>`;
const inner = (s) => s.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');

const symbols = CONCEPTS.flatMap((c) => c.variants.map((v) => sym(v.id, v.vb, inner(V[v.id])))).join('');

// Основной знак каждого концепта — инлайн, с частями для раскрытия
const hero = {
  alty: `<svg viewBox="0 0 100 100" class="hero-svg"><path d="${A_TAIL}" ${A_STROKE}/><path class="egg-loop" d="${A_LOOP}" ${A_STROKE}/></svg>`,
  perfect: `<svg viewBox="0 0 100 100" class="hero-svg"><path fill="currentColor" d="${B_PATH}"/>
    <g class="egg-guides" fill="none" stroke-width=".8" stroke-dasharray="2 2">
      <circle cx="50" cy="65" r="15"/><circle cx="50" cy="65" r="30"/><path d="M88 5V95M85 5h6M85 95h6M85 35h6M85 65h6"/></g>
    <path class="egg-hex" d="${B_HEX}" fill="none" stroke-width="1.6" stroke-linejoin="round"/>
    <g class="egg-labels" font-family="Manrope, system-ui, sans-serif" font-size="6" font-weight="800"><text x="91" y="21">3</text><text x="91" y="51">2</text><text x="91" y="81">1</text></g></svg>`,
  plus7: `<svg viewBox="0 0 100 100" class="hero-svg"><path class="egg-ring" fill="currentColor" d="${C_RING}"/><path class="egg-seven" fill="currentColor" d="${C_SEVEN}"/></svg>`,
};

const conceptHtml = (c, i) => `
<section class="concept" id="${c.id}">
  <header class="c-head">
    <p class="eyebrow">Концепт ${c.letter} · приём: ${c.technique}</p>
    <h2>«${c.name}»</h2>
    <p class="idea">${c.idea}</p>
  </header>
  <div class="c-grid">
    <div class="story">
      <div class="hero" aria-label="${c.name}, основной знак">${hero[c.id]}</div>
      <label class="switch" for="rev-${c.id}"><input type="checkbox" id="rev-${c.id}" data-target="${c.id}"><span class="knob" aria-hidden="true"></span>${c.eggLabel}</label>
      <h3>Что означает</h3>
      <dl class="elements">${c.elements.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
      <h3>Пасхалка</h3>
      <p>${c.egg}</p>
      <h3>Шрифт и цвет</h3>
      <p>${c.font}</p>
      <ul class="swatches">${c.colors.map(([n, h]) => `<li><i style="background:${h}"></i><span>${n}</span><code>${h}</code></li>`).join('')}</ul>
      <p class="note">${c.colorNote}</p>
    </div>
    <div class="sheet">
      <div class="tiles">${c.variants.map((v) => `
        <figure class="tile">
          <div class="art"><svg class="v ${v.vb === '0 0 100 100' ? 'sq' : 'wide'}"><use href="#s-${v.id}"/></svg></div>
          <figcaption><b>${v.title}</b><span>${v.role}</span></figcaption>
          <details><summary>SVG</summary><div class="code"><button type="button" class="copy" data-copy="${v.id}">Копировать</button><pre id="code-${v.id}">${esc(V[v.id])}</pre></div></details>
        </figure>`).join('')}
      </div>
      <h3>Проверка</h3>
      <div class="tests">
        <div class="test light"><span class="t-label">16 · 24 · 32 · 64 px</span><div class="row">
          <svg width="16" height="16"><use href="#s-${c.variants[0].id}"/></svg><svg width="24" height="24"><use href="#s-${c.variants[0].id}"/></svg><svg width="32" height="32"><use href="#s-${c.variants[0].id}"/></svg><svg width="64" height="64"><use href="#s-${c.variants[0].id}"/></svg></div></div>
        <div class="test dark"><span class="t-label">Один цвет на тёмном</span><div class="row"><svg width="64" height="64"><use href="#s-${c.variants[0].id}"/></svg><svg width="120" height="64"><use href="#s-${c.variants[2].id}"/></svg></div></div>
        <div class="test accent"><span class="t-label">Выворотка на акценте</span><div class="row"><svg width="64" height="64"><use href="#s-${c.variants[0].id}"/></svg><svg width="120" height="64"><use href="#s-${c.variants[2].id}"/></svg></div></div>
      </div>
    </div>
  </div>
</section>`;

const html = `<title>Знак №6</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap">
<style>
:root{--paper:#eae6de;--block:#fafbf8;--ink:#1d1b1d;--muted:#6b655e;--accent:#588cd3;--accent-dim:#3f6aa8;--border:#e2dccf;--divider:#eee9dd;--dark:#1d1b1d;--on-dark:#fafbf8;--code:#f1ede3}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;--paper:#191816;--block:#23211e;--ink:#ede8de;--muted:#a49e92;--accent:#7ba5e0;--accent-dim:#9dbde8;--border:#36332e;--divider:#2e2b27;--dark:#0f0e0d;--on-dark:#ede8de;--code:#1c1a18}}
:root[data-theme="dark"]{color-scheme:dark;--paper:#191816;--block:#23211e;--ink:#ede8de;--muted:#a49e92;--accent:#7ba5e0;--accent-dim:#9dbde8;--border:#36332e;--divider:#2e2b27;--dark:#0f0e0d;--on-dark:#ede8de;--code:#1c1a18}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:Manrope,"Segoe UI",system-ui,sans-serif;font-size:15px;line-height:1.55;padding-inline:clamp(16px,4vw,40px);padding-block:32px 64px}
.wrap{max-width:1160px;margin-inline:auto;display:flex;flex-direction:column;gap:40px}
h1,h2,h3{margin:0;text-wrap:balance;letter-spacing:-.01em}
h1{font-size:clamp(40px,7vw,68px);font-weight:800;line-height:1;letter-spacing:-.03em}
h2{font-size:clamp(26px,3.4vw,34px);font-weight:800}
h3{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-top:22px}
p{margin:0;max-width:62ch}
.eyebrow{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:8px}
.lede{color:var(--muted);font-size:17px;max-width:60ch}
.top{display:grid;gap:20px}
.compare{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.compare a{display:flex;flex-direction:column;align-items:center;gap:10px;background:var(--block);border:1px solid var(--border);border-radius:12px;padding:20px 12px 16px;color:inherit;text-decoration:none}
.compare a:focus-visible,.switch:focus-within,.copy:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.compare .big{width:104px;height:104px}
.compare .tiny{display:flex;gap:10px;align-items:center;color:var(--muted)}
.compare b{font-size:14px}
.compare small{color:var(--muted);font-size:12px}
.concept{background:var(--block);border:1px solid var(--border);border-radius:12px;padding:clamp(20px,3vw,36px);display:grid;gap:24px}
.idea{font-size:17px;margin-top:8px}
.c-grid{display:grid;grid-template-columns:minmax(280px,5fr) minmax(320px,7fr);gap:32px}
.hero{background:var(--paper);border-radius:12px;padding:24px;display:grid;place-items:center;aspect-ratio:1.15;max-width:100%}
.hero-svg{width:min(100%,260px);height:auto;color:var(--ink);overflow:visible}
.egg-loop{stroke:var(--accent);opacity:0;transition:opacity .25s}
.egg-guides,.egg-hex,.egg-labels{stroke:var(--accent);fill:none;opacity:0;transition:opacity .25s}
.egg-labels{fill:var(--accent);stroke:none}
.egg-ring{transition:opacity .25s}
.egg-seven{transition:fill .25s}
.on .egg-loop,.on .egg-guides,.on .egg-hex,.on .egg-labels{opacity:1}
.on .egg-ring{opacity:.12}
.on .egg-seven{fill:var(--accent)}
.switch{display:inline-flex;align-items:center;gap:10px;margin-top:14px;font-weight:600;cursor:pointer;user-select:none}
.switch input{position:absolute;opacity:0;width:0;height:0}
.knob{width:38px;height:22px;border-radius:11px;background:var(--border);position:relative;transition:background .2s;flex:none}
.knob::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:var(--block);transition:transform .2s}
.switch input:checked+.knob{background:var(--accent)}
.switch input:checked+.knob::after{transform:translateX(16px)}
.elements{margin:0;display:grid;gap:10px}
.elements div{display:grid;grid-template-columns:110px 1fr;gap:12px;padding-bottom:10px;border-bottom:1px solid var(--divider)}
.elements dt{font-weight:700;margin:0}
.elements dd{margin:0;color:var(--muted)}
.swatches{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:8px 18px}
.swatches li{display:flex;align-items:center;gap:8px;font-size:13px}
.swatches i{width:22px;height:22px;border-radius:6px;border:1px solid var(--border);display:inline-block}
.swatches code{color:var(--muted);font-family:ui-monospace,Consolas,monospace;font-size:12px}
.note{color:var(--muted);font-size:13px;margin-top:8px}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.tile{margin:0;background:var(--paper);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px;min-width:0}
.art{display:grid;place-items:center;height:150px;color:var(--ink)}
.v.sq{width:120px;height:120px}
.v.wide{width:100%;max-width:210px;height:110px}
figcaption{display:flex;flex-direction:column;gap:2px}
figcaption b{font-size:14px}
figcaption span{font-size:12px;color:var(--muted)}
details{font-size:12px}
summary{cursor:pointer;color:var(--accent-dim);font-weight:700;list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"‹›";margin-right:6px;font-family:ui-monospace,monospace}
.code{position:relative;margin-top:8px}
.code pre{margin:0;background:var(--code);border:1px solid var(--border);border-radius:8px;padding:10px 10px 10px;font-size:10.5px;line-height:1.45;overflow-x:auto;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Consolas,monospace;color:var(--ink)}
.copy{position:absolute;top:6px;right:6px;border:1px solid var(--border);background:var(--block);color:var(--ink);border-radius:6px;padding:4px 8px;font:inherit;font-size:11px;font-weight:700;cursor:pointer}
.tests{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.test{border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:12px;min-height:130px}
.test.light{background:var(--paper);color:var(--ink)}
.test.dark{background:var(--dark);color:var(--on-dark)}
.test.accent{background:var(--accent);color:#fafbf8}
.t-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;opacity:.75}
.row{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}
.row svg{flex:none}
.verdict{background:var(--ink);color:var(--paper);border-radius:12px;padding:clamp(20px,3vw,36px);display:grid;grid-template-columns:auto 1fr;gap:28px;align-items:start}
.verdict .mark{width:132px;height:132px;color:var(--paper)}
.verdict h2{color:inherit}
.verdict p{color:inherit;opacity:.9}
.verdict ul{margin:12px 0 0;padding-left:18px;display:grid;gap:6px;max-width:62ch}
.verdict .eyebrow{color:inherit;opacity:.7}
@media (max-width:900px){.c-grid,.tiles,.tests{grid-template-columns:1fr}.compare{grid-template-columns:1fr}.verdict{grid-template-columns:1fr}}
@media (max-width:560px){.elements div{grid-template-columns:1fr;gap:2px}}
@media (prefers-reduced-motion: reduce){*{transition:none!important}}
</style>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${symbols}</defs></svg>
<main class="wrap">
  <header class="top">
    <p class="eyebrow">Бренд-дизайн · 25 сентября 2026 · Алматы</p>
    <h1>Знак №6</h1>
    <p class="lede">Три концепта знака, в котором главная — цифра. В каждом спрятана хотя бы одна деталь, которую замечаешь не сразу и потом не можешь развидеть. Переключатели под знаками раскрывают её.</p>
    <nav class="compare" aria-label="Три концепта">
      <a href="#alty"><svg class="big"><use href="#s-a1"/></svg><b>A · Алты</b><small>одна линия, яблоко Алматы</small><span class="tiny"><svg width="16" height="16"><use href="#s-a1"/></svg>16 px</span></a>
      <a href="#perfect"><svg class="big"><use href="#s-b1"/></svg><b>B · Совершенное число</b><small>1 : 2 : 3, шесть внутри шести</small><span class="tiny"><svg width="16" height="16"><use href="#s-b1"/></svg>16 px</span></a>
      <a href="#plus7"><svg class="big"><use href="#s-c1"/></svg><b>C · Плюс семь</b><small>семёрка в шестёрке, 76° в. д.</small><span class="tiny"><svg width="16" height="16"><use href="#s-c1"/></svg>16 px</span></a>
    </nav>
  </header>
  ${CONCEPTS.map(conceptHtml).join('')}
  <section class="verdict" id="verdict">
    <svg class="mark"><use href="#s-b1"/></svg>
    <div>
      <p class="eyebrow">Рекомендация</p>
      <h2>Брать «Совершенное число»</h2>
      <p>Смысл заложен в самой цифре, а не в месте или языке: «6 — единственное однозначное совершенное число, и наш знак построен из его делителей» работает одинаково для «Магазин №6» в Алматы и «Brand №6» где угодно. Это самая долговечная история из трёх.</p>
      <ul>
        <li>Читается на 16 px как обычная шестёрка, на 48 px и выше отдаёт шестиугольник — пасхалка не мешает читаемости.</li>
        <li>Один цвет, одна заливка, ни одного штриха: печать, гравировка, вышивка, ключ приложения.</li>
        <li>«Полный круг, а не полумера» — ценность бренда, произнесённая формой.</li>
        <li>«Алты» — самый тёплый, но яблоко — занятая территория (Apple, бренд города), а линия тоньше на мелких размерах. «Плюс семь» — самая громкая пасхалка, годится как кампания к запуску, но как единственный знак читается менее стабильно.</li>
      </ul>
    </div>
  </section>
</main>
<script>
document.querySelectorAll('.switch input').forEach((cb)=>{cb.addEventListener('change',()=>{document.getElementById(cb.dataset.target).classList.toggle('on',cb.checked)})});
document.querySelectorAll('.copy').forEach((btn)=>{btn.addEventListener('click',()=>{const pre=document.getElementById('code-'+btn.dataset.copy);const text=pre.textContent;const done=()=>{btn.textContent='Скопировано';setTimeout(()=>btn.textContent='Копировать',1500)};const fallback=()=>{const r=document.createRange();r.selectNodeContents(pre);const s=getSelection();s.removeAllRanges();s.addRange(r)};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done).catch(fallback)}else{fallback()}})});
</script>
`;
writeFileSync(join(OUT, 'index.html'), html);
console.log('ok', Object.keys(V).length, 'svg');
