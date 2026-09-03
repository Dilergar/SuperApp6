// ============================================================
// Читаемость поверх цвета-ДАННЫХ (скины карточек).
//
// Палитра кита проверена на AA заранее, но скин — это ДАННЫЕ: пару «фон + чернила»
// выбирает автор скина, и она приезжает из БД. Инициалы в аватаре — функциональный
// текст (единственный способ узнать человека без фото), а живые скины давали 3.7:1
// и 4.0:1 при требовании продукта ≥4.5:1.
//
// Здесь НЕ придумывается новый цвет: чернила скина затемняются (или осветляются —
// на тёмном фоне) шагами по 8%, пока пара не пройдёт порог. Нераспознанный формат
// (`var(...)`, oklch, градиент) возвращается как есть — гвард не должен ломать скин,
// который он не понял.
// ============================================================

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function parseHex(c: string): [number, number, number] | null {
  const s = c.trim();
  if (!HEX.test(s)) return null;
  const h = s.slice(1);
  const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

const channel = (v: number): number => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]: [number, number, number]): number =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** Контраст пары по WCAG 2.x (1..21); null — если цвет не разобран */
export function contrastRatio(a: string, b: string): number | null {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return null;
  const la = luminance(ca);
  const lb = luminance(cb);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const toHex = ([r, g, b]: [number, number, number]): string =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

const mix = (c: [number, number, number], target: 0 | 255, k: number): [number, number, number] =>
  [c[0] + (target - c[0]) * k, c[1] + (target - c[1]) * k, c[2] + (target - c[2]) * k];

/**
 * Чернила, читаемые на этом фоне: если пара не добирает `min`, двигаем чернила
 * к чёрному (на светлом фоне) или к белому (на тёмном), пока не добьёмся порога.
 */
export function ensureReadableInk(bg: string, ink: string, min = 4.5): string {
  const bgc = parseHex(bg);
  const inkc = parseHex(ink);
  if (!bgc || !inkc) return ink;
  const current = contrastRatio(bg, ink);
  if (current !== null && current >= min) return ink;
  const target: 0 | 255 = luminance(bgc) > 0.4 ? 0 : 255;
  for (let k = 0.08; k <= 1.0001; k += 0.08) {
    const candidate = toHex(mix(inkc, target, Math.min(k, 1)));
    const ratio = contrastRatio(bg, candidate);
    if (ratio !== null && ratio >= min) return candidate;
  }
  return target === 0 ? '#000000' : '#ffffff';
}
