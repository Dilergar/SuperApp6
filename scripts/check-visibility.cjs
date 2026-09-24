#!/usr/bin/env node
/**
 * Страж реестра правил видимости (core/visibility). ~1 с, без сборки: реестр и его словарь
 * транспилируются из исходников shared на лету (typescript из packages/shared).
 *
 *   реестр     — `visibilityRegistryProblems()` (тот же, что смоук бута API): маски по виду
 *                данных, секрет без раскрытия, личное ≠ служебное, производное не ниже входа…;
 *   каталог    — у каждого типа/секции/поля есть `visibility.types.<t>.title|sections.<s>.title|
 *                fields.<f>.label` в en/kk/ru; в каталоге нет типов и полей, которых нет в реестре;
 *   ПДн        — каждое `sensitive` поле `PII_MODELS` объявлено в реестре (`pii: {model, field}`)
 *                либо стоит в allow-list ниже с причиной;
 *   утечки     — имена полей класса ≥ personal не встречаются в свойствах аналитики, деталях
 *                журнала аудита, payload уведомлений и вебхуков;
 *   провайдер  — у каждого типа есть `VisibilityTypeRegistry.register('<t>', …)` в apps/api/src
 *                и строка в манифесте канареечного сьюта (`CANARY_TYPES` в verify-visibility.cjs);
 *   сироты     — строки `visibility_rules` в миграциях данных ссылаются только на поля реестра;
 *   DTO (R22)  — чувствительное свойство формы провода (phone, email, iin, iban, pan, salary,
 *                адрес, удостоверение…) либо `Guarded<…>`, либо в allow-list ниже с причиной.
 *
 * Выход 1 при ошибке. На GitHub Actions — аннотации ::error.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SHARED = path.join(ROOT, 'packages', 'shared', 'src');
const MESSAGES = path.join(ROOT, 'packages', 'i18n', 'src', 'messages');
const API_DIR = path.join(ROOT, 'apps', 'api', 'src');
const MIGRATIONS = path.join(ROOT, 'apps', 'api', 'prisma', 'migrations');
const SUITE = path.join(ROOT, 'apps', 'api', 'scripts', 'verify-visibility.cjs');
const LOCALES = ['en', 'kk', 'ru'];
const GH = !!process.env.GITHUB_ACTIONS;

let errors = 0;
const err = (msg) => {
  errors++;
  console.error(GH ? `::error::check-visibility: ${msg}` : `  ✗ ${msg}`);
};
const read = (f) => fs.readFileSync(f, 'utf8');

/**
 * ALLOW-LIST чувствительных ПДн-колонок вне реестра видимости — только с причиной.
 * Новая строка здесь = решение, которое видно на ревью.
 */
const PII_ALLOW = {
  'SignAct.certSubjectIin': 'акт подписи — доказательство: в ответы API не отдаётся, в протокол печатается маской id_last4',
};

/**
 * ALLOW-LIST свойств DTO shared, чьё имя похоже на ПДн, но поле не относится к записи чужого
 * человека (или отдаётся только владельцу своих данных) — только с причиной.
 */
const DTO_ALLOW = {
  'user.ts:User.phone': 'свой профиль (`/users/me`): человек видит своё',
  'user.ts:User.dateOfBirth': 'свой профиль',
  'user.ts:User.email': 'свой профиль',
  'user.ts:User.iin': 'свой профиль (реквизиты — «Моя Анкета»)',
  'user.ts:User.residentialAddress': 'свой профиль',
  'user.ts:User.idDocNumber': 'свой профиль',
  'user.ts:User.idDocIssuedBy': 'свой профиль',
  'user.ts:User.idDocIssuedAt': 'свой профиль',
  'user.ts:UserLookupDto.phone': 'эхо номера, который ищущий сам ввёл (находимость — отдельная ось)',
  'contact.ts:ContactInvitation.toPhone': 'номер, на который ПРИГЛАШАЮЩИЙ сам отправил приглашение',
  'workspace.ts:WorkspaceInvitation.toPhone': 'номер, на который организация сама отправила приглашение',
  'google.ts:GoogleConnectionStatus.email': 'своя учётная запись Google (интеграция человека)',
  'counterparty.ts:CounterpartyDto.bin': 'БИН/ИИН стороны договора — пол записи контрагента (без него нет документа)',
  'counterparty.ts:CounterpartyDto.legalAddress': 'юрадрес стороны договора — пол записи контрагента',
  'counterparty.ts:CounterpartyDto.actualAddress': 'фактический адрес стороны договора — пол записи контрагента',
  'counterparty.ts:CounterpartyLiteDto.bin': 'лёгкий срез стороны договора (карточка документа)',
  'legal-entity.ts:LegalEntityLiteDto.bin': 'БИН юрлица организации — публичный реестр',
  'workspace.ts:WorkspaceRequisitesDto.bin': 'БИН организации — публичный реестр (блок реквизитов — поле `requisites`)',
  'workspace.ts:WorkspaceRequisitesDto.legalAddress': 'юрадрес организации — публичный реестр',
  'sign.ts:SignCertificateDto.iin': 'ИИН подписанта из сертификата — всегда маской id_last4 (блок «Подписи», страница проверки)',
  'sign.ts:SignCertificateDto.bin': 'БИН организации подписанта из сертификата — публичный реестр',
  'hr.ts:EmploymentDto.salaryCurrency': 'валюта — не сумма',
  'wallet.ts:UserPaymentCardDto.iban': 'своя карта в своём кошельке (владелец видит своё)',
};

// ---------- загрузка реестра: транспиляция TS на лету ----------
let ts;
try {
  ts = require(require.resolve('typescript', { paths: [path.join(ROOT, 'packages', 'shared')] }));
} catch {
  err('не найден typescript (packages/shared/node_modules) — выполните pnpm install');
  process.exit(1);
}
const prevTs = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => {
  const out = ts.transpileModule(read(filename), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  module._compile(out, filename);
};
let reg;
try {
  reg = require(path.join(SHARED, 'visibility', 'index.ts'));
} catch (e) {
  err(`реестр не загрузился: ${e.message}`);
  process.exit(1);
} finally {
  if (prevTs) require.extensions['.ts'] = prevTs;
  else delete require.extensions['.ts'];
}

const TYPES = reg.VISIBILITY_TYPE_KEYS;
const CLASS_RANK = reg.VISIBILITY_CLASS_RANK;

// ---------- 1. реестр ----------
for (const p of reg.visibilityRegistryProblems()) err(`реестр: ${p}`);

// ---------- 2. каталоги ----------
const at = (obj, dotted) => dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
for (const loc of LOCALES) {
  const file = path.join(MESSAGES, loc, 'visibility.json');
  if (!fs.existsSync(file)) {
    err(`нет каталога ${path.relative(ROOT, file)}`);
    continue;
  }
  const cat = JSON.parse(read(file));
  for (const type of TYPES) {
    const def = reg.visibilityTypeDef(type);
    const base = `types.${type}`;
    if (typeof at(cat, `${base}.title`) !== 'string') err(`[${loc}] нет visibility.${base}.title`);
    for (const s of Object.keys(def.sections)) {
      if (typeof at(cat, `${base}.sections.${s}.title`) !== 'string') err(`[${loc}] нет visibility.${base}.sections.${s}.title`);
    }
    for (const e of reg.visibilityFieldsOf(type)) {
      if (typeof at(cat, `${base}.fields.${e.key}.label`) !== 'string') err(`[${loc}] нет visibility.${base}.fields.${e.key}.label`);
    }
    // сироты каталога: поля и секции, которых нет в реестре
    const catFields = at(cat, `${base}.fields`) || {};
    for (const f of Object.keys(catFields)) if (!reg.visibilityFieldEntry(type, f)) err(`[${loc}] в каталоге поле ${type}.${f}, которого нет в реестре`);
    const catSections = at(cat, `${base}.sections`) || {};
    for (const s of Object.keys(catSections)) if (!def.sections[s]) err(`[${loc}] в каталоге секция ${type}.${s}, которой нет в реестре`);
  }
  // сироты-типы: листья `title` под types, которых нет в реестре
  const walk = (node, prefix) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.title === 'string' && (node.fields || node.sections)) {
      if (!TYPES.includes(prefix)) err(`[${loc}] в каталоге тип ${prefix}, которого нет в реестре`);
      return;
    }
    for (const [k, v] of Object.entries(node)) walk(v, prefix ? `${prefix}.${k}` : k);
  };
  walk(cat.types, '');
}

// ---------- 3. ПДн-колонки ----------
const piiFile = path.join(API_DIR, 'core', 'keys', 'pii', 'keys.pii.registry.ts');
const piiTxt = read(piiFile);
const declared = new Set();
for (const type of TYPES) for (const e of reg.visibilityFieldsOf(type)) if (e.def.pii) declared.add(`${e.def.pii.model}.${e.def.pii.field}`);
for (const block of piiTxt.split(/\n\s*\{\s*\n\s*model:\s*'/).slice(1)) {
  const model = block.slice(0, block.indexOf("'"));
  for (const m of block.matchAll(/\{\s*name:\s*'([A-Za-z]+)'[^}]*sensitive:\s*true/g)) {
    const key = `${model}.${m[1]}`;
    if (!declared.has(key) && !PII_ALLOW[key]) err(`ПДн ${key} (sensitive) не объявлена в реестре видимости (pii: {model, field}) и не в allow-list`);
  }
}

// ---------- 4. утечки имён полей ≥ personal ----------
const personal = new Set();
for (const type of TYPES) {
  for (const e of reg.visibilityFieldsOf(type)) if (CLASS_RANK[e.def.class] >= CLASS_RANK.personal) personal.add(e.key);
}
const objectKeys = (body) => [...body.matchAll(/(?:^|[,{\s])([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((m) => m[1]);
/** Верхнеуровневое тело `{ … }`, начиная с индекса открывающей скобки. */
function braceBody(txt, start) {
  let depth = 0;
  for (let i = start; i < txt.length; i++) {
    if (txt[i] === '{') depth++;
    else if (txt[i] === '}') {
      depth--;
      if (depth === 0) return txt.slice(start + 1, i);
    }
  }
  return '';
}
function scanSchemas(dir, marker, what) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    const txt = read(path.join(dir, f));
    let idx = 0;
    while ((idx = txt.indexOf(marker, idx)) >= 0) {
      const open = txt.indexOf('{', idx);
      const body = braceBody(txt, open);
      for (const k of objectKeys(body)) if (personal.has(k)) err(`${what}: имя поля класса ≥ personal «${k}» в ${path.relative(ROOT, path.join(dir, f))}`);
      idx = open + 1;
    }
  }
}
scanSchemas(path.join(SHARED, 'analytics'), 'props: z', 'аналитика');
scanSchemas(path.join(SHARED, 'audit'), 'z.object(', 'детали аудита');

function walkTs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}
const apiFiles = walkTs(API_DIR);
for (const f of apiFiles) {
  const txt = read(f);
  for (const call of ['notifications.send(', '.emit(']) {
    let idx = 0;
    while ((idx = txt.indexOf(call, idx)) >= 0) {
      const window = txt.slice(idx, idx + 1500);
      const p = window.indexOf('payload:');
      if (p >= 0 && window.slice(p, p + 12).includes('{')) {
        const body = braceBody(window, window.indexOf('{', p));
        for (const k of objectKeys(body)) {
          if (personal.has(k)) err(`payload ${call.replace('(', '')}: имя поля класса ≥ personal «${k}» в ${path.relative(ROOT, f)}`);
        }
      }
      idx += call.length;
    }
  }
}

// ---------- 5. провайдеры и манифест сьюта ----------
const registered = new Set();
for (const f of apiFiles) {
  const txt = read(f);
  if (!txt.includes('VisibilityTypeRegistry')) continue;
  for (const m of txt.matchAll(/\.register\(\s*'([a-z_.]+)'\s*,/g)) registered.add(m[1]);
}
for (const type of TYPES) if (!registered.has(type)) err(`тип ${type}: нет VisibilityTypeRegistry.register('${type}', …) в apps/api/src`);
if (!fs.existsSync(SUITE)) {
  err(`нет канареечного сьюта ${path.relative(ROOT, SUITE)} (манифест CANARY_TYPES)`);
} else {
  const block = /CANARY_TYPES\s*=\s*\[([\s\S]*?)\]/.exec(read(SUITE));
  const listed = new Set([...(block?.[1] ?? '').matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]));
  for (const type of TYPES) if (!listed.has(type)) err(`тип ${type}: нет строки в CANARY_TYPES канареечного сьюта`);
}

// ---------- 6. сироты в миграциях данных ----------
const allFields = new Set(TYPES.flatMap((t) => reg.visibilityFieldsOf(t).map((e) => e.key)));
if (fs.existsSync(MIGRATIONS)) {
  for (const d of fs.readdirSync(MIGRATIONS)) {
    const sqlFile = path.join(MIGRATIONS, d, 'migration.sql');
    if (!fs.existsSync(sqlFile)) continue;
    const sql = read(sqlFile);
    // Поля, которые миграция данных пишет в правила: `'field_key', '<ключ>'` пары или VALUES-кортежи
    for (const m of sql.matchAll(/--\s*visibility-field:\s*([A-Za-z0-9]+)/g)) {
      if (!allFields.has(m[1])) err(`миграция ${d}: правило ссылается на поле «${m[1]}», которого нет в реестре — нужна миграция-уборка`);
    }
  }
}

// ---------- 7. DTO провода (R22) ----------
const SENSITIVE_PROP = /^(phone|email|iin|bin|pan|iban|residentialAddress|legalAddress|actualAddress|idDocNumber|idDocIssuedBy|idDocIssuedAt|dateOfBirth|salaryAmount|salaryCurrency|officialSalary|actualRate|plannedRate|contactPhone|contactEmail|toPhone|signerPhone)$/;
const typesDir = path.join(SHARED, 'types');
for (const f of fs.readdirSync(typesDir).filter((x) => x.endsWith('.ts'))) {
  const txt = read(path.join(typesDir, f));
  for (const m of txt.matchAll(/export interface ([A-Za-z0-9_]+)[^{]*\{/g)) {
    const body = braceBody(txt, m.index + m[0].length - 1);
    // только верхний уровень интерфейса
    let depth = 0;
    let line = '';
    const props = [];
    for (const ch of body) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (ch === '\n') {
        if (depth === 0) props.push(line);
        line = '';
        continue;
      }
      line += ch;
    }
    for (const l of props) {
      const pm = /^\s*([A-Za-z0-9_]+)\??:\s*(.+?);?\s*(\/\/.*)?$/.exec(l);
      if (!pm || !SENSITIVE_PROP.test(pm[1])) continue;
      if (/^boolean\b/.test(pm[2])) continue;
      if (/Guarded</.test(pm[2])) continue;
      const key = `${f}:${m[1]}.${pm[1]}`;
      if (!DTO_ALLOW[key]) err(`DTO ${key}: чувствительное поле без Guarded<…> и без причины в allow-list (R22)`);
    }
  }
}

// ---------- 8. словарь адресатов в CHECK таблицы правил ----------
// Реестр и Zod принимают `VISIBILITY_AUDIENCE_KINDS`; CHECK `visibility_rules_audience_kind_check`
// живёт в миграциях. Расхождение = правило с новым адресатом падает на вставке (23514 → 500):
// последнее определение CHECK в миграциях обязано перечислять реестр целиком.
if (fs.existsSync(MIGRATIONS)) {
  let last = null;
  for (const d of fs.readdirSync(MIGRATIONS).sort()) {
    const sqlFile = path.join(MIGRATIONS, d, 'migration.sql');
    if (!fs.existsSync(sqlFile)) continue;
    const sql = read(sqlFile);
    for (const m of sql.matchAll(/visibility_rules_audience_kind_check"\s+CHECK\s*\(\s*"audience_kind"\s+IN\s*\(([^)]*)\)/g)) {
      last = { dir: d, kinds: new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])) };
    }
  }
  if (!last) {
    err('нет CHECK visibility_rules_audience_kind_check ни в одной миграции');
  } else {
    for (const k of reg.VISIBILITY_AUDIENCE_KINDS) {
      if (!last.kinds.has(k)) err(`адресат «${k}» есть в реестре, но не в CHECK visibility_rules_audience_kind_check (последнее определение — ${last.dir}): нужна миграция-расширение`);
    }
    for (const k of last.kinds) {
      if (!reg.VISIBILITY_AUDIENCE_KINDS.includes(k)) err(`CHECK visibility_rules_audience_kind_check (${last.dir}) разрешает адресата «${k}», которого нет в реестре`);
    }
  }
}

if (errors) {
  console.error(`\n[check:visibility] ${errors} ошибок`);
  process.exit(1);
}
console.log(`[check:visibility] ок: ${TYPES.length} типов, ${allFields.size} полей, ${declared.size} ПДн-колонок в реестре`);
