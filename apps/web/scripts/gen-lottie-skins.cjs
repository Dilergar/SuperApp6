/* eslint-disable */
// Generates real, looping Lottie (bodymovin) effect assets for the seed skins into
// apps/web/public/skins/. Run: node scripts/gen-lottie-skins.cjs
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'skins');
fs.mkdirSync(OUT, { recursive: true });

const W = 200, H = 200, FR = 30, OP = 90;
const rgb = (r, g, b) => [r / 255, g / 255, b / 255, 1];
const stat = (k) => ({ a: 0, k });
const ease = { i: { x: [0.5], y: [0.5] }, o: { x: [0.5], y: [0.5] } };
function kf(arr) {
  return { a: 1, k: arr.map(([t, s], i) => (i < arr.length - 1 ? { t, s, ...ease } : { t, s })) };
}
function layer(ind, nm, shapes, ks, st = 0) {
  return { ddd: 0, ind, ty: 4, nm, sr: 1, ks, ao: 0, shapes, ip: 0, op: OP, st, bm: 0 };
}
function ellipse(size, color) {
  return { ty: 'gr', it: [
    { ty: 'el', d: 1, p: stat([0, 0]), s: stat([size, size]) },
    { ty: 'fl', c: stat(color), o: stat(100), r: 1 },
    { ty: 'tr', p: stat([0, 0]), a: stat([0, 0]), s: stat([100, 100]), r: stat(0), o: stat(100) },
  ] };
}
function rectStroke(size, radius, color, width) {
  return { ty: 'gr', it: [
    { ty: 'rc', d: 1, p: stat([0, 0]), s: stat([size, size]), r: stat(radius) },
    { ty: 'st', c: stat(color), o: stat(100), w: stat(width), lc: 2, lj: 2 },
    { ty: 'tr', p: stat([0, 0]), a: stat([0, 0]), s: stat([100, 100]), r: stat(0), o: stat(100) },
  ] };
}
const comp = (layers) => ({ v: '5.7.4', fr: FR, ip: 0, op: OP, w: W, h: H, ddd: 0, assets: [], layers, nm: 'skin' });
const write = (name, data) => { fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(data)); console.log('✓', name + '.json'); };

// --- Petals: pink ellipses drifting down + rotating, fading in/out ---
{
  const colors = [rgb(244, 168, 196), rgb(255, 208, 224), rgb(230, 140, 170)];
  const N = 7, layers = [];
  for (let i = 0; i < N; i++) {
    const x = 18 + i * (164 / N);
    const sz = 8 + (i % 3) * 4;
    const r0 = (i * 47) % 360;
    layers.push(layer(i + 1, 'p' + i, [ellipse(sz, colors[i % 3])], {
      o: kf([[0, [0]], [10, [80]], [70, [80]], [90, [0]]]),
      r: kf([[0, [r0]], [90, [r0 + 200]]]),
      p: kf([[0, [x, -20]], [90, [x + (i % 2 ? 22 : -16), 220]]]),
      a: stat([0, 0, 0]),
      s: stat([100, 100, 100]),
    }, -((i * 13) % OP)));
  }
  write('petals', comp(layers));
}

// --- Neon: concentric rounded-rect strokes pulsing out of phase ---
{
  const conf = [
    { sz: 150, col: rgb(54, 249, 246), w: 6 },
    { sz: 118, col: rgb(255, 61, 242), w: 5 },
    { sz: 88, col: rgb(54, 249, 246), w: 4 },
  ];
  const layers = conf.map((c, i) => layer(i + 1, 'n' + i, [rectStroke(c.sz, 26, c.col, c.w)], {
    o: kf([[0, [25]], [45, [100]], [90, [25]]]),
    r: stat(0),
    p: stat([100, 100, 0]),
    a: stat([0, 0, 0]),
    s: kf([[0, [94, 94, 100]], [45, [106, 106, 100]], [90, [94, 94, 100]]]),
  }, -(i * 15)));
  write('neon', comp(layers));
}

// --- Sparkle: twinkling dots (scale + opacity), staggered ---
{
  const pts = [[40, 50], [150, 40], [100, 90], [60, 140], [160, 130], [30, 110], [120, 160], [90, 30]];
  const layers = pts.map((p, i) => layer(i + 1, 's' + i, [ellipse(8, i % 2 ? rgb(255, 255, 255) : rgb(120, 230, 255))], {
    o: kf([[0, [0]], [15, [95]], [30, [0]], [90, [0]]]),
    r: stat(0),
    p: stat([p[0], p[1], 0]),
    a: stat([0, 0, 0]),
    s: kf([[0, [20, 20, 100]], [15, [100, 100, 100]], [30, [20, 20, 100]], [90, [20, 20, 100]]]),
  }, -((i * 11) % OP)));
  write('sparkle', comp(layers));
}

console.log('✅ Lottie skin effects generated →', OUT);
