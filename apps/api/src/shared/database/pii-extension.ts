import { Prisma } from '@prisma/client';
import { PII_ENVELOPE_PREFIX, piiHooks, type PiiBlindIndexPlan, type PiiFieldDef, type PiiHooks as PiiEngineHooks, type PiiModelDef, type PiiScopeRef } from './pii-hooks';

// ============================================================
// Расширение Prisma «piiCrypt» — единственное место, где ПДн шифруются и читаются.
//
// Запись (всегда, оба режима): для зарегистрированных полей рядом с открытым текстом
// пишутся `<f>Enc` (envelope, KEK владельца, AAD = сущность|поле|владелец) и `<f>Bi`
// (HMAC нормализованного значения). Вложенные create/update через relation'ы — тоже.
// Чтение (режим `encrypted`): фильтры по полю переписываются на `_bi`, в результатах
// поле подменяется расшифровкой `_enc` (рекурсивно по include/select, модель ребёнка —
// из DMMF); строка без `_enc` (ещё не бэкфиллена) читается как есть.
// Подстрочный поиск по зашифрованному полю невозможен — это ошибка разработчика,
// а не «пропустим»: бросаем сразу.
// ============================================================

type Rec = Record<string, unknown>;

/**
 * Хуки на ОДНУ операцию: снимок слепого индекса (`plan`) берётся лениво и один раз — все поля
 * запроса (запись, фильтр, вложенные связи) смотрят в одни и те же слот-колонки, даже если
 * смена ключа переключит primary посреди запроса.
 */
type PiiHooks = PiiEngineHooks & { plan(): Promise<PiiBlindIndexPlan> };

function forOperation(hooks: PiiEngineHooks): PiiHooks {
  let plan: Promise<PiiBlindIndexPlan> | null = null;
  return Object.assign(Object.create(hooks) as PiiEngineHooks, { plan: () => (plan ??= hooks.blindIndexPlan()) });
}

/** Колонки слепого индекса поля по слоту primary: `[рабочая, вторая]`. */
function biColumns(f: PiiFieldDef, slot: 0 | 1): [string, string] {
  return slot === 0 ? [f.bi!, f.biAlt!] : [f.biAlt!, f.bi!];
}

const WRITE_OPS = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'upsert']);
const RETURNING_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'create', 'update', 'upsert', 'createManyAndReturn']);
const EQUALITY_OPS = new Set(['equals', 'in', 'notIn', 'not']);
/** where этих операций обязан быть уникумом (OR внутри недопустим) */
const UNIQUE_WHERE_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert']);

const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

function normalizeValue(f: PiiFieldDef, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (f.kind === 'date') {
    const d = v instanceof Date ? v : new Date(String(v));
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  return String(v);
}

function ctxOf(def: PiiModelDef, f: PiiFieldDef, scope: PiiScopeRef) {
  return { entity: def.entity, field: f.name, ownerType: scope.type, ownerId: scope.type === 'platform' ? 'platform' : scope.id };
}

async function scopeForWrite(hooks: PiiHooks, def: PiiModelDef, data: Rec, op: 'create' | 'update', where: unknown, parentScope: PiiScopeRef | null): Promise<PiiScopeRef> {
  // create: скоуп — из самих данных (id человека генерируем здесь, чтобы он был известен до записи)
  if (op === 'create') {
    if (def.scopeFields.includes('id') && data.id === undefined) data.id = hooks.newId();
    let s = def.scope(data);
    // Вложенный create (счёт внутри контрагента): организация — у родителя; денормализуем в строку,
    // чтобы чтение потом вывело тот же скоуп без похода к родителю
    if (!s && parentScope && parentScope.type === 'workspace' && def.scopeFields.includes('workspaceId') && data.workspaceId === undefined) {
      data.workspaceId = parentScope.id;
      s = def.scope(data);
    }
    if (!s && parentScope) s = parentScope;
    if (!s) throw new Error(`pii: cannot derive the key scope for ${def.model}.create (fields ${def.scopeFields.join(', ')} missing)`);
    return s;
  }
  const fromData = def.scope(data);
  if (fromData) return fromData;
  // Поля скоупа прямо в уникальном where (`{ id }` у человека, `{ id, workspaceId }`): строка,
  // которую правка найдёт, обязана им соответствовать — поход в БД не нужен. Это же чинит
  // правку строки, созданной в ТОЙ ЖЕ транзакции: `fetchScopeRow` читает вне её и не видит.
  if (isRec(where)) {
    const fromWhere = def.scope(where);
    if (fromWhere) return fromWhere;
  }
  if (where) {
    const row = await hooks.fetchScopeRow(def.model, where);
    const s = row ? def.scope(row) : null;
    if (s) return s;
  }
  if (parentScope) return parentScope;
  throw new Error(`pii: cannot derive the key scope for ${def.model}.update (no unique where / scope fields)`);
}

/** Одна запись модели: досчитать `_enc`/`_bi` для присутствующих полей ПДн, спуститься во вложенные записи. */
async function transformData(hooks: PiiHooks, model: string, data: unknown, op: 'create' | 'update', where: unknown, parentScope: PiiScopeRef | null = null): Promise<void> {
  if (!isRec(data)) return;
  const def = hooks.models.get(model);
  let ownScope: PiiScopeRef | null = parentScope;
  if (def) {
    const present = def.fields.filter((f) => data[f.name] !== undefined);
    if (present.length) {
      const scope = await scopeForWrite(hooks, def, data, op, where, parentScope);
      ownScope = scope;
      for (const f of present) {
        const raw = data[f.name];
        const value = isRec(raw) && 'set' in raw ? (raw as Rec).set : raw;
        const plain = normalizeValue(f, value);
        if (plain === null) {
          data[f.enc] = null;
          if (f.bi) {
            data[f.bi] = null;
            data[f.biAlt!] = null;
          }
          continue;
        }
        data[f.enc] = f.literal?.(plain) ? plain : await hooks.encrypt(scope, ctxOf(def, f, scope), plain);
        if (f.bi && f.index) {
          // Рабочий слот — индекс primary-версией; второй слот — индекс pending-версией на окне смены
          // ключа (dual-write), а вне окна — `null`: запись инстанса, ещё не знающего про pending,
          // не оставит во втором слоте индекс СТАРОГО значения — фон досчитает строку заново
          const plan = await hooks.plan();
          const norm = f.normalize ? f.normalize(plain) : plain;
          const [cur, other] = biColumns(f, plan.slot);
          data[cur] = plan.value(f.index, norm);
          data[other] = plan.pendingValue(f.index, norm);
        }
      }
    }
  }
  // Вложенные записи через relation'ы (create / createMany / update / upsert / connectOrCreate)
  for (const [key, value] of Object.entries(data)) {
    if (!isRec(value)) continue;
    const rel = hooks.relation(model, key);
    if (!rel) continue;
    const child = rel.model;
    // Скоуп родителя наследуется вложенными записями (организация контрагента → его счета):
    // у зарегистрированной модели — её собственный скоуп, у любой другой — организация строки
    if (!ownScope && def) ownScope = def.scope(data);
    if (!ownScope && typeof data.workspaceId === 'string') ownScope = { type: 'workspace', id: data.workspaceId };
    const each = async (v: unknown, o: 'create' | 'update', w: unknown) => {
      if (Array.isArray(v)) for (const item of v) await transformData(hooks, child, item, o, w, ownScope);
      else await transformData(hooks, child, v, o, w, ownScope);
    };
    if (value.create !== undefined) await each(value.create, 'create', null);
    if (isRec(value.createMany) && value.createMany.data !== undefined) await each(value.createMany.data, 'create', null);
    if (value.connectOrCreate !== undefined) {
      const items = Array.isArray(value.connectOrCreate) ? value.connectOrCreate : [value.connectOrCreate];
      for (const it of items) if (isRec(it)) await transformData(hooks, child, it.create, 'create', null, ownScope);
    }
    if (value.update !== undefined) {
      const items = Array.isArray(value.update) ? value.update : [value.update];
      for (const it of items) {
        if (!isRec(it)) continue;
        // to-many: { where, data }; to-one: сами данные
        if ('data' in it && isRec(it.data)) await transformData(hooks, child, it.data, 'update', it.where, ownScope);
        else await transformData(hooks, child, it, 'update', null, ownScope);
      }
    }
    if (value.upsert !== undefined) {
      const items = Array.isArray(value.upsert) ? value.upsert : [value.upsert];
      for (const it of items) {
        if (!isRec(it)) continue;
        await transformData(hooks, child, it.create, 'create', null, ownScope);
        await transformData(hooks, child, it.update, 'update', it.where ?? null, ownScope);
      }
    }
  }
}

async function transformWrite(hooks: PiiHooks, model: string, operation: string, a: Rec): Promise<void> {
  switch (operation) {
    case 'create':
      await transformData(hooks, model, a.data, 'create', null);
      return;
    case 'createMany':
    case 'createManyAndReturn': {
      const rows = Array.isArray(a.data) ? a.data : [a.data];
      for (const r of rows) await transformData(hooks, model, r, 'create', null);
      return;
    }
    case 'update':
      await transformData(hooks, model, a.data, 'update', a.where);
      return;
    case 'updateMany': {
      const def = hooks.models.get(model);
      if (def && isRec(a.data) && def.fields.some((f) => (a.data as Rec)[f.name] !== undefined)) {
        // Скоуп на массовой правке известен только у платформенных моделей — иначе разработчик обязан идти по строкам
        const s = def.scope({});
        if (!s) throw new Error(`pii: ${model}.updateMany cannot set an encrypted field (per-row key scope) — update rows one by one`);
      }
      await transformData(hooks, model, a.data, 'update', null);
      return;
    }
    case 'upsert': {
      await transformData(hooks, model, a.create, 'create', null);
      // Строки ещё нет → скоуп ветки update вывести неоткуда; если она появится, то из `create`
      // с тем же уникумом — его скоуп и есть запасной (последним в порядке вывода)
      const def = hooks.models.get(model);
      const createScope = def && isRec(a.create) ? def.scope(a.create) : null;
      await transformData(hooks, model, a.update, 'update', a.where, createScope);
      return;
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------
// Чтение: where → _bi
// ---------------------------------------------------------------

async function biOf(hooks: PiiHooks, f: PiiFieldDef, v: unknown): Promise<string | null> {
  const plain = normalizeValue(f, v);
  if (plain === null) return null;
  return (await hooks.plan()).value(f.index!, f.normalize ? f.normalize(plain) : plain);
}

/**
 * `strictUnique` — у findUnique/update/delete/upsert where обязан быть уникумом: OR там
 * недопустим, фильтр переписывается на `_bi` строго. У прочих операций на окне dual-write
 * условие гибридное: `bi = X` ИЛИ (`bi IS NULL` и открытый текст = X) — строки, записанные
 * мимо слоя (скрипт, миграция, до бэкфилла), не пропадают из поиска.
 */
async function rewriteWhere(hooks: PiiHooks, model: string, where: unknown, strictUnique = false): Promise<unknown> {
  if (Array.isArray(where)) {
    const out = [];
    for (const w of where) out.push(await rewriteWhere(hooks, model, w));
    return out;
  }
  if (!isRec(where)) return where;
  const def = hooks.models.get(model);
  const out: Rec = {};
  const hybrid: Rec[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND' || key === 'OR' || key === 'NOT') {
      out[key] = await rewriteWhere(hooks, model, value);
      continue;
    }
    const f = def?.fields.find((x) => x.name === key);
    if (f) {
      if (!f.bi || !f.biAlt || !f.index) throw new Error(`pii: ${model}.${key} is encrypted without a blind index — it cannot be filtered`);
      // Ищем в слоте primary-версии: в колонке всегда ровно одна версия ключа, поэтому уникальные
      // операции и уникальные индексы работают и посреди смены ключа
      const [biCol] = biColumns(f, (await hooks.plan()).slot);
      let biCond: unknown;
      if (value === null || typeof value === 'string' || value instanceof Date) {
        biCond = value === null ? null : await biOf(hooks, f, value);
      } else if (isRec(value)) {
        const ops: Rec = {};
        for (const [op, v] of Object.entries(value)) {
          if (!EQUALITY_OPS.has(op)) throw new Error(`pii: ${model}.${key} is encrypted — operator "${op}" is not available (equality only)`);
          if (Array.isArray(v)) {
            const list = [];
            for (const item of v) list.push(await biOf(hooks, f, item));
            ops[op] = list;
          } else ops[op] = v === null ? null : await biOf(hooks, f, v);
        }
        biCond = ops;
      } else {
        throw new Error(`pii: ${model}.${key}: unsupported filter value`);
      }
      if (strictUnique || !hooks.plaintextPresent() || value === null) {
        out[biCol] = biCond;
      } else {
        hybrid.push({ OR: [{ [biCol]: biCond }, { [biCol]: null, [key]: value }] });
      }
      continue;
    }
    const cu = def?.compoundUniques?.[key];
    if (cu && isRec(value)) {
      const fld = def!.fields.find((x) => x.name === cu.field)!;
      const slot = (await hooks.plan()).slot;
      const inner: Rec = { ...value };
      inner[biColumns(fld, slot)[0]] = await biOf(hooks, fld, inner[cu.field]);
      delete inner[cu.field];
      out[slot === 0 ? cu.bi : cu.biAlt] = inner;
      continue;
    }
    const rel = hooks.relation(model, key);
    if (rel && isRec(value)) {
      const inner: Rec = {};
      for (const [k2, v2] of Object.entries(value)) {
        inner[k2] = k2 === 'some' || k2 === 'every' || k2 === 'none' || k2 === 'is' || k2 === 'isNot' ? await rewriteWhere(hooks, rel.model, v2) : v2;
      }
      // to-one relation filter без обёртки is/isNot — сами поля ребёнка
      const bare = Object.keys(value).some((k2) => !['some', 'every', 'none', 'is', 'isNot'].includes(k2));
      out[key] = bare ? { ...inner, ...(await rewriteWhere(hooks, rel.model, value) as Rec) } : inner;
      continue;
    }
    out[key] = value;
  }
  if (hybrid.length) {
    const and = Array.isArray(out.AND) ? out.AND : out.AND !== undefined ? [out.AND] : [];
    out.AND = [...and, ...hybrid];
  }
  return out;
}

// ---------------------------------------------------------------
// Чтение: select → добрать _enc и поля скоупа; результат → расшифровать
// ---------------------------------------------------------------

function ensureSelect(hooks: PiiHooks, model: string, args: Rec): void {
  const def = hooks.models.get(model);
  const select = isRec(args.select) ? args.select : null;
  if (select && def) {
    for (const f of def.fields) {
      if (select[f.name]) {
        select[f.enc] = true;
        for (const sf of def.scopeFields) select[sf] = true;
      }
    }
  }
  const nested = select ?? (isRec(args.include) ? args.include : null);
  if (!nested) return;
  for (const [key, value] of Object.entries(nested)) {
    if (!isRec(value)) continue;
    const rel = hooks.relation(model, key);
    if (rel) ensureSelect(hooks, rel.model, value);
  }
}

interface Collector {
  entries: Map<string, { fields: Set<string>; ids: Set<string> }>;
}

function collectKids(hooks: PiiHooks, model: string, rows: unknown, args: Rec | null, out: Set<string>): void {
  const def = hooks.models.get(model);
  const list = Array.isArray(rows) ? rows : [rows];
  for (const row of list) {
    if (!isRec(row)) continue;
    if (def) for (const f of def.fields) {
      const stored = row[f.enc];
      if (typeof stored === 'string' && stored.startsWith(PII_ENVELOPE_PREFIX)) {
        const kid = hooks.kekKidOf(stored);
        if (kid) out.add(kid);
      }
    }
    const nested = args && (isRec(args.select) ? args.select : isRec(args.include) ? args.include : null);
    for (const [key, value] of Object.entries(row)) {
      const rel = hooks.relation(model, key);
      if (!rel || value === null || typeof value !== 'object') continue;
      const childArgs = nested && isRec(nested[key]) ? (nested[key] as Rec) : null;
      collectKids(hooks, rel.model, value, childArgs, out);
    }
  }
}

async function decryptRows(hooks: PiiHooks, model: string, rows: unknown, args: Rec | null, col: Collector): Promise<void> {
  const def = hooks.models.get(model);
  const list = Array.isArray(rows) ? rows : [rows];
  for (const row of list) {
    if (!isRec(row)) continue;
    if (def) {
      const scope = def.scope(row);
      for (const f of def.fields) {
        const stored = row[f.enc];
        if (typeof stored !== 'string') continue; // не бэкфиллено — остаётся открытый текст
        if (!stored.startsWith(PII_ENVELOPE_PREFIX)) {
          // Служебная заглушка (`deleted:` / `bot:`) лежит в `_enc` без конверта — она и есть значение
          if (f.literal?.(stored)) row[f.name] = stored;
          continue;
        }
        if (!scope) continue;
        const plain = await hooks.decrypt(scope, ctxOf(def, f, scope), stored);
        if (plain === null) {
          // KEK заморожен/уничтожен либо шифротекст бит. Fail-closed: в режиме `encrypted` правда —
          // `_enc`, и подставлять открытую колонку окна dual-write нельзя: kill-switch заморозки
          // иначе не прятал бы ПДн, пока открытые колонки не дропнуты. Поле — null, строка жива.
          row[f.name] = null;
          continue;
        }
        row[f.name] = f.kind === 'date' ? new Date(`${plain}T00:00:00.000Z`) : plain;
        if (f.sensitive) {
          const e = col.entries.get(def.entity) ?? { fields: new Set<string>(), ids: new Set<string>() };
          e.fields.add(f.name);
          if (typeof row.id === 'string') e.ids.add(row.id);
          col.entries.set(def.entity, e);
        }
      }
    }
    const nested = args && (isRec(args.select) ? args.select : isRec(args.include) ? args.include : null);
    for (const [key, value] of Object.entries(row)) {
      const rel = hooks.relation(model, key);
      if (!rel || value === null || typeof value !== 'object') continue;
      const childArgs = nested && isRec(nested[key]) ? (nested[key] as Rec) : null;
      await decryptRows(hooks, rel.model, value, childArgs, col);
    }
  }
}

async function decryptResult(hooks: PiiHooks, model: string, args: Rec, result: unknown): Promise<void> {
  const kids = new Set<string>();
  collectKids(hooks, model, result, args, kids);
  if (kids.size) await hooks.prefetch([...kids]);
  const col: Collector = { entries: new Map() };
  await decryptRows(hooks, model, result, args, col);
  for (const [entity, e] of col.entries) {
    hooks.logAccess({ entity, fields: [...e.fields], ids: [...e.ids].slice(0, 20), count: e.ids.size });
  }
}

/** Расширение Prisma: навешивается в `buildScopedPrismaClient` ПОСЛЕ chokepoint'а. */
export function piiExtension() {
  return Prisma.defineExtension((client) =>
    client.$extends({
      name: 'piiCrypt',
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (!piiHooks.current) return query(args);
            const hooks = forOperation(piiHooks.current);
            const a = (args ?? {}) as Rec;
            if (WRITE_OPS.has(operation)) await transformWrite(hooks, model, operation, a);
            const encrypted = hooks.readMode() === 'encrypted';
            if (encrypted) {
              if (a.where !== undefined) a.where = await rewriteWhere(hooks, model, a.where, UNIQUE_WHERE_OPS.has(operation));
              ensureSelect(hooks, model, a);
            }
            const result = await query(a as never);
            if (encrypted && result && RETURNING_OPS.has(operation)) await decryptResult(hooks, model, a, result);
            return result;
          },
        },
      },
    }),
  );
}
