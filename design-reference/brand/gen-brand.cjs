/* Генератор фирменного знака SuperApp6: SVG-ассеты + витрина showcase.html.
   Запуск: node design-reference/brand/gen-brand.cjs [outDir]. Текст вшивается контурами (Manrope 800),
   поэтому SVG не зависят от установленных шрифтов. Геометрия знака и палитра — ниже, в одном месте. */
const fs = require('fs');
const path = require('path');
// fontkit берём из зависимостей pdf-lib (прямой зависимости у монорепы нет); версия пинована pnpm-lock
const fontkit = require(path.resolve(__dirname, '../../node_modules/.pnpm/@pdf-lib+fontkit@1.1.1/node_modules/@pdf-lib/fontkit'));

// Manrope (OFL 1.1), латинский сабсет вариативного шрифта — копия того, что next/font отдаёт вебу
const FONT = path.join(__dirname, 'Manrope-latin-variable.woff2');
const OUT = process.argv[2] || __dirname;
fs.mkdirSync(OUT, { recursive: true });

// Палитра — только DESIGN.md / globals.css, ничего нового.
const C = {
  page: '#eae6de', block: '#fafbf8', ink: '#1d1b1d', muted: '#6b655e', border: '#e2dccf',
  primary: '#588cd3', primaryDim: '#3f6aa8', onPrimary: '#ffffff', gradMid: '#d6a04c',
  line: '#ddd6c8', active: '#ece7dc', divider: '#eee9dd', tickEmpty: '#e4ded1', hover: '#f1ede3',
};

// ---------- шрифт: WOFF2 + вариации (обход бага fontkit) ----------
const fontBuf = fs.readFileSync(FONT);
const fontCache = new Map();
let glyphProtoPatched = false;
function fontFor(weight) {
  if (fontCache.has(weight)) return fontCache.get(weight);
  const f = fontkit.create(fontBuf);
  // Предекод трансформированного glyf БЕЗ процессора вариаций (иначе падает на композитах)
  Object.defineProperty(f, '_variationProcessor', { configurable: true, get() { return null; } });
  const g1 = f.getGlyph(1);
  if (!glyphProtoPatched) {
    const P = Object.getPrototypeOf(g1);
    P._decode = function () {
      const base = this._font._transformedGlyphs[this.id];
      if (!base || !base.points) return base;
      const glyph = Object.assign({}, base, {
        points: base.points.map((p) => Object.assign(Object.create(Object.getPrototypeOf(p)), p)),
      });
      const vp = this._font._variationProcessor;
      if (vp) {
        const pts = glyph.points.slice();
        // Фантомные точки: реальные не нужны (аванс берётся из HVAR), но их наличие обязательно для IUP
        const Pt = Object.getPrototypeOf(glyph.points[0]).constructor;
        for (let i = 0; i < 4; i++) pts.push(new Pt(false, true, 0, 0));
        vp.transformPoints(this.id, pts);
        glyph.phantomPoints = pts.slice(-4);
      }
      return glyph;
    };
    glyphProtoPatched = true;
  }
  delete f._variationProcessor;
  f.variationCoords = [weight];
  f._glyphs = {};
  fontCache.set(weight, f);
  return f;
}
const r2 = (v) => Math.round(v * 100) / 100;
function glyphD(glyph, x, y, s) {
  let d = '';
  const X = (v) => r2(x + v * s);
  const Y = (v) => r2(y - v * s);
  for (const c of glyph.path.commands) {
    const a = c.args;
    if (c.command === 'moveTo') d += `M${X(a[0])} ${Y(a[1])}`;
    else if (c.command === 'lineTo') d += `L${X(a[0])} ${Y(a[1])}`;
    else if (c.command === 'quadraticCurveTo') d += `Q${X(a[0])} ${Y(a[1])} ${X(a[2])} ${Y(a[3])}`;
    else if (c.command === 'bezierCurveTo') d += `C${X(a[0])} ${Y(a[1])} ${X(a[2])} ${Y(a[3])} ${X(a[4])} ${Y(a[5])}`;
    else if (c.command === 'closePath') d += 'Z';
  }
  return d;
}
/** Текст контурами. Возвращает path d (базовая линия y=0, старт x=0), ширину и метрики. */
function text(str, size, weight = 800, tracking = -0.02) {
  const f = fontFor(weight);
  const run = f.layout(str);
  const s = size / f.unitsPerEm;
  let x = 0;
  let d = '';
  run.glyphs.forEach((g, i) => {
    const p = run.positions[i];
    d += glyphD(g, x + p.xOffset * s, -p.yOffset * s, s);
    x += p.xAdvance * s + tracking * size;
  });
  return { d, width: r2(x - tracking * size), cap: f.capHeight * s, xh: f.xHeight * s, asc: f.ascent * s, desc: -f.descent * s };
}

// ---------- знак «Кольцо‑6» (viewBox 64) ----------
// Хвост: дуга r26 с центром (44,38) от верха (44,12) до левой точки (18,38);
// чаша: окружность r14 с центром (32,38). В точке (18,38) обе касательные вертикальны.
const MARK_D = 'M44 12A26 26 0 0 0 18 38A14 14 0 1 0 46 38A14 14 0 1 0 18 38';
const MARK = { cx: 32, cy: 38, r: 14, top: 12, sw: 7, dot: 4.5 };
function ringSix({ color, sw = MARK.sw, dot = MARK.dot } = {}) {
  return `<path d="${MARK_D}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>` +
    (dot ? `<circle cx="${MARK.cx}" cy="${MARK.cy}" r="${dot}" fill="${color}"/>` : '');
}
function svg(w, h, inner, extra = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"${extra ? ' ' + extra : ''}>${inner}</svg>`;
}
const mark = (color, o) => svg(64, 64, ringSix({ color, ...o }));
function tile({ bg = C.primary, fg = C.onPrimary, rx = 14, scale = 0.86, dot = MARK.dot, sw = MARK.sw } = {}) {
  return svg(64, 64, `<rect width="64" height="64" rx="${rx}" fill="${bg}"/><g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${ringSix({ color: fg, dot, sw })}</g>`);
}
// Штриховая версия (фирменный tick-паттерн) — для крупных поверхностей
function tickMark({ color = C.primary, id = 'tk', step = 2, bar = 0.8 } = {}) {
  return svg(64, 64,
    `<defs><pattern id="${id}p" patternUnits="userSpaceOnUse" width="${step}" height="64"><rect width="${bar}" height="64" fill="${color}"/></pattern>` +
    `<mask id="${id}m">${ringSix({ color: '#fff' })}</mask></defs>` +
    `<rect width="64" height="64" fill="url(#${id}p)" mask="url(#${id}m)"/>`);
}
// Построение: направляющие
function construction() {
  const g = C.muted;
  return svg(64, 64,
    `<g fill="none" stroke="${g}" stroke-width="0.4" stroke-dasharray="1 1">` +
    `<circle cx="32" cy="38" r="14"/><circle cx="44" cy="38" r="26"/><circle cx="32" cy="38" r="${MARK.r + MARK.sw / 2}"/><circle cx="32" cy="38" r="${MARK.r - MARK.sw / 2}"/>` +
    `<line x1="0" y1="38" x2="64" y2="38"/><line x1="32" y1="0" x2="32" y2="64"/><line x1="44" y1="0" x2="44" y2="64"/><line x1="0" y1="12" x2="64" y2="12"/>` +
    `</g><g opacity="0.35">${ringSix({ color: C.primary })}</g>` +
    `<g fill="${g}"><circle cx="32" cy="38" r="0.9"/><circle cx="44" cy="38" r="0.9"/><circle cx="18" cy="38" r="0.9"/><circle cx="44" cy="12" r="0.9"/></g>`);
}

// ---------- словесный знак: «SuperApp» + геометрическая 6 ----------
/** Геометрическая 6 в строке текста: высота = капитель, стоит на базовой линии. */
function wordSix(x, baseline, cap, color, { sw = 9, dot = 4 } = {}) {
  const visTop = MARK.top - sw / 2, visBot = MARK.cy + MARK.r + sw / 2; // видимая высота в 64-единицах
  const h = visBot - visTop;
  const over = cap * 0.012; // овершут круглой формы
  const k = (cap + 2 * over) / h;
  const left = MARK.cx - MARK.r - sw / 2;
  const tx = x - left * k;
  const ty = baseline + over - visBot * k;
  return { markup: `<g transform="translate(${r2(tx)} ${r2(ty)}) scale(${r2(k)})">${ringSix({ color, sw, dot })}</g>`, width: (MARK.cx + MARK.r + sw / 2 - left) * k };
}
/** Словесный знак: текст + 6. Возвращает {markup, width, height, baseline}. */
function wordmark(word, size, { ink = C.ink, six = C.primary, gapEm = 0.06, sixOpts, suffix, suffixColor = C.muted, suffixWeight = 600 } = {}) {
  const t = text(word, size, 800, -0.02);
  const baseline = r2(t.cap + size * 0.08);
  let x = t.width + gapEm * size;
  const s6 = wordSix(x, baseline, t.cap, six, sixOpts);
  let markup = `<path d="${t.d}" transform="translate(0 ${baseline})" fill="${ink}"/>` + s6.markup;
  x += s6.width;
  if (suffix) {
    const ts = text(suffix, size * 0.78, suffixWeight, -0.01);
    x += size * 0.32;
    markup += `<path d="${ts.d}" transform="translate(${r2(x)} ${baseline})" fill="${suffixColor}"/>`;
    x += ts.width;
  }
  const height = r2(baseline + size * 0.3);
  return { markup, width: r2(x), height, baseline, cap: t.cap };
}
function wordmarkSvg(word, size, opts) {
  const w = wordmark(word, size, opts);
  return svg(Math.ceil(w.width), w.height, w.markup);
}
/** Горизонтальный лок-ап: плитка + имя (как в шапке приложения). */
function lockupTile(size = 64, { ink = C.ink, six = C.primary } = {}) {
  const w = wordmark('SuperApp', size * 0.56, { ink, six });
  const gap = size * 0.22;
  const cy = size / 2;
  const ty = r2(cy - w.cap / 2 - (w.baseline - w.cap));
  const inner = `<g transform="translate(0 0) scale(${size / 64})"><rect width="64" height="64" rx="14" fill="${C.primary}"/><g transform="translate(32 32) scale(0.86) translate(-32 -32)">${ringSix({ color: C.onPrimary })}</g></g>` +
    `<g transform="translate(${r2(size + gap)} ${ty})">${w.markup}</g>`;
  return svg(Math.ceil(size + gap + w.width), size, inner);
}
/** Вертикальный лок-ап: знак над словесным знаком. */
function lockupStacked({ ink = C.ink, six = C.primary } = {}) {
  const w = wordmark('SuperApp', 34, { ink, six });
  const W = Math.max(96, w.width) + 8;
  const inner = `<g transform="translate(${r2((W - 96) / 2)} 0) scale(1.5)">${ringSix({ color: six })}</g>` +
    `<g transform="translate(${r2((W - w.width) / 2)} 104)">${w.markup}</g>`;
  return svg(Math.ceil(W), Math.ceil(104 + w.height), inner);
}

// ---------- альтернативы ----------
function bentoSix({ bg = C.block, cell = C.page, accent = C.primary, border = C.border } = {}) {
  const cells = [[0, 0, 2, 1], [2, 0, 1, 1], [0, 1, 1, 1], [1, 1, 2, 1], [0, 2, 1, 1], [1, 2, 2, 1]];
  const pad = 10, gap = 4, u = (64 - 2 * pad - 2 * gap) / 3;
  let inner = `<rect x="0.5" y="0.5" width="63" height="63" rx="14" fill="${bg}" stroke="${border}"/>`;
  cells.forEach(([cx, cy, cw, ch], i) => {
    const x = pad + cx * (u + gap), y = pad + cy * (u + gap), w = cw * u + (cw - 1) * gap, h = ch * u + (ch - 1) * gap;
    inner += `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" rx="3.5" fill="${i === 2 ? accent : cell}"/>`;
  });
  return svg(64, 64, inner);
}
function overlapMark({ ink = C.ink, accent = C.primary, id = 'ov', bg } = {}) {
  const inner = (bg ? `<rect width="64" height="64" rx="14" fill="${bg}"/>` : '') +
    `<defs><clipPath id="${id}c"><rect x="24" y="8" width="32" height="32" rx="9"/></clipPath></defs>` +
    `<circle cx="25" cy="39" r="17" fill="${accent}" clip-path="url(#${id}c)"/>` +
    `<g fill="none" stroke="${ink}" stroke-width="4.5"><circle cx="25" cy="39" r="17"/><rect x="24" y="8" width="32" height="32" rx="9"/></g>`;
  return svg(64, 64, inner);
}

// ---------- файлы ----------
const files = {
  'superapp6-mark.svg': mark(C.primary),
  'superapp6-mark-mono.svg': mark('currentColor'),
  'superapp6-mark-tile.svg': tile(),
  'superapp6-favicon.svg': tile({ dot: 0, sw: 8, scale: 0.9 }),
  'superapp6-mark-ticks.svg': tickMark(),
  'superapp6-wordmark.svg': wordmarkSvg('SuperApp', 64),
  'superapp6-wordmark-dark.svg': wordmarkSvg('SuperApp', 64, { ink: C.block }),
  'superapp6-wordmark-mono.svg': wordmarkSvg('SuperApp', 64, { ink: 'currentColor', six: 'currentColor' }),
  'superapp6-logo.svg': lockupTile(64),
  'superapp6-logo-dark.svg': lockupTile(64, { ink: C.block }),
  'superapp6-logo-stacked.svg': lockupStacked(),
  'superapp6-business.svg': wordmarkSvg('SuperApp', 64, { suffix: 'Business' }),
  'superaiagent6.svg': wordmarkSvg('SuperAIAgent', 64),
  'superterminal6.svg': wordmarkSvg('SuperTerminal', 64),
  'alt-bento.svg': bentoSix(),
  'alt-overlap.svg': overlapMark(),
};
for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), content + '\n');

// ---------- витрина ----------
const inl = (s, w, h, cls = '') => s.replace(/^<svg /, `<svg class="${cls}" `).replace(/ width="[^"]+" height="[^"]+"/, ` width="${w}" height="${h}"`).replace(/<svg([^>]*)>/, '<svg$1 preserveAspectRatio="xMidYMid meet">');
const fit = (s, h, cls = '') => {
  const m = s.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const w = r2((+m[1]) * h / (+m[2]));
  return inl(s, w, h, cls);
};
const sizes = [16, 20, 24, 32, 40, 48, 64];
const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>SuperApp6 — фирменный знак</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400..800&display=swap" rel="stylesheet">
<link rel="icon" href="superapp6-favicon.svg" type="image/svg+xml">
<style>
:root{--page:${C.page};--block:${C.block};--ink:${C.ink};--muted:${C.muted};--border:${C.border};--primary:${C.primary};--primary-dim:${C.primaryDim};--active:${C.active};--divider:${C.divider};--radius-card:24px;--radius-md:12px;--shadow:0 4px 20px rgba(0,0,0,.04)}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--page);color:var(--ink);font-family:Manrope,system-ui,sans-serif;font-weight:500;font-size:14px;line-height:1.55;padding:28px 24px 64px}
.wrap{max-width:1120px;margin:0 auto}
h1{font-size:26px;font-weight:800;letter-spacing:-.02em;margin:0 0 6px}
h2{font-size:18px;font-weight:800;letter-spacing:-.01em;margin:0 0 4px}
p{margin:0}.lead{color:var(--muted);max-width:720px}
.caps{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px;margin-top:16px}
.card{background:var(--block);border:1px solid var(--border);border-radius:var(--radius-card);box-shadow:var(--shadow);padding:20px;display:flex;flex-direction:column;gap:12px;min-width:0}
.card.dark{background:var(--ink);color:var(--block);border-color:var(--ink)}
.card.blue{background:var(--primary);color:#fff;border-color:var(--primary)}
.card.page{background:var(--page)}
.c3{grid-column:span 3}.c4{grid-column:span 4}.c6{grid-column:span 6}.c8{grid-column:span 8}.c12{grid-column:span 12}
@media (max-width:900px){.c3,.c4{grid-column:span 6}}@media (max-width:600px){.c3,.c4,.c6,.c8{grid-column:span 12}body{padding:16px 16px 48px}}
.stage{flex:1;display:flex;align-items:center;justify-content:center;min-height:120px;padding:8px}
.stage.left{justify-content:flex-start}
.row{display:flex;align-items:flex-end;gap:20px;flex-wrap:wrap}
.sz{display:flex;flex-direction:column;align-items:center;gap:8px}.sz .caps{letter-spacing:.04em}
.note{color:var(--muted);font-size:13px}.dark .note,.blue .note{color:inherit;opacity:.75}
section{margin-top:40px}
.shell{display:flex;align-items:center;gap:12px;padding:4px;width:260px}
.shell .name{display:block;font-size:17px;font-weight:800;letter-spacing:-.01em;line-height:1.2}
.shell .ctx{display:block;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.tab{display:inline-flex;align-items:center;gap:8px;background:var(--block);border:1px solid var(--border);border-bottom:0;border-radius:12px 12px 0 0;padding:8px 14px;font-size:12px;font-weight:600;color:var(--ink)}
.tabbar{background:var(--active);border-radius:12px;padding:8px 8px 0;width:100%}
.phone{display:flex;flex-direction:column;align-items:center;gap:6px;font-size:11px;font-weight:600}
.apps{display:grid;grid-template-columns:repeat(4,56px);gap:18px;justify-content:center;padding:12px;background:var(--active);border-radius:20px}
.apps .ph{width:56px;height:56px;border-radius:14px;background:var(--border)}
ul{margin:0;padding-left:18px}li{margin:2px 0}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13px}.kv b{font-weight:700}
.chip{display:inline-flex;align-items:center;border-radius:999px;padding:2px 10px;font-size:11px;font-weight:700;background:color-mix(in srgb,var(--primary) 14%,transparent);border:1px solid color-mix(in srgb,var(--primary) 32%,transparent);color:var(--primary-dim)}
.chip.rec{background:color-mix(in srgb,#74a277 14%,transparent);border-color:color-mix(in srgb,#74a277 32%,transparent);color:#3c6842}
code{font-family:ui-monospace,Consolas,monospace;font-size:12px;background:var(--divider);padding:1px 5px;border-radius:6px}
svg{display:block;flex:none}
</style></head><body><div class="wrap">

<header>
  <span class="caps">SuperApp6 · фирменный знак · концепт «Кольцо‑6»</span>
  <h1 style="margin-top:6px">Один знак на всё семейство</h1>
  <p class="lead">Имя семейства — SuperApp6, SuperAIAgent6, SuperTerminal6 — объединяет цифра. Знак — геометрическая «6»: чаша — это круг, Окружение
  человека; точка внутри — сам человек, один <code>user_id</code> на жизнь и работу; хвост уходит вверх — рост, выход наружу, к бизнесу.
  Штрих одной толщины со скруглёнными концами, как иконки Phosphor Light; цвета — только из палитры Organic Bento.</p>
</header>

<section>
  <div class="grid">
    <div class="card c4"><span class="caps">Знак · на блоке</span><div class="stage">${inl(mark(C.primary), 192, 192)}</div></div>
    <div class="card c4 blue"><span class="caps">Знак · плитка приложения</span><div class="stage">${inl(tile({ bg: 'none', fg: C.onPrimary }), 192, 192)}</div></div>
    <div class="card c4 dark"><span class="caps">Знак · на тёмном</span><div class="stage">${inl(mark(C.primary), 192, 192)}</div></div>
    <div class="card c4"><span class="caps">Построение</span><div class="stage">${inl(construction(), 192, 192)}</div>
      <p class="note">Чаша — окружность r14 в квадрате 64; хвост — дуга r26 с центром на оси чаши, поэтому в точке стыка касательные совпадают и штрих идёт без излома. Толщина штриха 7/64 ≈ 11 %, концы круглые.</p></div>
    <div class="card c4"><span class="caps">Штриховая версия · крупные поверхности</span><div class="stage">${inl(tickMark({ id: 'tkA' }), 192, 192)}</div>
      <p class="note">Фирменный tick‑паттерн (штрихи 2 px с шагом 5 px) внутри знака — для сплэша, обложек, пустых состояний. Не для размеров меньше 96 px.</p></div>
    <div class="card c4"><span class="caps">Монохром</span><div class="stage" style="gap:24px">${inl(mark(C.ink), 120, 120)}${inl(mark(C.muted, { dot: 0 }), 120, 120)}</div>
      <p class="note">Одноцветная версия — <code>currentColor</code>: чернила, серый, белый. Без точки — только когда высота меньше 24 px.</p></div>
  </div>
</section>

<section>
  <h2>Словесный знак</h2>
  <p class="lead">В имени цифра — это сам знак: «SuperApp» набран Manrope 800 с трекингом −0.02em, «6» — геометрическая, всегда синяя. Так же строятся имена семейства.</p>
  <div class="grid">
    <div class="card c8"><span class="caps">SuperApp6 · основной</span><div class="stage left">${fit(files['superapp6-wordmark.svg'], 72)}</div></div>
    <div class="card c4 dark"><span class="caps">на тёмном</span><div class="stage left">${fit(files['superapp6-wordmark-dark.svg'], 44)}</div></div>
    <div class="card c4"><span class="caps">SuperApp6 Business</span><div class="stage left">${fit(files['superapp6-business.svg'], 36)}</div></div>
    <div class="card c4"><span class="caps">SuperAIAgent6</span><div class="stage left">${fit(files['superaiagent6.svg'], 36)}</div></div>
    <div class="card c4"><span class="caps">SuperTerminal6</span><div class="stage left">${fit(files['superterminal6.svg'], 36)}</div></div>
  </div>
</section>

<section>
  <h2>Лок‑апы</h2>
  <div class="grid">
    <div class="card c8"><span class="caps">Горизонтальный · плитка + имя (шапка приложения, письма, документы)</span><div class="stage left">${fit(files['superapp6-logo.svg'], 64)}</div></div>
    <div class="card c4"><span class="caps">Вертикальный · сплэш, визитка</span><div class="stage">${fit(files['superapp6-logo-stacked.svg'], 150)}</div></div>
    <div class="card c4 dark"><span class="caps">Горизонтальный на тёмном</span><div class="stage left">${fit(files['superapp6-logo-dark.svg'], 48)}</div></div>
    <div class="card c8"><span class="caps">Охранное поле и минимальный размер</span>
      <div class="stage left" style="gap:32px;flex-wrap:wrap">
        <svg width="160" height="160" viewBox="0 0 96 96"><rect x="0.5" y="0.5" width="95" height="95" fill="none" stroke="${C.line}" stroke-dasharray="2 2"/><rect x="16" y="16" width="64" height="64" fill="none" stroke="${C.line}"/><g transform="translate(16 16)">${ringSix({ color: C.primary })}</g><g transform="translate(16 16) scale(0.25)">${ringSix({ color: C.gradMid })}</g></svg>
        <div class="kv"><b>Охранное поле</b><span>= ширине чаши / 2 (14/64 от высоты знака) со всех сторон — показано пунктиром; в нём ничего не размещать.</span>
        <b>Минимум</b><span>знак 16 px (без точки), словесный знак 20 px высоты, штриховая версия 96 px.</span>
        <b>Не делать</b><span>не наклонять, не менять толщину штриха, не растягивать, не красить в цвета статусов, не ставить тень.</span></div>
      </div></div>
  </div>
</section>

<section>
  <h2>В интерфейсе</h2>
  <div class="grid">
    <div class="card c6"><span class="caps">Размеры</span><div class="row" style="padding:8px 0">
      ${sizes.map((s) => `<div class="sz">${inl(s < 24 ? tile({ dot: 0, sw: 8, scale: 0.9 }) : tile(), s, s)}<span class="caps">${s}</span></div>`).join('')}
    </div><div class="row" style="padding:8px 0">
      ${sizes.map((s) => `<div class="sz">${inl(mark(C.primary, s < 24 ? { dot: 0, sw: 8 } : {}), s, s)}<span class="caps">${s}</span></div>`).join('')}
    </div><p class="note">Плитка и голый знак. До 24 px точка убирается, штрих чуть толще (8/64), иначе чаша забивается.</p></div>
    <div class="card c6"><span class="caps">Шапка приложения · как сейчас, со знаком вместо буквы «S»</span>
      <div class="stage left" style="flex-direction:column;align-items:flex-start;gap:20px">
        <div class="shell">${inl(tile(), 40, 40)}<div><span class="name">SuperApp6</span><span class="ctx">Личное</span></div></div>
        <div class="tabbar"><span class="tab">${inl(tile({ dot: 0, sw: 8, scale: 0.9 }), 16, 16)} SuperApp6 — Задачи</span></div>
        <div class="phone"><div class="apps"><div class="ph"></div>${inl(tile(), 56, 56)}<div class="ph"></div><div class="ph"></div></div><span>иконка на телефоне</span></div>
      </div></div>
  </div>
</section>

<section>
  <h2>Альтернативы, которые рассматривались</h2>
  <div class="grid">
    <div class="card c6"><div style="display:flex;justify-content:space-between;align-items:center"><span class="caps">Б · «Бенто‑6»</span><span class="chip">альтернатива</span></div>
      <div class="stage" style="gap:24px">${inl(bentoSix(), 128, 128)}${inl(bentoSix({ bg: C.primary, cell: 'rgba(255,255,255,.42)', accent: C.onPrimary, border: C.primary }), 128, 128)}</div>
      <p class="note">Шесть блоков бенто, один — синий («ты среди сервисов»). Буквально про Organic Bento и «100+ сервисов», но читается как обычная иконка дашборда и не несёт имени — цифру приходится считать.</p></div>
    <div class="card c6"><div style="display:flex;justify-content:space-between;align-items:center"><span class="caps">В · «Пересечение»</span><span class="chip">альтернатива</span></div>
      <div class="stage" style="gap:24px">${inl(overlapMark({ id: 'ovA' }), 128, 128)}${inl(overlapMark({ id: 'ovB', ink: C.onPrimary, accent: C.onPrimary, bg: C.primary }), 128, 128)}</div>
      <p class="note">Круг (жизнь) и скруглённый квадрат (бизнес), общая часть — синяя: одна личность на оба мира. Точно про позиционирование, но «два пересечения» — приём Mastercard/Meta, узнаваемость слабее, и в 16 px превращается в пятно.</p></div>
    <div class="card c12 page"><div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span class="chip rec">рекомендация</span><b>А · «Кольцо‑6»</b><span class="note">— единственный из трёх, кто одновременно несёт имя (цифра семейства), смысл (человек в своём Окружении) и остаётся читаемым в 16 px одним штрихом.</span></div></div>
  </div>
</section>

<section>
  <h2>Файлы</h2>
  <div class="card c12"><div class="kv" style="grid-template-columns:auto 1fr">
    ${Object.keys(files).map((f) => `<code>${f}</code><span>${{
      'superapp6-mark.svg': 'знак, синий на прозрачном', 'superapp6-mark-mono.svg': 'знак, currentColor', 'superapp6-mark-tile.svg': 'плитка приложения (иконка, шапка)',
      'superapp6-favicon.svg': 'favicon — без точки, штрих толще', 'superapp6-mark-ticks.svg': 'штриховая версия', 'superapp6-wordmark.svg': 'словесный знак', 'superapp6-wordmark-dark.svg': 'словесный знак на тёмном',
      'superapp6-wordmark-mono.svg': 'словесный знак, currentColor', 'superapp6-logo.svg': 'горизонтальный лок‑ап', 'superapp6-logo-dark.svg': 'горизонтальный на тёмном', 'superapp6-logo-stacked.svg': 'вертикальный лок‑ап',
      'superapp6-business.svg': 'SuperApp6 Business', 'superaiagent6.svg': 'SuperAIAgent6', 'superterminal6.svg': 'SuperTerminal6', 'alt-bento.svg': 'альтернатива Б', 'alt-overlap.svg': 'альтернатива В',
    }[f]}</span>`).join('')}
  </div><p class="note" style="margin-top:8px">Все файлы — чистый SVG, текст переведён в кривые (Manrope 800), шрифт не нужен. Папка: <code>design-reference/brand/</code>.</p></div>
</section>

</div></body></html>`;
fs.writeFileSync(path.join(OUT, 'showcase.html'), html);
const m6 = fontFor(800).layout('6').glyphs[0].path.bbox;
console.log('written', Object.keys(files).length + 1, 'files to', OUT, '| Manrope 800 "6" bbox:', JSON.stringify(m6), '| cap', fontFor(800).capHeight);
