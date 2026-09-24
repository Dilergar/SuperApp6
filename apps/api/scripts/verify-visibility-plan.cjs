// ============================================================
// Property-based: core/visibility — ЧИСТОЕ решение по полю (`visibility.plan.ts`).
//
// Случайные (правила организации, зритель, отношение к записи, поле реестра) → инварианты,
// на которых держится движок. Любое нарушение печатает минимальный контрпример (fast-check
// ужимает вход) — его и чинить.
//
//   I1  запрет (deny) на любом столбце зрителя → hidden (кроме «сам» с обязательной видимостью)
//   I2  «сам» видит не меньше, чем политика даёт ему как постороннему (self: full);
//       self: hidden → hidden; self: policy → ровно политика
//   I3  MAX по allow: добавить зрителю столбец с разрешением никогда не понижает уровень
//   I4  потолки: класс (restricted ≤ маски не-себе, secret ≤ маски всем и без раскрытия), бот/ключ
//       (класс ≤ internal, contact — только с флагом, раскрытия нет), гость — только public,
//       внешние назначения — без раскрытия; masked ⇒ маска из паспорта поля; ниже full — без caps;
//       hidden ⇒ без раскрытия; раскрытие — только человеку
//   I5  компиляция правил идемпотентна, мусор словарей отброшен, у запрета уровень hidden
//   I6  проекция: ниже full сырое значение не выходит на провод (канарейка не видна в JSON)
//   I7  личное поле: «сам» → full; «Никогда» конкретному человеку → hidden, сильнее «Всегда»
//   I8  страж ответа: сырые защищённые ключи типа ловятся на любой глубине, бренд shape() — нет
//
// Без API и БД: берёт собранный `dist` (сначала `nest build`).
// Run: node apps/api/scripts/verify-visibility-plan.cjs   [RUNS=2000 для глубокого прогона]
// ============================================================
const fc = require('fast-check');
const S = require('@superapp/shared');
const P = require('../dist/core/visibility/visibility.plan.js');
const { makeChecker } = require('./_lib.cjs');

const { check, finish } = makeChecker();
const RUNS = Number(process.env.RUNS) || 400;

const ROLES = Object.keys(S.WORKSPACE_ROLES);
const LEVELS = S.VISIBILITY_LEVELS;
const rank = (l) => S.VISIBILITY_LEVEL_RANK[l];
const ORG_PRINCIPALS = ['department:d1', 'department:d2', 'position:p1', 'branch:b1'];
const STAGES = ['draft', 'active'];

/** Прогнать свойство и отчитаться строкой сьюта (контрпример — в скобках). */
function property(name, arb, predicate) {
  try {
    fc.assert(fc.property(arb, predicate), { numRuns: RUNS });
    check(name, true, `${RUNS} прогонов`);
  } catch (e) {
    check(name, false, String(e.message).split('\n').slice(0, 4).join(' | ').slice(0, 900));
  }
}

// ---------- генераторы ----------
const CTRL_TYPES = S.VISIBILITY_TYPE_KEYS.filter((t) => S.visibilityFieldsOf(t).some((e) => e.def.control === 'controller'));
const SUBJ_TYPES = S.VISIBILITY_TYPE_KEYS.filter((t) => S.visibilityFieldsOf(t).some((e) => e.def.control === 'subject'));
const ctrlFields = (t) => S.visibilityFieldsOf(t).filter((e) => e.def.control === 'controller');
const subjFields = (t) => S.visibilityFieldsOf(t).filter((e) => e.def.control === 'subject');

const columnArb = fc.oneof(
  fc.constantFrom(...ROLES).map((r) => ({ kind: 'role', id: r })),
  fc.constantFrom(...ORG_PRINCIPALS).map((p) => ({ kind: p.split(':')[0], id: p.split(':')[1] })),
  fc.constantFrom(...S.VISIBILITY_RELATIVE_KINDS).map((k) => ({ kind: k, id: null })),
);

/** Строка правила организации на поле / группу / секцию типа (как пишет её редактор матрицы). */
function ruleRowArb(type) {
  const fields = ctrlFields(type);
  const sections = [...new Set(fields.map((e) => e.section))];
  const groups = [...new Set(fields.map((e) => e.def.group))];
  const target = fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(...fields.map((e) => e.key)).map((k) => ({ fieldKey: k, groupKey: null, sectionKey: null })) },
    { weight: 1, arbitrary: fc.constantFrom(...groups).map((g) => ({ fieldKey: null, groupKey: g, sectionKey: null })) },
    { weight: 1, arbitrary: fc.constantFrom(...sections).map((s) => ({ fieldKey: null, groupKey: null, sectionKey: s })) },
  );
  return fc
    .record({
      id: fc.uuid(),
      target,
      col: columnArb,
      effect: fc.constantFrom('allow', 'allow', 'deny'),
      level: fc.constantFrom(...LEVELS),
      mask: fc.option(fc.constantFrom(...S.VISIBILITY_MASK_KINDS), { nil: null }),
      reveal: fc.constantFrom(...S.VISIBILITY_RULE_REVEAL_MODES),
      stage: fc.option(fc.constantFrom(...STAGES), { nil: null }),
    })
    .map((r) => ({ id: r.id, ...r.target, audienceKind: r.col.kind, audienceId: r.col.id, effect: r.effect, level: r.level, mask: r.mask, reveal: r.reveal, stage: r.stage }));
}

const viewerArb = fc
  .record({
    kind: fc.constantFrom('user', 'user', 'user', 'bot', 'guest'),
    role: fc.option(fc.constantFrom(...ROLES), { nil: null }),
    principals: fc.subarray(ORG_PRINCIPALS),
    botContactAccess: fc.boolean(),
    purpose: fc.constantFrom(...S.VISIBILITY_PURPOSES),
    revealDelegation: fc.boolean(),
  })
  .map((v) => ({
    ...v,
    userId: v.kind === 'user' ? 'viewer-1' : null,
    principals: new Set(v.principals),
    // Гость приходит только с назначением guest (так собирает шляпу guestViewer)
    purpose: v.kind === 'guest' ? 'guest' : v.purpose,
  }));

const relArb = fc.record({
  self: fc.boolean(),
  managerOf: fc.boolean(),
  branchHead: fc.boolean(),
  branchPayroll: fc.boolean(),
  branchScheduler: fc.boolean(),
  stage: fc.option(fc.constantFrom(...STAGES), { nil: null }),
});

/** Сценарий служебного поля: тип, поле, строки политики, зритель, отношение к записи. */
const ctrlScenario = fc.constantFrom(...CTRL_TYPES).chain((type) =>
  fc.record({
    type: fc.constant(type),
    entry: fc.constantFrom(...ctrlFields(type)),
    rows: fc.array(ruleRowArb(type), { maxLength: 14 }),
    viewer: viewerArb,
    rel: relArb,
  }),
);

const policyOf = (type, rows) => ({ pv: 1, rules: P.compileRules(type, rows) });
const decide = (sc, rel = sc.rel, viewer = sc.viewer, rows = sc.rows) => P.decideControllerField(sc.type, sc.entry, policyOf(sc.type, rows), viewer, rel);
const selfMode = (entry) => entry.def.self ?? 'full';
const selfDecides = (sc) => sc.rel.self && selfMode(sc.entry) !== 'policy';

// ---------- I1: запрет ----------
property(
  'I1 запрет на любом столбце зрителя → hidden (кроме «сам» с обязательной видимостью)',
  ctrlScenario,
  (sc) => {
    if (selfDecides(sc)) return true;
    const policy = policyOf(sc.type, sc.rows);
    const denied = P.viewerColumns(sc.viewer, sc.rel).some((c) => P.ruleForColumn(policy, sc.entry, c.kind, c.id, sc.rel.stage)?.effect === 'deny');
    if (!denied) return true;
    const d = decide(sc);
    return d.level === 'hidden' && d.reveal === 'none' && d.caps.length === 0;
  },
);

// ---------- I2: «сам» ----------
property(
  'I2 «сам» ≥ политики к нему же как к постороннему; self:hidden → hidden; self:policy → ровно политика',
  ctrlScenario.map((sc) => ({ ...sc, viewer: { ...sc.viewer, kind: 'user', userId: 'viewer-1', purpose: sc.viewer.purpose === 'guest' ? 'api' : sc.viewer.purpose } })),
  (sc) => {
    const asSelf = decide(sc, { ...sc.rel, self: true });
    const asOther = decide(sc, { ...sc.rel, self: false });
    const mode = selfMode(sc.entry);
    if (mode === 'hidden') return asSelf.level === 'hidden';
    if (mode === 'policy') return asSelf.level === asOther.level && asSelf.reveal === asOther.reveal;
    return rank(asSelf.level) >= rank(asOther.level);
  },
);

// ---------- I3: MAX по allow ----------
property(
  'I3 MAX по allow: новый столбец зрителя с разрешением не понижает уровень',
  ctrlScenario.chain((sc) =>
    fc.record({
      sc: fc.constant({ ...sc, rows: sc.rows.filter((r) => r.effect === 'allow') }),
      level: fc.constantFrom(...LEVELS),
      mask: fc.option(fc.constantFrom(...S.VISIBILITY_MASK_KINDS), { nil: null }),
    }),
  ),
  ({ sc, level, mask }) => {
    const before = decide(sc);
    // Свежий принципал, которого нет ни в одной строке политики, и разрешение ему на это поле
    const viewer = { ...sc.viewer, principals: new Set([...sc.viewer.principals, 'department:fresh']) };
    const rows = [...sc.rows, { id: 'fresh-rule', fieldKey: sc.entry.key, groupKey: null, sectionKey: null, audienceKind: 'department', audienceId: 'fresh', effect: 'allow', level, mask, reveal: 'none', stage: null }];
    const after = decide(sc, sc.rel, viewer, rows);
    return rank(after.level) >= rank(before.level);
  },
);

// ---------- I4: потолки ----------
function ceilingsHold(entry, viewer, rel, d) {
  const cls = entry.def.class;
  const allowedMasks = (entry.def.masks ?? []).filter((m) => m !== 'hidden');
  if (d.level === 'masked' && !(d.mask && allowedMasks.includes(d.mask))) return 'masked без маски поля';
  if (d.level !== 'full' && d.caps.length) return 'caps ниже full';
  if (d.level === 'hidden' && d.reveal !== 'none') return 'hidden с раскрытием';
  if (d.reveal !== 'none' && viewer.kind !== 'user') return 'раскрытие не человеку';
  if (cls === 'secret' && (rank(d.level) > rank('masked') || d.reveal !== 'none')) return 'secret выше маски/с раскрытием';
  if (cls === 'restricted' && !rel.self && d.level === 'full') return 'restricted целиком не себе';
  if (viewer.kind === 'bot') {
    if (d.reveal !== 'none') return 'бот с раскрытием';
    const over = S.VISIBILITY_CLASS_RANK[cls] > S.VISIBILITY_CLASS_RANK[S.VISIBILITY_BOT_CLASS_CEILING];
    const contactOk = cls === S.VISIBILITY_BOT_CONTACT_CLASS && viewer.botContactAccess;
    if (over && !contactOk && d.level !== 'hidden') return 'бот выше потолка класса';
  }
  if (viewer.purpose === 'guest' && cls !== 'public' && d.level !== 'hidden') return 'гость видит не public';
  if (S.VISIBILITY_EXTERNAL_PURPOSES.includes(viewer.purpose) && d.reveal !== 'none') return 'внешнее назначение с раскрытием';
  return null;
}

property('I4 потолки класса / бота / назначения на служебных полях', ctrlScenario, (sc) => {
  const bad = ceilingsHold(sc.entry, sc.viewer, sc.rel, decide(sc));
  if (bad) throw new Error(`${sc.type}.${sc.entry.key} [${sc.entry.def.class}]: ${bad}`);
  return true;
});

// Потолок restricted НЕ глотает маску: правило «целиком» на строгом поле → маска + раскрытие одной записи
property(
  'I4 правило full на restricted-поле → маска с раскрытием одной записи (не hidden)',
  fc.constantFrom(...CTRL_TYPES.flatMap((t) => ctrlFields(t).filter((e) => e.def.class === 'restricted').map((e) => ({ type: t, entry: e })))).chain((x) =>
    fc.record({ x: fc.constant(x), role: fc.constantFrom(...ROLES) }),
  ),
  ({ x, role }) => {
    const rows = [{ id: 'r', fieldKey: x.entry.key, groupKey: null, sectionKey: null, audienceKind: 'role', audienceId: role, effect: 'allow', level: 'full', mask: null, reveal: 'none', stage: null }];
    const viewer = { kind: 'user', userId: 'viewer-1', role, principals: new Set(), botContactAccess: false, purpose: 'card', revealDelegation: false };
    const rel = { self: false, managerOf: false, branchHead: false, branchPayroll: false, branchScheduler: false, stage: null };
    const d = P.decideControllerField(x.type, x.entry, policyOf(x.type, rows), viewer, rel);
    const bad = ceilingsHold(x.entry, viewer, rel, d);
    if (bad || d.level !== 'masked' || d.reveal !== 'one') throw new Error(`${x.type}.${x.entry.key}: ${bad ?? ''} ${JSON.stringify(d)}`);
    return true;
  },
);

// ---------- I5: компиляция ----------
const junkRowArb = fc.record({
  id: fc.uuid(),
  fieldKey: fc.option(fc.string({ maxLength: 12 }), { nil: null }),
  groupKey: fc.option(fc.oneof(fc.constantFrom(...S.VISIBILITY_FIELD_GROUPS), fc.string({ maxLength: 8 })), { nil: null }),
  sectionKey: fc.option(fc.string({ maxLength: 8 }), { nil: null }),
  audienceKind: fc.oneof(fc.constantFrom(...S.VISIBILITY_AUDIENCE_KINDS), fc.string({ maxLength: 8 })),
  audienceId: fc.option(fc.string({ maxLength: 8 }), { nil: null }),
  effect: fc.oneof(fc.constantFrom('allow', 'deny'), fc.string({ maxLength: 5 })),
  level: fc.oneof(fc.constantFrom(...LEVELS), fc.string({ maxLength: 6 })),
  mask: fc.option(fc.oneof(fc.constantFrom(...S.VISIBILITY_MASK_KINDS), fc.string({ maxLength: 6 })), { nil: null }),
  reveal: fc.oneof(fc.constantFrom(...S.VISIBILITY_RULE_REVEAL_MODES), fc.string({ maxLength: 6 })),
  stage: fc.option(fc.constantFrom(...STAGES), { nil: null }),
});

property(
  'I5 компиляция идемпотентна, мусор словарей отброшен, у запрета уровень hidden',
  fc.constantFrom(...S.VISIBILITY_TYPE_KEYS).chain((type) =>
    fc.record({ type: fc.constant(type), rows: fc.array(fc.oneof(ruleRowArb(CTRL_TYPES.includes(type) ? type : CTRL_TYPES[0]), junkRowArb), { maxLength: 16 }) }),
  ),
  ({ type, rows }) => {
    const once = P.compileRules(type, rows);
    const twice = P.compileRules(type, once);
    if (JSON.stringify(once) !== JSON.stringify(twice)) throw new Error('повторная компиляция изменила результат');
    for (const r of once) {
      if (!S.VISIBILITY_AUDIENCE_KINDS.includes(r.audienceKind)) throw new Error(`вид адресата ${r.audienceKind}`);
      if (!LEVELS.includes(r.level)) throw new Error(`уровень ${r.level}`);
      if (r.mask !== null && !S.VISIBILITY_MASK_KINDS.includes(r.mask)) throw new Error(`маска ${r.mask}`);
      if (!S.VISIBILITY_RULE_REVEAL_MODES.includes(r.reveal)) throw new Error(`раскрытие ${r.reveal}`);
      if (r.effect === 'deny' && r.level !== 'hidden') throw new Error('запрет не hidden');
      if (!r.fieldKey && !r.groupKey && !r.sectionKey) throw new Error('правило без цели');
      if (r.fieldKey && !S.visibilityFieldEntry(type, r.fieldKey)) throw new Error(`сирота-поле ${r.fieldKey}`);
    }
    return true;
  },
);

// ---------- I6: проекция ----------
const token = fc.stringMatching(/^[a-z][a-z0-9]{23}$/);
const digitsToken = fc.stringMatching(/^[1-9][0-9]{11}$/);
const canaryValueArb = fc.oneof(
  token.map((t) => ({ t, v: t })),
  token.map((t) => ({ t, v: `Алматы, ${t}` })),
  token.map((t) => ({ t, v: `${t}@mail.kz` })),
  token.map((t) => ({ t, v: `Иван ${t}` })),
  digitsToken.map((t) => ({ t, v: t })),
  digitsToken.map((t) => ({ t, v: Number(t) })),
);
const allEntries = S.VISIBILITY_TYPE_KEYS.flatMap((t) => S.visibilityFieldsOf(t));

property(
  'I6 проекция: ниже full сырое значение не выходит на провод',
  fc.record({
    entry: fc.constantFrom(...allEntries),
    level: fc.constantFrom('hidden', 'masked'),
    mask: fc.option(fc.constantFrom(...S.VISIBILITY_MASK_KINDS), { nil: null }),
    reveal: fc.constantFrom(...S.VISIBILITY_REVEAL_MODES),
    canary: canaryValueArb,
  }),
  ({ entry, level, mask, reveal, canary }) => {
    const out = P.projectValue(entry, { level, mask, reveal, caps: [], why: { source: 'default' } }, canary.v);
    if (out === canary.v) throw new Error('значение вышло как есть');
    if (!S.isGuardMarker(out)) throw new Error(`не маркер: ${JSON.stringify(out)}`);
    if (out.$v === 'hidden' && Object.keys(out).length !== 1) throw new Error('hidden несёт лишние ключи');
    if (JSON.stringify(out).includes(canary.t)) throw new Error(`канарейка в ${JSON.stringify(out)}`);
    return true;
  },
);

property(
  'I6 проекция: на уровне full значение проходит без изменений',
  fc.record({ entry: fc.constantFrom(...allEntries), canary: canaryValueArb }),
  ({ entry, canary }) => P.projectValue(entry, { level: 'full', mask: null, reveal: 'none', caps: [], why: { source: 'default' } }, canary.v) === canary.v,
);

// ---------- I7: личные поля ----------
const personalRowArb = fc.oneof(
  fc.constantFrom('viewer-1', 'other-1').chain((u) => fc.constantFrom('allow', 'deny').map((effect) => ({ audienceKind: 'user', audienceId: u, effect }))),
  fc.constantFrom('everybody', 'circle_all', 'colleagues').map((k) => ({ audienceKind: k, audienceId: null, effect: 'allow' })),
  fc.constantFrom('c1', 'c2').chain((c) => fc.constantFrom('allow', 'deny').map((effect) => ({ audienceKind: 'circle', audienceId: c, effect }))),
  fc.constant({ audienceKind: 'everybody', audienceId: null, effect: 'deny' }),
);
const subjScenario = fc.constantFrom(...SUBJ_TYPES).chain((type) =>
  fc.record({
    type: fc.constant(type),
    entry: fc.constantFrom(...subjFields(type)),
    rows: fc.array(personalRowArb, { maxLength: 8 }),
    viewer: viewerArb,
    rel: fc.record({
      self: fc.boolean(),
      linked: fc.boolean(),
      circleIds: fc.subarray(['c1', 'c2']).map((a) => new Set(a)),
      colleagueWorkspaceIds: fc.subarray(['w1']).map((a) => new Set(a)),
      viewerHidesOwnPresence: fc.boolean(),
    }),
  }),
);
const personalDecide = (sc) => {
  const rules = sc.rows.map((r, i) => ({ id: `p${i}`, fieldKey: sc.entry.key, groupKey: null, sectionKey: null, level: r.effect === 'deny' ? 'hidden' : 'full', mask: null, reveal: 'none', stage: null, ...r }));
  const setting = P.personalSetting(sc.type, sc.entry, { pv: 1, rules });
  return { setting, d: P.decidePersonalField(sc.type, sc.entry, setting, sc.viewer, sc.rel) };
};

property('I7 личное поле: «сам» → full; «Никогда» человеку → hidden сильнее «Всегда»; потолки', subjScenario, (sc) => {
  const { setting, d } = personalDecide(sc);
  if (sc.rel.self && d.level !== 'full') throw new Error('сам видит не full');
  if (!sc.rel.self && sc.viewer.userId && setting.never.has(sc.viewer.userId) && d.level !== 'hidden') throw new Error('«Никогда» не сработало');
  const bad = ceilingsHold(sc.entry, sc.viewer, { self: sc.rel.self }, d);
  if (bad && !sc.rel.self) throw new Error(`${sc.type}.${sc.entry.key}: ${bad}`);
  return true;
});

// ---------- I9: этап точнее «всех этапов», порядок строк не решает ----------
// Две строки одной цели и одного адресата: «на все этапы — целиком» и «на этапе X — запрет».
// На записи этапа X побеждает запрет, на другом этапе — разрешение; перестановка строк
// результата не меняет (иначе публикация «оклад уволенным — скрыть» зависела бы от порядка).
property(
  'I9 правило с этапом точнее правила без этапа той же цели; порядок строк не влияет',
  fc
    .constantFrom(...CTRL_TYPES.filter((t) => (S.visibilityTypeDef(t).stages ?? []).length > 0))
    .chain((type) =>
      fc.record({
        type: fc.constant(type),
        entry: fc.constantFrom(...ctrlFields(type).filter((e) => (e.def.self ?? 'full') !== 'hidden')),
        role: fc.constantFrom(...ROLES),
        stage: fc.constantFrom(...S.visibilityTypeDef(type).stages),
        target: fc.constantFrom('field', 'group', 'section'),
        swap: fc.boolean(),
      }),
    ),
  ({ type, entry, role, stage, target, swap }) => {
    const tgt = target === 'field' ? { fieldKey: entry.key, groupKey: null, sectionKey: null } : target === 'group' ? { fieldKey: null, groupKey: entry.def.group, sectionKey: null } : { fieldKey: null, groupKey: null, sectionKey: entry.section };
    const base = { ...tgt, audienceKind: 'role', audienceId: role, mask: null, reveal: 'none' };
    const allowAll = { id: 'all', ...base, effect: 'allow', level: 'full', stage: null };
    const denyStaged = { id: 'staged', ...base, effect: 'deny', level: 'hidden', stage };
    const rows = swap ? [denyStaged, allowAll] : [allowAll, denyStaged];
    const viewer = { kind: 'user', userId: 'viewer-1', role, principals: new Set(), botContactAccess: false, purpose: 'card', revealDelegation: false };
    const rel = (st) => ({ self: false, managerOf: false, branchHead: false, branchPayroll: false, branchScheduler: false, stage: st });
    const onStage = P.decideControllerField(type, entry, policyOf(type, rows), viewer, rel(stage));
    if (onStage.level !== 'hidden') throw new Error(`${type}.${entry.key} @${stage}: запрет этапа проигнорирован (${JSON.stringify(onStage)})`);
    const other = (S.visibilityTypeDef(type).stages ?? []).find((s) => s !== stage) ?? null;
    const offStage = P.decideControllerField(type, entry, policyOf(type, rows), viewer, rel(other));
    // Разрешение «целиком» на не-строгом поле: full; строгое — маска с раскрытием (потолок класса)
    const expected = entry.def.class === 'restricted' || entry.def.class === 'secret' ? 'masked' : 'full';
    if (offStage.level !== expected) throw new Error(`${type}.${entry.key} @${other}: ожидался ${expected}, получен ${JSON.stringify(offStage)}`);
    return true;
  },
);

// ---------- I8: страж ответа ----------
// Детектор `findUnshaped` — чистая функция стража ответа: объект с ≥ 2 «сырыми» защищёнными
// ключами одного типа на любой глубине ловится, тот же объект с брендом `shape()` — нет.
const G = require('../dist/core/visibility/visibility.response.guard.js');
const { markShaped } = require('../dist/core/visibility/visibility.service.js');
const guardedKeysOf = (t) =>
  S.visibilityFieldsOf(t)
    .filter((e) => S.isVisibilityFieldConfigurable(t, e.key) && S.VISIBILITY_CLASS_RANK[e.def.class] >= S.VISIBILITY_CLASS_RANK.contact)
    .map((e) => e.key);
const GUARDED_TYPES = S.VISIBILITY_TYPE_KEYS.filter((t) => guardedKeysOf(t).length >= 2);

property(
  'I8 страж ответа: сырые защищённые ключи ловятся на любой глубине, бренд shape() пропускается',
  fc.constantFrom(...GUARDED_TYPES).chain((type) =>
    fc.record({
      type: fc.constant(type),
      keys: fc.shuffledSubarray(guardedKeysOf(type), { minLength: 2 }),
      depth: fc.integer({ min: 0, max: 5 }),
      inArray: fc.boolean(),
    }),
  ),
  ({ keys, depth, inArray }) => {
    const wrap = (leaf) => {
      let node = inArray ? [leaf] : leaf;
      for (let i = 0; i < depth; i += 1) node = { data: node };
      return node;
    };
    const raw = Object.fromEntries(keys.map((k) => [k, 'canary-value']));
    if (!G.findUnshaped(wrap(raw))) throw new Error(`не пойман: ${keys.join(',')}`);
    const shaped = markShaped(Object.fromEntries(keys.map((k) => [k, S.HIDDEN])));
    if (G.findUnshaped(wrap(shaped))) throw new Error(`ложное срабатывание на shape(): ${keys.join(',')}`);
    return true;
  },
);

finish();
