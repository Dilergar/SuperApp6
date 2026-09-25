/* Генератор концептов знака «№6 — падающая звезда рисует шестёрку».
   Запуск: node design-reference/brand/gen-star6.cjs
   Выход (рядом со скриптом): 9 SVG (3 концепта × знак / словесный знак «№6» / иконка),
   concepts.json (всё описание + SVG строками) и showcase-star6.html (витрина; showcase.html рядом — витрина «Кольца‑6», не трогать).
   Генератор — единственный источник правды: SVG и витрина руками не правятся. */
const fs = require('fs');
const path = require('path');

const OUT = __dirname;

// Палитра — только DESIGN.md, ничего нового.
const C = {
  page: '#eae6de', block: '#fafbf8', ink: '#1d1b1d', muted: '#6b655e', border: '#e2dccf',
  primary: '#588cd3', primaryDim: '#3f6aa8', white: '#ffffff', gold: '#d6a04c', line: '#ddd6c8',
};

// ---------- геометрия ----------
const r2 = (v) => Math.round(v * 100) / 100;
const pt = (x, y) => ({ x, y });
const add = (a, b) => pt(a.x + b.x, a.y + b.y);
const sub = (a, b) => pt(a.x - b.x, a.y - b.y);
const mul = (a, k) => pt(a.x * k, a.y * k);
const len = (a) => Math.hypot(a.x, a.y);
const unit = (a) => mul(a, 1 / len(a));
const rad = (d) => (d * Math.PI) / 180;
// Экранные градусы: 0° — вправо, 90° — вниз (6 часов), 180° — влево, 270° — вверх (12 часов)
const polar = (c, r, deg) => pt(c.x + r * Math.cos(rad(deg)), c.y + r * Math.sin(rad(deg)));
const f = (p) => `${r2(p.x)} ${r2(p.y)}`;
const smoothstep = (t) => t * t * (3 - 2 * t);

/** Гладкая кривая через точки (квадратичные сплайны через середины). Текущая точка = pts[0]. */
function through(pts) {
  let d = '';
  for (let i = 1; i < pts.length - 1; i++) d += `Q${f(pts[i])} ${f(mul(add(pts[i], pts[i + 1]), 0.5))}`;
  return d + `L${f(pts[pts.length - 1])}`;
}

/** Штрих переменной толщины вдоль центральной линии center(t), t∈[0,1] → замкнутый контур.
    Так рисуется след звезды: волосок в начале, полная толщина у головы. */
function taper(center, width, { n = 48, capStart = 'round', capEnd = 'flat' } = {}) {
  const L = [], R = [], T = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const e = 1e-4;
    const tan = unit(sub(center(Math.min(1, t + e)), center(Math.max(0, t - e))));
    const nrm = pt(-tan.y, tan.x);
    const c = center(t);
    const h = width(t) / 2;
    L.push(add(c, mul(nrm, h)));
    R.push(sub(c, mul(nrm, h)));
    T.push(tan);
  }
  // Полукруглый торец: направление дуги — через точку «впереди» торца
  const cap = (from, to, c, dir, r) => {
    const F = add(c, mul(dir, r));
    const cr = (F.x - from.x) * (to.y - F.y) - (F.y - from.y) * (to.x - F.x);
    return `A${r2(r)} ${r2(r)} 0 0 ${cr > 0 ? 1 : 0} ${f(to)}`;
  };
  let d = `M${f(L[0])}` + through(L);
  d += capEnd === 'round' ? cap(L[n], R[n], center(1), T[n], width(1) / 2) : `L${f(R[n])}`;
  d += through(R.slice().reverse());
  if (capStart === 'round') d += cap(R[0], L[0], center(0), mul(T[0], -1), width(0) / 2);
  return d + 'Z';
}

/** Четырёхлучевая звезда с вогнутыми гранями (квадратичные кривые). */
function sparkle(c, rt, k, rot = 0) {
  const tip = (i) => polar(c, rt, rot - 90 + i * 90);
  const ctl = (i) => polar(c, k * Math.SQRT2, rot - 45 + i * 90);
  let d = `M${f(tip(0))}`;
  for (let i = 0; i < 4; i++) d += `Q${f(ctl(i))} ${f(tip(i + 1))}`;
  return d + 'Z';
}

function svg(w, h, inner, extra = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r2(w)} ${r2(h)}" width="${r2(w)}" height="${r2(h)}"${extra ? ' ' + extra : ''}>${inner}</svg>`;
}
const tileBg = (bg, rx = 14) => `<rect width="64" height="64" rx="${rx}" fill="${bg}"/>`;
const scaled = (inner, s, cx = 32, cy = 32) =>
  `<g transform="translate(${r2(cx - 32 * s)} ${r2(cy - 32 * s)}) scale(${s})">${inner}</g>`;

// =====================================================================================
// Концепт 1 «Орбита»: звезда падает по прямой и захватывается на орбиту — траектория и есть 6.
// Голова звезды стоит ровно на «6 часах» круга-циферблата.
// =====================================================================================
const K1 = { c: pt(31, 37.5), r: 14.5, sw: 6, alpha: 60, top: 5.5, head: 4.8, gap: 1.6, w0: 1.5 };
const K1_SMALL = { ...K1, sw: 8, r: 13.5, head: 5.6, gap: 1.8, w0: 4.2 };

/** Точки пересечения окружностей (c1,r1) и (c2,r2): [левая, правая] относительно оси c1→c2. */
function cross2(c1, r1, c2, r2_) {
  const d = len(sub(c2, c1));
  const a = (r1 * r1 - r2_ * r2_ + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const u = unit(sub(c2, c1));
  const m = add(c1, mul(u, a));
  const p = pt(-u.y, u.x);
  return [add(m, mul(p, h)), sub(m, mul(p, h))];
}
const sweepAround = (a, b, c) => ((a.x - c.x) * (b.y - c.y) - (a.y - c.y) * (b.x - c.x) > 0 ? 1 : 0);

/** Прямой след, входящий в круг по касательной. Внешняя кромка — ровно касательная к внешнему
    контуру кольца (стык без излома), сужается только внутренняя кромка: от полной толщины у орбиты
    до волоска w0 на кончике. Наклон alpha — к горизонту. */
function wedge(c, r, sw, alpha, top, w0) {
  const th = 180 + (90 - alpha); // точка касания (210° при наклоне 60°)
  const out = polar(pt(0, 0), 1, th);
  const up = pt(Math.cos(rad(alpha)), -Math.sin(rad(alpha)));
  const Qo = polar(c, r + sw / 2, th), Qi = polar(c, r - sw / 2, th);
  const To = add(Qo, mul(up, (Qo.y - top) / Math.sin(rad(alpha))));
  const Ti = sub(To, mul(out, w0));
  const F = add(mul(add(To, Ti), 0.5), mul(up, w0 / 2));
  const cr = (F.x - To.x) * (Ti.y - F.y) - (F.y - To.y) * (Ti.x - F.x);
  return { d: `M${f(Qo)}L${f(To)}A${r2(w0 / 2)} ${r2(w0 / 2)} 0 0 ${cr > 0 ? 1 : 0} ${f(Ti)}L${f(Qi)}Z`, T: To, P: polar(c, r, th) };
}

function orbitGeom(o) {
  const { d: stem, T, P } = wedge(o.c, o.r, o.sw, o.alpha, o.top, o.w0);
  const head = polar(o.c, o.r, 90); // «6 часов» на круге-циферблате
  // Орбита — залитое кольцо с вогнутым «укусом» вокруг головы: зазор держит звезду отдельной
  // даже в одном цвете, без масок.
  const Ro = r2(o.r + o.sw / 2), Ri = r2(o.r - o.sw / 2), q = r2(o.head + o.gap);
  const [oA, oB] = cross2(o.c, Ro, head, q);
  const [iA, iB] = cross2(o.c, Ri, head, q);
  const ring = `M${f(oA)}A${Ro} ${Ro} 0 1 ${sweepAround(oA, oB, o.c) ? 0 : 1} ${f(oB)}` +
    `A${q} ${q} 0 0 ${sweepAround(oB, iB, head)} ${f(iB)}` +
    `A${Ri} ${Ri} 0 1 ${sweepAround(iB, iA, o.c) ? 0 : 1} ${f(iA)}` +
    `A${q} ${q} 0 0 ${sweepAround(iA, oA, head)} ${f(oA)}Z`;
  return { stem, ring, T, P, head };
}
function orbit({ fg = C.primary, star = C.gold, o = K1 } = {}) {
  const g = orbitGeom(o);
  return `<path d="${g.ring}" fill="${fg}"/><path d="${g.stem}" fill="${fg}"/>` +
    `<circle cx="${r2(g.head.x)}" cy="${r2(g.head.y)}" r="${o.head}" fill="${star}"/>`;
}

// =====================================================================================
// Концепт 2 «Темірқазық»: метеор разгорается по мере падения (волосок → тяжёлая чаша),
// а внутренний просвет шестёрки — четырёхлучевая звезда (негативное пространство).
// =====================================================================================
const K2 = { c: pt(32, 40.5), R: 17.5, rt: 11, k: 2.1, theta: 180, rs: 36, tipY: 6, w0: 1.3 };
K2.we = K2.R - K2.rt - 0.4; // стык хвоста = толщина стенки на западном луче: хвост не заходит в просвет
const K2_SMALL = { ...K2, rt: 9, k: 2.6, w0: 4, we: 17.5 - 9 - 0.4 };

function polarisGeom(o) {
  const v = polar(pt(0, 0), 1, o.theta);
  const Pe = add(o.c, mul(v, o.R - o.we / 2)); // центр штриха в точке стыка
  const Cs = sub(Pe, mul(v, o.rs)); // центр дуги хвоста: внешняя кромка касается чаши изнутри
  const phi0 = 180 - (Math.asin((o.tipY - Cs.y) / o.rs) * 180) / Math.PI;
  const center = (t) => polar(Cs, o.rs, phi0 + (o.theta - phi0) * t);
  const ease = (t) => Math.pow(smoothstep(t), 1.15);
  const stem = taper(center, (t) => o.w0 + (o.we - o.w0) * ease(t), { n: 28 });
  // Чаша: внешний круг + просвет-звезда (evenodd вырезает звезду)
  const ring = `M${f(pt(o.c.x - o.R, o.c.y))}A${o.R} ${o.R} 0 1 0 ${f(pt(o.c.x + o.R, o.c.y))}A${o.R} ${o.R} 0 1 0 ${f(pt(o.c.x - o.R, o.c.y))}Z` +
    sparkle(o.c, o.rt, o.k);
  return { stem, ring, tip: center(0), star: sparkle(o.c, o.rt, o.k) };
}
function polaris({ fg = C.primary, o = K2 } = {}) {
  const g = polarisGeom(o);
  return `<path d="${g.ring}" fill="${fg}" fill-rule="evenodd"/><path d="${g.stem}" fill="${fg}"/>`;
}

// =====================================================================================
// Концепт 3 «N⁶»: знак «№», в котором кружок — это шестёрка, нарисованная падающей звездой.
// Читается как «№», как «№6» и как «N в шестой степени». Черта под кружком — «подвести черту».
// =====================================================================================
// Иерархия: главная — шестёрка. N тоньше (5 против 6.2) и ниже, чаша крупнее и с открытым просветом,
// след поднимается выше N. Черта тоньше обоих, чтобы не спорить с цифрой. Дальше в сторону 6 не сдвигать:
// при чаше больше ~70% роста N знак читается как «N6», а не как «№».
const K3 = {
  sw: 5, n: { x0: 10, x1: 28, top: 23, base: 54.5 },
  six: { c: pt(46, 29), r: 8.6, sw: 6.2, alpha: 62, top: 4, w0: 1.4 },
  bar: { y: 46.5, x0: 38.5, x1: 53.5, sw: 4.4 },
};
const K3_SMALL = {
  sw: 6.4, n: { x0: 10, x1: 27, top: 23, base: 54.5 },
  six: { c: pt(46.5, 29), r: 8.4, sw: 7.6, alpha: 62, top: 5, w0: 3.6 },
  bar: { y: 47, x0: 39, x1: 54, sw: 5.6 },
};
function numeroSix(o) {
  const s = o.six;
  const { d: stem, T } = wedge(s.c, s.r, s.sw, s.alpha, s.top, s.w0);
  return { stem, T };
}
function numero({ n = C.ink, six = C.primary, o = K3 } = {}) {
  const N = o.n;
  const g = numeroSix(o);
  return `<path d="M${N.x0} ${N.base}V${N.top}L${N.x1} ${N.base}V${N.top}" fill="none" stroke="${n}" stroke-width="${o.sw}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="${o.six.c.x}" cy="${o.six.c.y}" r="${o.six.r}" fill="none" stroke="${six}" stroke-width="${o.six.sw}"/>` +
    `<path d="${g.stem}" fill="${six}"/>` +
    `<path d="M${o.bar.x0} ${o.bar.y}H${o.bar.x1}" stroke="${six}" stroke-width="${o.bar.sw}" stroke-linecap="round"/>`;
}

// ---------- словесные знаки «№6» для концептов 1 и 2 ----------
// № рисуется той же геометрией, что и знак: цифра — сам знак, N и кружок — его штрих.
function wordOrbit({ ink = C.ink, fg = C.primary, star = C.gold } = {}) {
  const base = K1.c.y + K1.r + K1.sw / 2 - K1.sw / 2; // низ N = низ орбиты
  const top = 13.5;
  const x0 = 7.5, x1 = 31.5;
  const oc = pt(46.5, 21), orr = 5.6, osw = 5.2;
  const N = `<path d="M${x0} ${r2(base)}V${top}L${x1} ${r2(base)}V${top}" fill="none" stroke="${ink}" stroke-width="${K1.sw}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="${oc.x}" cy="${oc.y}" r="${orr}" fill="none" stroke="${ink}" stroke-width="${osw}"/>` +
    `<path d="M${oc.x - 6.2} 35H${oc.x + 6.2}" stroke="${ink}" stroke-width="${osw}" stroke-linecap="round"/>`;
  const six = `<g transform="translate(51 0)">${orbit({ fg, star })}</g>`;
  return svg(104, 64, N + six);
}
function wordPolaris({ ink = C.ink, fg = C.primary } = {}) {
  const top = K2.c.y - K2.R + 1, base = K2.c.y + K2.R; // высота N = от верха чаши до низа
  const capTop = 15.5;
  const x0 = 6, x1 = 32, ts = 4.2, td = 11.5;
  const N = `<path d="M${x0} ${base}V${capTop}H${x0 + ts}V${base}Z M${x1 - ts} ${base}V${capTop}H${x1}V${base}Z M${x0} ${capTop}H${x0 + td}L${x1} ${base}H${x1 - td}Z" fill="${ink}"/>`;
  const oc = pt(44.5, 23), oR = 7.2, oIn = 3.4;
  const o = `<path d="M${oc.x - oR} ${oc.y}A${oR} ${oR} 0 1 0 ${oc.x + oR} ${oc.y}A${oR} ${oR} 0 1 0 ${oc.x - oR} ${oc.y}Z M${oc.x - oIn} ${oc.y}A${oIn} ${oIn} 0 1 1 ${oc.x + oIn} ${oc.y}A${oIn} ${oIn} 0 1 1 ${oc.x - oIn} ${oc.y}Z" fill="${ink}" fill-rule="evenodd"/>` +
    `<rect x="${oc.x - 7.2}" y="35" width="14.4" height="4.6" fill="${ink}"/>`;
  void top;
  const six = `<g transform="translate(46 0)">${polaris({ fg })}</g>`;
  return svg(101, 64, N + o + six);
}

// ---------- файлы ----------
const files = {
  // Концепт 1
  'n6-orbit-mark.svg': svg(64, 64, orbit()),
  'n6-orbit-wordmark.svg': wordOrbit(),
  'n6-orbit-icon.svg': svg(64, 64, tileBg(C.ink) + scaled(orbit({ fg: C.white, star: C.gold, o: K1_SMALL }), 0.84)),
  // Концепт 2
  'n6-polaris-mark.svg': svg(64, 64, polaris()),
  'n6-polaris-wordmark.svg': wordPolaris(),
  'n6-polaris-icon.svg': svg(64, 64, tileBg(C.primary) + scaled(polaris({ fg: C.white, o: K2_SMALL }), 0.84)),
  // Концепт 3
  'n6-numero-mark.svg': svg(64, 64, numero()),
  'n6-numero-mono.svg': svg(64, 64, numero({ n: C.primary, six: C.primary })),
  'n6-numero-icon.svg': svg(64, 64, tileBg(C.ink) + scaled(numero({ n: C.white, six: C.gold, o: K3_SMALL }), 0.84)),
};

// Одноцветные версии (currentColor) — для проверки «работает в одном цвете»
const mono = {
  orbit: svg(64, 64, orbit({ fg: 'currentColor', star: 'currentColor' })),
  orbitSmall: svg(64, 64, orbit({ fg: 'currentColor', star: 'currentColor', o: K1_SMALL })),
  polaris: svg(64, 64, polaris({ fg: 'currentColor' })),
  polarisSmall: svg(64, 64, polaris({ fg: 'currentColor', o: K2_SMALL })),
  numero: svg(64, 64, numero({ n: 'currentColor', six: 'currentColor' })),
  numeroSmall: svg(64, 64, numero({ n: 'currentColor', six: 'currentColor', o: K3_SMALL })),
};

// =====================================================================================
// Вариации «N⁶» с акцентом на шестёрку. Шесть разных приёмов сделать 6 главной и сохранить «№».
// Цвета: N — чернила, 6 — синий, звезда — золото (всё из DESIGN.md).
// =====================================================================================
const nStroke = (N, sw, color) =>
  `<path d="M${N.x0} ${N.base}V${N.top}L${N.x1} ${N.base}V${N.top}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
/** Шестёрка: кольцо + прямой след по касательной (как в «N⁶»). */
function sixSimple(s, color) {
  const w = wedge(s.c, s.r, s.sw, s.alpha, s.top, s.w0);
  return `<circle cx="${r2(s.c.x)}" cy="${r2(s.c.y)}" r="${s.r}" fill="none" stroke="${color}" stroke-width="${s.sw}"/><path d="${w.d}" fill="${color}"/>`;
}

const ALT = {
  // 1. Гнездо: большая 6, маленькая N сидит в треугольнике между следом и чашей — «ᴺ6».
  nest: ({ n = C.ink, six = C.primary } = {}) =>
    sixSimple({ c: pt(37, 39.5), r: 13, sw: 7, alpha: 60, top: 5, w0: 1.6 }, six) +
    nStroke({ x0: 9, x1: 19, top: 10, base: 24.5 }, 3.4, n),

  // 2. Север: N внутри чаши. N — это «номер» и «север»: звезда пришла с севера, как Темірқазық.
  north: ({ n = C.ink, six = C.primary } = {}) =>
    sixSimple({ c: pt(33, 39.5), r: 15, sw: 6.4, alpha: 62, top: 4.5, w0: 1.5 }, six) +
    nStroke({ x0: 28.4, x1: 37.6, top: 33.8, base: 45.2 }, 3, n),

  // 3. Табличка: адресная табличка «дом №6» — синяя, как уличные таблички Алматы; № мелко в углу.
  plate: ({ bg = C.primary, fg = C.white } = {}) => {
    const o = pt(23.4, 13.2);
    return `<rect width="64" height="64" rx="13" fill="${bg}"/>` +
      `<rect x="4.5" y="4.5" width="55" height="55" rx="9" fill="none" stroke="${fg}" stroke-width="1.4"/>` +
      nStroke({ x0: 11.5, x1: 18.5, top: 10.5, base: 19.8 }, 2.4, fg) +
      `<circle cx="${o.x}" cy="${o.y}" r="2.1" fill="none" stroke="${fg}" stroke-width="1.7"/>` +
      `<path d="M${r2(o.x - 2.5)} 17.9H${r2(o.x + 2.5)}" stroke="${fg}" stroke-width="1.7" stroke-linecap="round"/>` +
      sixSimple({ c: pt(35.5, 39), r: 11.6, sw: 6.8, alpha: 60, top: 9.5, w0: 1.8 }, fg);
  },

  // 4. Контур: N — полая линия (след, который уже остыл), шестёрка — сплошная масса (звезда горит).
  // Полость вырезает маска, поэтому знак работает на любом фоне и в одном цвете.
  outline: ({ n = C.ink, six = C.primary } = {}) => {
    const d = 'M10 54.5V23L28 54.5V23';
    const id = 'n6-outline-hole';
    return `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#fff"/>` +
      `<path d="${d}" fill="none" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></mask>` +
      `<path d="${d}" fill="none" stroke="${n}" stroke-width="6.6" stroke-linecap="round" stroke-linejoin="round" mask="url(#${id})"/>` +
      sixSimple({ c: pt(46, 29), r: 8.6, sw: 6.8, alpha: 62, top: 4, w0: 1.5 }, six) +
      `<path d="M38.5 46.5H53.5" stroke="${six}" stroke-width="4.4" stroke-linecap="round"/>`;
  },

  // 5. Горизонт: шестёрка-орбита, золотая звезда на «6 часах» садится на черту знака №.
  horizon: ({ n = C.ink, six = C.primary, star = C.gold } = {}) =>
    nStroke({ x0: 9.5, x1: 27, top: 23, base: 54.5 }, 4.8, n) +
    orbit({ fg: six, star, o: { c: pt(45.5, 26), r: 8.6, sw: 5.6, alpha: 62, top: 3.5, head: 3.7, gap: 1.3, w0: 1.4 } }) +
    `<path d="M37.5 44H53.5" stroke="${six}" stroke-width="3.8" stroke-linecap="round"/>`,

  // 6. Сплав: правый штамб N — это след шестёрки. N дописывается шестёркой, 6 — единственный целый глиф.
  fusion: ({ n = C.ink, six = C.primary } = {}) => {
    const s = { c: pt(40.5, 44), r: 9, sw: 6.4, alpha: 66, top: 5, w0: 1.6 };
    const P = polar(s.c, s.r, 180 + (90 - s.alpha));
    return `<path d="M11 54.5V12L${f(P)}" fill="none" stroke="${n}" stroke-width="5.2" stroke-linecap="round" stroke-linejoin="round"/>` +
      sixSimple(s, six);
  },
};
const ALT_META = [
  ['nest', 'Гнездо', 'Маленькая N сидит в треугольнике между следом и чашей: «ᴺ6». Шестёрка целиком главная, N — её подпись.'],
  ['north', 'Север', 'N внутри чаши. N — «номер» и «север» на компасе: звезда пришла с севера, как Темірқазық.'],
  ['plate', 'Табличка', 'Адресная табличка «дом №6», синяя, как уличные таблички Алматы. Один адрес для всего; № мелко в углу.'],
  ['outline', 'Контур', 'N — полая линия, как остывший след; шестёрка — сплошная масса, звезда ещё горит. Акцент держит заливка, а не размер.'],
  ['horizon', 'Горизонт', 'Шестёрка-орбита: золотая звезда на «6 часах» садится на черту знака №, как на горизонт степи.'],
  ['fusion', 'Сплав', 'Правый штамб N — это след шестёрки. N дописывается шестёркой, а 6 — единственный целый глиф.'],
];

// Вариации «N⁶» с акцентом на шестёрку — отдельные файлы, в concepts.json не входят
const altDark = (id) => (id === 'plate'
  ? ALT.plate({ bg: C.ink })
  : tileBg(C.ink) + scaled(ALT[id](id === 'horizon' ? { n: C.white, six: C.primary, star: C.gold } : { n: C.white, six: C.gold }), 0.84));
for (const [id] of ALT_META) files[`n6-numero-alt-${id}.svg`] = svg(64, 64, ALT[id]());



// ---------- раскрытие пасхалок (только для витрины) ----------
function revealOrbit() {
  const o = K1;
  const Ro = o.r + o.sw / 2;
  let ticks = '';
  for (let h = 0; h < 12; h++) {
    const deg = 270 + h * 30;
    if (h === 0 || h === 6 || h === 10 || h === 11) continue; // 6 — сама звезда; 10–12 — там идёт след
    const long = h % 3 === 0;
    const a = polar(o.c, Ro + 2.4, deg), b = polar(o.c, Ro + (long ? 5.6 : 4.2), deg);
    ticks += `<path d="M${f(a)}L${f(b)}" stroke="${C.muted}" stroke-width="${long ? 1 : 0.7}" stroke-linecap="round"/>`;
  }
  const lab = (t, deg, color = C.muted, w = 700) => {
    const p = polar(o.c, Ro + 10, deg);
    return `<text x="${r2(p.x)}" y="${r2(p.y + 2)}" font-family="Manrope,sans-serif" font-size="5.6" font-weight="${w}" fill="${color}" text-anchor="middle">${t}</text>`;
  };
  const six = polar(o.c, o.r + o.head + 7.5, 90);
  return svg(80, 80, `<g transform="translate(8 6)">${ticks}${lab('3', 0)}${lab('9', 180)}${orbit()}` +
    `<text x="${r2(six.x)}" y="${r2(six.y + 2)}" font-family="Manrope,sans-serif" font-size="6.4" font-weight="800" fill="${C.gold}" text-anchor="middle">6</text></g>`);
}
function revealPolaris() {
  const g = polarisGeom(K2);
  return svg(64, 64, `<path d="${g.ring}" fill="${C.line}" fill-rule="evenodd"/><path d="${g.stem}" fill="${C.line}"/><path d="${g.star}" fill="${C.gold}"/>`);
}

// ---------- содержание: одно на JSON и витрину ----------
const TOKENS = [
  { token: '--primary', hex: C.primary, role: 'бренд-акцент DESIGN.md: шестёрка, след, орбита' },
  { token: '--grad-mid', hex: C.gold, role: 'тёплое золото DESIGN.md: звезда («алты» → «алтын»)' },
  { token: '--on-surface', hex: C.ink, role: 'чернила: N, ночная плитка' },
  { token: '--surface-container-lowest', hex: C.block, role: 'светлый фон знака' },
  { token: 'белый', hex: C.white, role: 'знак на тёмной и синей плитке' },
];
const ANALYSIS = {
  name: [
    '«№» — лигатура латинских N и o (numero — «числом»). Кружок в нём — буква o, в кириллической типографике его часто подчёркивают чертой.',
    '«6» — единственная цифра, которая одним росчерком приходит снаружи и замыкается в круг внутри себя. Это и есть экосистема: пришёл — и уходить больше не нужно.',
    '6 — первое совершенное число: 1 + 2 + 3 = 6, и 1 × 2 × 3 = 6. Сумма частей равна целому, без остатка. Для бренда «без полумер» это определение, а не натяжка.',
    'Каз. «алты» (шесть) на одну букву отстоит от «алтын» (золото), поэтому звезда в знаке золотая.',
    'Перевёрнутая 6 — это 9. В каждом концепте направление задаёт след: звезда падает сверху, значит, это шестёрка.',
  ],
  keep: ['след болида: волосок → полная толщина', 'бенгальский огонь: цифру пишут в воздухе, звезда на конце линии', 'орбита: захват, из которого не уходят', 'Темірқазық: неподвижная звезда степи', 'циферблат: круг, на котором есть «шесть»', '«подвести черту»: черта под º'],
  drop: ['шестерёнка, шестиугольник, соты — банально', 'шестиконечная звезда — религиозный символ', 'пятиконечная — советская и военная', 'ракета и глобус — клише', '✦ как отдельный значок — стал «кнопкой ИИ»; здесь он только в пустоте', 'шаңырақ внутри чаши — рисует прицел'],
};
const CONCEPTS = [
  {
    id: 'orbit', no: '01', name: 'Орбита',
    idea: 'Падающие звёзды сгорают, а эта вышла на орбиту: её траектория и есть шестёрка.',
    elements: [
      ['Прямой сужающийся след, 60°', 'падение: человек приходит из мира десятков разрозненных сервисов; толщина растёт — звезда набирает силу'],
      ['Кольцо ровной толщины', 'орбита, замкнутый контур экосистемы. След меняет толщину, орбита не меняет никогда: хаос снаружи, устойчивость внутри'],
      ['Золотая голова', 'сам человек: один аккаунт и один user_id на всё'],
      ['Зазор вокруг головы', 'звезда не приварена к системе, она движется. Кроме того, так знак работает в одном цвете'],
    ],
    egg: {
      what: 'Круг — это циферблат, и звезда стоит ровно на «6 часах». Шестёрка показывает шесть.',
      where: 'Голова звезды в нижней точке кольца, на 90° от центра',
      why: 'Цифра бренда закодирована второй системой счёта: кто однажды увидел часы, видит их всегда. Вторая, тихая отсылка: первая орбита человечества (Спутник, 1957; Гагарин, 1961) стартовала из казахской степи, с Байконура.',
    },
    font: '№ нарисован тем же моноштрихом, что и знак (N и º — геометрия генератора). Подписи в суб-брендах набираются Manrope 700–800: это шрифт продукта, в нём есть кириллица и казахские буквы (cyrillic-ext).',
    colors: 'Синий #588cd3 для орбиты и следа, золото #d6a04c для звезды, ночная плитка #1d1b1d для иконки: звезду видно ночью.',
    checks: {
      size16: 'Иконка перерисована под мелкий размер: след от 4.2/64, голова 5.6/64. На 16 px читается «6» с точкой.',
      oneColor: 'Работает благодаря зазору: голова остаётся отдельной фигурой без второго цвета.',
      unwanted: '«Лупа» (кольцо + прямая) снята: прямая касательная, а не радиальная, и длиннее кольца. «Кольцо с камнем» допустимо.',
    },
    variants: [
      { file: 'n6-orbit-mark.svg', purpose: 'Знак: цвет, прозрачный фон' },
      { file: 'n6-orbit-wordmark.svg', purpose: 'Словесный знак «№6»' },
      { file: 'n6-orbit-icon.svg', purpose: 'Иконка приложения и favicon: ночная плитка, мелкая оптика' },
    ],
  },
  {
    id: 'polaris', no: '02', name: 'Темірқазық',
    idea: 'Метеор разгорается по мере падения и прячет звезду внутри шестёрки: просвет чаши — четырёхлучевая звезда.',
    elements: [
      ['Волосяной росчерк → тяжёлая чаша', 'метеор ярче всего в конце пути. Это росчерк без отрыва пера: знак сделан одной рукой'],
      ['Круглая чаша', 'всё в одном: один круг вместо десятков приложений'],
      ['Просвет-звезда', 'Темірқазық («железный кол»), Полярная звезда: по ней кочевники держали путь, вокруг неё вращается небо. Для бренда это неподвижная планка качества'],
      ['Лучи по сторонам света', 'компас: сервис ведёт человека, а не наоборот'],
      ['Контраст волоска и массы', 'дидонная классика, премиальность, «отполировано»'],
    ],
    egg: {
      what: 'Внутренняя пустота шестёрки — звезда. Сначала видишь жирную 6, потом понимаешь, что дырка в ней звёздная.',
      where: 'Негативное пространство чаши; лучи смотрят строго на север, восток, юг и запад',
      why: 'Звезда упала и осталась внутри: в каждом продукте №6 есть звезда. Её не рисовали, её вырезали, так что она светится цветом фона на любой поверхности.',
    },
    font: '№ в словесном знаке дидонный: тонкие штамбы N и тяжёлая диагональ повторяют контраст знака. Подписи — Manrope 800.',
    colors: 'Сплошной синий #588cd3. На плитке белая шестёрка на синем, и звезда светится синим. Второй цвет не нужен: звезда сделана из пустоты.',
    checks: {
      size16: 'В иконке хвост утолщён до 4/64, просвет упрощён. На 16 px читается «6» с отверстием.',
      oneColor: 'Одноцветный по природе: звезда — это отсутствие краски.',
      unwanted: 'Главный риск силуэта «круг + сужающийся хвост» — «головастик». Его снимают открытый просвет-звезда и хвост, уходящий вверх, а не назад. На 16 px использовать только иконку.',
    },
    variants: [
      { file: 'n6-polaris-mark.svg', purpose: 'Знак: цвет, прозрачный фон' },
      { file: 'n6-polaris-wordmark.svg', purpose: 'Словесный знак «№6» (дидонный №)' },
      { file: 'n6-polaris-icon.svg', purpose: 'Иконка приложения и favicon: синяя плитка, мелкая оптика' },
    ],
  },
  {
    id: 'numero', no: '03', name: 'N⁶',
    idea: 'Знак номера, в котором кружок — шестёрка, нарисованная падающей звездой: «№» и «6» в одном символе.',
    elements: [
      ['N', '«номер»: система имён Shop №6, Wear №6, Brand №6. Нарисована тоньше и ниже шестёрки: это рамка, а не герой'],
      ['Кружок º = чаша шестёрки', 'вместо абстрактного кружка стоит цифра бренда. Главная масса знака: штрих тяжелее, чем у N, чаша открытая'],
      ['След из-за верхней кромки', 'звезда приходит «с неба», выше роста N: падение видно по направлению'],
      ['Черта под кружком', 'традиция кириллического «№» и «подвести черту»: сделано до конца'],
    ],
    egg: {
      what: 'Тройное прочтение: «№» (на 16 px видно именно его), «№6» (кружок — это 6) и «N⁶», то есть N в шестой степени.',
      where: 'Место кружка в знаке номера',
      why: 'Бренд помещается в два глифа. Всё, что носит имя, «возведено в шестую степень» — это про масштаб и отсутствие полумер.',
    },
    font: 'N построен моноштрихом той же толщины, что и 6. В суб-брендах имя набирается Manrope 800, знак стоит справа как «фамилия».',
    colors: 'На светлом: N чернилами #1d1b1d, шестёрка синяя #588cd3. На ночной плитке: белая N, золотая 6 (звезду видно ночью).',
    checks: {
      size16: 'Читается «№» — это и есть префикс бренда. Шестёрку видно от 24 px.',
      oneColor: 'Работает (вариант mono).',
      unwanted: '«N°» (градусы) допустимо и тоже читается как «номер». Прочтение «Nб» гасит черта под кружком: так пишут только №.',
    },
    variants: [
      { file: 'n6-numero-mark.svg', purpose: 'Монограмма «№6»: цвет' },
      { file: 'n6-numero-mono.svg', purpose: 'Монограмма в одном цвете' },
      { file: 'n6-numero-icon.svg', purpose: 'Иконка приложения и favicon: ночная плитка, мелкая оптика' },
    ],
  },
];
const RECOMMEND = {
  pick: 'polaris',
  text: [
    'Рекомендую «Темірқазық». У него самая сильная пасхалка: негативное пространство, которое невозможно развидеть. Она не мешает читать 6, потому что звезда живёт внутри формы, а не рядом с ней.',
    'Он одноцветный по природе. Звезда сделана из пустоты, поэтому знак не зависит от второго цвета, печати или тёмной темы.',
    'Он лучше всех несёт «полируем до идеала»: контраст волоска и массы — язык премиальной типографики. Отсылка к Казахстану (Темірқазық, путь кочевника) несёт смысл, а не орнамент.',
    'Трюк «N⁶» из третьего концепта стоит сохранить как монограмму суб-брендов (Shop №6, Wear №6): он встаёт рядом с любым словом.',
  ],
};

// ---------- concepts.json ----------
const json = {
  brand: '№6',
  brief: 'Падающая звезда рисует цифру 6. Экосистема, B2C + B2B, Казахстан, Алматы; сделано одним человеком; без слов и без «Super App».',
  analysis: ANALYSIS,
  palette: TOKENS,
  generator: 'design-reference/brand/gen-star6.cjs',
  concepts: CONCEPTS.map((c) => ({
    id: c.id, name: c.name, idea: c.idea,
    elements: c.elements.map(([element, meaning]) => ({ element, meaning })),
    easterEgg: c.egg, typography: c.font, colors: c.colors, checks: c.checks,
    variants: c.variants.map((v) => ({ ...v, svg: files[v.file] })),
  })),
  recommendation: RECOMMEND,
};

// ---------- витрина ----------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const fit = (s, cls = '') => s.replace(/^<svg /, `<svg class="${cls}" `).replace(/ width="[^"]+" height="[^"]+"/, '');
const at = (s, px) => s.replace(/ width="[^"]+" height="[^"]+"/, ` width="${px}" height="${px}"`);
const SET = {
  orbit: {
    light: svg(64, 64, orbit()), dark: svg(64, 64, orbit({ fg: C.primary, star: C.gold })), monoInk: mono.orbit.replace(/currentColor/g, C.ink),
    small: svg(64, 64, orbit({ o: K1_SMALL })), reveal: revealOrbit(), word: files['n6-orbit-wordmark.svg'], icon: files['n6-orbit-icon.svg'],
    wordDark: wordOrbit({ ink: C.white, fg: C.primary, star: C.gold }),
  },
  polaris: {
    light: svg(64, 64, polaris()), dark: svg(64, 64, polaris({ fg: C.primary })), monoInk: mono.polaris.replace(/currentColor/g, C.ink),
    small: svg(64, 64, polaris({ o: K2_SMALL })), reveal: revealPolaris(), word: files['n6-polaris-wordmark.svg'], icon: files['n6-polaris-icon.svg'],
    wordDark: wordPolaris({ ink: C.white, fg: C.primary }),
  },
  numero: {
    light: svg(64, 64, numero()), dark: svg(64, 64, numero({ n: C.white, six: C.gold })), monoInk: mono.numero.replace(/currentColor/g, C.ink),
    small: svg(64, 64, numero({ o: K3_SMALL })), reveal: null, word: files['n6-numero-mono.svg'], icon: files['n6-numero-icon.svg'],
    wordDark: svg(64, 64, numero({ n: C.white, six: C.white })), fam: svg(64, 64, numero()),
  },
};
function section(c) {
  const s = SET[c.id];
  const stage = (inner, cls, cap) => `<figure class="cell"><div class="stage ${cls}">${fit(inner)}</div><figcaption>${cap}</figcaption></figure>`;
  const sizes = [128, 64, 48].map((px) => `<span class="sz">${at(s.light, px)}<i>${px}</i></span>`).join('') +
    [32, 24, 16].map((px) => `<span class="sz">${at(s.small, px)}<i>${px}</i></span>`).join('') +
    `<span class="gap"></span>` + [64, 32, 16].map((px) => `<span class="sz">${at(s.icon, px)}<i>${px}</i></span>`).join('');
  const reveal = c.id === 'numero'
    ? `<div class="triple">
        <figure>${fit(svg(64, 64, numero({ n: C.ink, six: C.ink })))}<figcaption>«№»</figcaption></figure>
        <figure>${fit(svg(64, 64, numero({ n: C.line, six: C.primary })))}<figcaption>кружок = 6 → «№6»</figcaption></figure>
        <figure>${fit(svg(64, 64, numero({ n: C.primary, six: C.gold })))}<figcaption>«N⁶»</figcaption></figure></div>`
    : `<div class="stage plain reveal">${fit(s.reveal)}</div>`;
  const family = ['Shop', 'Wear', 'Food'].map((w) => `<div class="fam"><b>${w}</b>${fit(s.fam || s.word, 'famword' + (c.id === 'numero' ? ' sq' : ''))}</div>`).join('');
  return `<section id="${c.id}" class="concept${RECOMMEND.pick === c.id ? ' picked' : ''}">
  <header class="chead"><span class="no">${c.no}</span><div><h2>${esc(c.name)}${RECOMMEND.pick === c.id ? '<span class="chip">рекомендую</span>' : ''}</h2><p class="idea">${esc(c.idea)}</p></div></header>
  <div class="bento">
    ${stage(s.light, 'plain', 'Знак')}${stage(s.dark, 'dark', 'На тёмном')}${stage(s.monoInk, 'plain', 'Один цвет')}${stage(s.icon, 'bare', 'Иконка')}
    <div class="card s4"><div class="label">${c.id === 'numero' ? 'Один цвет: на светлом и на тёмном' : 'Словесный знак'}</div><div class="words"><div class="w light">${fit(s.word, 'wm' + (c.id === 'numero' ? ' sq' : ''))}</div><div class="w darkbg">${fit(s.wordDark, 'wm' + (c.id === 'numero' ? ' sq' : ''))}</div></div></div>
    <div class="card s4"><div class="label">Размеры · знак → мелкая оптика → иконка</div><div class="sizes">${sizes}</div></div>
    <div class="card s2"><div class="label">Пасхалка</div>${reveal}<p><b>${esc(c.egg.what)}</b></p><p class="muted">Где: ${esc(c.egg.where)}.</p><p>${esc(c.egg.why)}</p></div>
    <div class="card s2"><div class="label">Что означает каждый элемент</div><dl>${c.elements.map(([e, m]) => `<dt>${esc(e)}</dt><dd>${esc(m)}</dd>`).join('')}</dl></div>
    <div class="card s2"><div class="label">Шрифт и цвета</div><p>${esc(c.font)}</p><p>${esc(c.colors)}</p>
      <div class="label mt">Проверки</div><dl><dt>16 × 16 px</dt><dd>${esc(c.checks.size16)}</dd><dt>Один цвет</dt><dd>${esc(c.checks.oneColor)}</dd><dt>Нежелательные образы</dt><dd>${esc(c.checks.unwanted)}</dd></dl></div>
    <div class="card s2"><div class="label">В системе имён</div><div class="family">${family}</div></div>
    <div class="card s4 files"><div class="label">Файлы</div>${c.variants.map((v) => `<a href="${v.file}">${v.file}</a><span class="muted">${esc(v.purpose)}</span>`).join('')}</div>
  </div>
</section>`;
}
function altSection() {
  const cards = ALT_META.map(([id, name, idea], i) => {
    const light = svg(64, 64, ALT[id]());
    const dark = svg(64, 64, altDark(id));
    const sizes = [48, 32, 24, 16].map((px) => `<span class="sz">${at(light, px)}<i>${px}</i></span>`).join('') +
      `<span class="gap"></span><span class="sz">${at(dark, 32)}<i>32</i></span><span class="sz">${at(dark, 16)}<i>16</i></span>`;
    return `<div class="card alt"><div class="label">${String(i + 1).padStart(2, '0')} · ${esc(name)}</div>
      <div class="altpair"><div class="stage plain">${fit(light)}</div><div class="stage bare">${fit(dark)}</div></div>
      <p>${esc(idea)}</p><div class="sizes">${sizes}</div><a href="n6-numero-alt-${id}.svg">n6-numero-alt-${id}.svg</a></div>`;
  }).join('');
  return `<section id="numero-alts" class="concept">
  <header class="chead"><span class="no">03+</span><div><h2>«N⁶»: шесть вариаций с акцентом на шестёрке</h2><p class="idea">Та же идея «№ и 6 в одном знаке», но главная — цифра. Каждая вариация добивается этого своим приёмом: вложением, заливкой, общим штрихом, табличкой, золотой звездой.</p></div></header>
  <div class="alts">${cards}</div>
</section>`;
}
const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Знак №6</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--page:${C.page};--block:${C.block};--ink:${C.ink};--muted:${C.muted};--border:${C.border};--primary:${C.primary};--gold:${C.gold};--line:${C.line}}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:15px/1.55 Manrope,system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:40px 16px 96px}
h1{font-size:clamp(30px,5vw,44px);font-weight:800;letter-spacing:-.02em;margin:0 0 6px;line-height:1.1}
h2{font-size:26px;font-weight:800;letter-spacing:-.02em;margin:0;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.lead{color:var(--muted);margin:0 0 28px;max-width:70ch}
.label{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
.label.mt{margin-top:16px}
.muted{color:var(--muted)}
.card{background:var(--block);border:1px solid var(--border);border-radius:20px;padding:20px;min-width:0}
.card p{margin:0 0 10px}
.analysis{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));margin-bottom:48px}
.analysis ol{margin:0;padding-left:20px}.analysis li{margin-bottom:8px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.cols ul{margin:0;padding-left:18px}.cols li{margin-bottom:4px}
.concept{margin:0 0 56px}
.chead{display:flex;gap:16px;align-items:flex-start;margin-bottom:16px}
.no{font-weight:800;color:var(--primary);font-size:15px;padding-top:7px}
.idea{margin:4px 0 0;color:var(--muted);max-width:70ch}
.chip{font-size:12px;font-weight:700;background:var(--primary);color:#fff;border-radius:999px;padding:3px 10px;letter-spacing:0}
.bento{display:grid;gap:12px;grid-template-columns:repeat(4,minmax(0,1fr))}
.s2{grid-column:span 2}.s4{grid-column:span 4}
.cell{margin:0;min-width:0}
.cell figcaption{font-size:12px;color:var(--muted);margin-top:6px;text-align:center}
.stage{display:grid;place-items:center;aspect-ratio:1;border-radius:20px;border:1px solid var(--border)}
.stage.plain{background:var(--block)}.stage.dark{background:var(--ink);border-color:var(--ink)}.stage.bare{background:transparent;border:0}
.stage svg{width:60%;height:auto}.stage.bare svg{width:100%}
.stage.reveal{aspect-ratio:auto;border:0;margin-bottom:12px}.stage.reveal svg{width:min(260px,70%)}
.words{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.w{display:grid;place-items:center;border-radius:14px;padding:28px 16px}.w.light{background:var(--page)}.w.darkbg{background:var(--ink)}
.wm{height:88px;width:auto;max-width:100%}.wm.sq{height:110px}
.sizes{display:flex;align-items:flex-end;gap:22px;flex-wrap:wrap}
.sz{display:flex;flex-direction:column;align-items:center;gap:6px}.sz i{font-style:normal;font-size:11px;color:var(--muted)}
.gap{width:1px;align-self:stretch;background:var(--border);margin:0 4px}
.triple{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}
.triple figure{margin:0;background:var(--page);border-radius:14px;padding:14px;text-align:center}.triple svg{width:100%;height:auto;max-width:110px}
.triple figcaption{font-size:12px;color:var(--muted);margin-top:4px}
dl{margin:0}dt{font-weight:700}dd{margin:0 0 10px;color:var(--muted)}
.family{display:flex;flex-wrap:wrap;gap:12px}
.fam{display:flex;align-items:center;gap:14px;background:var(--page);border-radius:14px;padding:14px 20px}
.fam b{font-size:30px;font-weight:800;letter-spacing:-.02em}.famword{height:40px;width:auto}.famword.sq{height:48px}
.files{display:grid;grid-template-columns:auto 1fr;gap:6px 16px}.files .label{grid-column:span 2}
a{color:var(--primary);font-weight:600;text-decoration:none}a:hover{text-decoration:underline}
.picked .chead h2{color:var(--ink)}
.alts{display:grid;gap:12px;grid-template-columns:repeat(3,minmax(0,1fr))}
.altpair{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}.altpair .stage svg{width:72%}.altpair .stage.bare svg{width:100%}
.alt .sizes{gap:14px;margin-bottom:10px}.alt a{font-size:13px}
@media (max-width:980px){.alts{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:620px){.alts{grid-template-columns:1fr}}
.rec{border:2px solid var(--primary)}
.rec p{max-width:80ch}
@media (max-width:860px){.bento{grid-template-columns:repeat(2,minmax(0,1fr))}.s2,.s4{grid-column:span 2}}
@media (max-width:520px){.words,.cols{grid-template-columns:1fr}.triple{grid-template-columns:1fr 1fr 1fr}}
</style></head><body><main>
<h1>№6: падающая звезда рисует шестёрку</h1>
<p class="lead">Три концепта знака. Вся геометрия вычислена генератором <code>gen-star6.cjs</code>, цвета взяты только из DESIGN.md. Описание и SVG всех вариантов лежат в <a href="concepts.json">concepts.json</a>.</p>
<div class="analysis">
  <div class="card"><div class="label">Разбор имени</div><ol>${ANALYSIS.name.map((t) => `<li>${esc(t)}</li>`).join('')}</ol></div>
  <div class="card"><div class="label">Карта ассоциаций</div><div class="cols"><div><b>Беру</b><ul>${ANALYSIS.keep.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div><div><b>Отбрасываю</b><ul>${ANALYSIS.drop.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div></div>
  <div class="label mt">Палитра (DESIGN.md)</div>${TOKENS.map((t) => `<div style="display:flex;gap:10px;align-items:center;margin-bottom:6px"><span style="width:22px;height:22px;border-radius:6px;background:${t.hex};border:1px solid var(--border);flex:none"></span><span><b>${t.hex}</b> <span class="muted">${esc(t.role)}</span></span></div>`).join('')}</div>
</div>
${CONCEPTS.map(section).join('\n')}
${altSection()}
<div class="card rec"><div class="label">Рекомендация</div>${RECOMMEND.text.map((t) => `<p>${esc(t)}</p>`).join('')}</div>
</main></body></html>`;

module.exports = { C, K1, K2, K3, orbit, polaris, numero, orbitGeom, polarisGeom, numeroSix, files, mono, svg, ALT, ALT_META };

if (require.main === module) {
  for (const [name, s] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), s + '\n');
  fs.writeFileSync(path.join(OUT, 'concepts.json'), JSON.stringify(json, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'showcase-star6.html'), html);
  console.log('written', Object.keys(files).length, 'svg + concepts.json + showcase-star6.html');
}
