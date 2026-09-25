import { Prisma } from '@prisma/client';
import { LIFECYCLE_FOREVER, lifecyclePolicy, resolveLifecycleRetention, type LifecyclePolicy, type LifecycleRowFilter } from '@superapp/shared';
import { utcTs } from '../../shared/database/sql-time';

type Tx = Prisma.TransactionClient;

// SQL раннера purge и каскада организации — собирается из реестра и схемы Prisma (DMMF), а не
// руками: идентификаторы — только имена модели и её колонок (проверены регэкспом), значения —
// параметрами. Сырой SQL в реестре запрещён (типы реестра его не выражают).

/**
 * Замок заморозок: каждая пачка удаления берёт его ОБЩИМ в своей транзакции, постановка
 * заморозки (core/lifecycle holds, Э4) — ИСКЛЮЧИТЕЛЬНЫМ. Заморозка, закоммиченная до пачки,
 * видна её `NOT EXISTS`; поставленная во время пачки ждёт её коммита — TOCTOU между
 * «проверил заморозку» и «удалил» закрыт на всех путях (общая пачка, шаг модуля, loose FK).
 */
export const LIFECYCLE_HOLD_LOCK = 0x4c465948; // 'LFYH'

interface LifecycleField {
  name: string;
  column: string;
  /** Нативный тип колонки (`Timestamptz`, `Date`, `Uuid`…) или null — умолчание Prisma */
  native: string | null;
  type: string;
  /** Колонка-массив (`uuid[]` участников и т.п.) */
  list: boolean;
}

/** Физическая таблица политики модели. */
export interface LifecycleTable {
  /** `public.jobs` — для regclass и pg_stat */
  name: string;
  /** `"public"."jobs"` */
  ident: Prisma.Sql;
  /** Колонки первичного ключа */
  pk: string[];
  fields: ReadonlyMap<string, LifecycleField>;
}

const IDENT = /^[a-z_][a-z0-9_]*$/i;

function q(id: string): string {
  if (!IDENT.test(id)) throw new Error(`lifecycle sql: unsafe identifier "${id}"`);
  return `"${id}"`;
}

const TABLES = new Map<string, LifecycleTable>();
for (const m of Prisma.dmmf.datamodel.models) {
  const fields = new Map<string, LifecycleField>();
  for (const f of m.fields) {
    if (f.kind !== 'scalar' && f.kind !== 'enum') continue;
    const native = (f as { nativeType?: [string, string[]] | null }).nativeType?.[0] ?? null;
    fields.set(f.name, { name: f.name, column: f.dbName ?? f.name, native, type: f.type, list: !!f.isList });
  }
  const pkFields = m.primaryKey?.fields?.length ? [...m.primaryKey.fields] : m.fields.filter((f) => f.isId).map((f) => f.name);
  const table = m.dbName ?? m.name;
  TABLES.set(m.name, {
    name: `public.${table}`,
    ident: Prisma.raw(`"public".${q(table)}`),
    pk: pkFields.map((f) => fields.get(f)?.column ?? f),
    fields,
  });
}

/** Таблица политики модели; прочие хранилища (Redis, байты, сырые таблицы) — только шагом модуля. */
export function lifecycleTableOf(policy: LifecyclePolicy): LifecycleTable | null {
  return policy.store.kind === 'model' ? (TABLES.get(policy.store.model) ?? null) : null;
}

function field(t: LifecycleTable, name: string): LifecycleField {
  const f = t.fields.get(name);
  if (!f) throw new Error(`lifecycle sql: ${t.name} has no field "${name}"`);
  return f;
}

/** Ссылка на колонку поля модели (`t."finished_at"`). */
export function colSql(t: LifecycleTable, fieldName: string, alias = 't'): Prisma.Sql {
  return Prisma.raw(`${alias}.${q(field(t, fieldName).column)}`);
}

function colText(t: LifecycleTable, fieldName: string, alias = 't'): string {
  return `${alias}.${q(field(t, fieldName).column)}`;
}

/**
 * `колонка = значение` по родному типу колонки: uuid — параметром `::uuid` (индекс по
 * колонке работает), прочее — как есть. Каст КОЛОНКИ в text (`t.col::text = $1`) выключает
 * индекс: каждая пачка каскада читала бы таблицу целиком.
 */
export function eqSql(t: LifecycleTable, fieldName: string, value: string, alias = 't'): Prisma.Sql {
  const f = field(t, fieldName);
  const col = Prisma.raw(`${alias}.${q(f.column)}`);
  // Колонка-массив (участники): «значение среди элементов» — GIN по массиву работает с `@>`
  if (f.list) return f.native === 'Uuid' ? Prisma.sql`${col} @> ARRAY[${value}::uuid]` : Prisma.sql`${col} @> ARRAY[${value}]`;
  return f.native === 'Uuid' ? Prisma.sql`${col} = ${value}::uuid` : Prisma.sql`${col} = ${value}`;
}

/** `pk = ANY(список)` по родному типу ключа (индекс первичного ключа работает). */
function pkAnySql(t: LifecycleTable, ids: readonly string[], alias = 't'): Prisma.Sql {
  const pkField = [...t.fields.values()].find((x) => x.column === t.pk[0]);
  const col = Prisma.raw(`${alias}.${q(t.pk[0])}`);
  return pkField?.native === 'Uuid' ? Prisma.sql`${col} = ANY(${[...ids]}::uuid[])` : Prisma.sql`${col}::text = ANY(${[...ids]}::text[])`;
}

/**
 * Момент для сравнения с колонкой времени поля: `timestamp` без пояса (умолчание Prisma) —
 * `utcTs` (правило сырого SQL), `timestamptz` — как есть, `date` — UTC-дата момента.
 */
export function timeParamSql(t: LifecycleTable, fieldName: string, at: Date): Prisma.Sql {
  const f = field(t, fieldName);
  if (f.native === 'Timestamptz') return Prisma.sql`${at}::timestamptz`;
  if (f.native === 'Date') return Prisma.sql`(${at}::timestamptz AT TIME ZONE 'UTC')::date`;
  return utcTs(at);
}

/** Условие фильтра реестра: `{ status: ['completed'] }` → `t."status" IN ($1)`, `null` → IS NULL. */
export function filterSql(t: LifecycleTable, filter: LifecycleRowFilter | undefined, alias = 't'): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  for (const [name, values] of Object.entries(filter ?? {})) {
    const col = colSql(t, name, alias);
    const concrete = values.filter((v): v is string => v !== null);
    const withNull = values.some((v) => v === null);
    const inList = concrete.length ? Prisma.sql`${col}::text IN (${Prisma.join(concrete)})` : null;
    if (inList && withNull) parts.push(Prisma.sql`(${inList} OR ${col} IS NULL)`);
    else if (inList) parts.push(inList);
    else if (withNull) parts.push(Prisma.sql`${col} IS NULL`);
  }
  return parts.length ? Prisma.join(parts, ' AND ') : Prisma.sql`TRUE`;
}

/**
 * «Строка не под заморозкой» для политики: запись (id), класс данных, пространство
 * (организация / чат), хранитель (владелец и субъекты строки). Заморозка организации
 * действует только на строки этой организации; заморозка платформы (`workspace_id` пуст) —
 * на все. Колонка из реестра, которой нет в модели, — ошибка (fail-closed: не удалять вслепую).
 */
export function holdFreeSql(policy: LifecyclePolicy, t: LifecycleTable, alias = 't'): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (SELECT 1 FROM "lifecycle_holds" h WHERE ${holdCoversSql(policy, t, alias)})`;
}

/**
 * «Заморозка `h` действующая и покрывает строку `alias`» — общий предикат для оператора
 * удаления (`holdFreeSql`) и для сохранения оригинала в hold store (`holdsCoveringRowSql`).
 * Организация строки: колонка ключа владельца; у беседы — организация её чата (иначе
 * заморозки ОРГАНИЗАЦИИ, например хранителя в её чатах, на сообщения не действовали бы).
 */
export function holdCoversSql(policy: LifecyclePolicy, t: LifecycleTable, alias = 't'): Prisma.Sql {
  const ok = policy.ownerKey;
  let ws: string | null = null;
  let chat: string | null = null;
  const users: string[] = [];
  switch (ok.kind) {
    case 'user':
      if ('column' in ok) users.push(colText(t, ok.column, alias));
      break;
    case 'workspace':
      if ('column' in ok) ws = colText(t, ok.column, alias);
      break;
    case 'conversation':
      if ('column' in ok) {
        chat = colText(t, ok.column, alias);
        ws = `(SELECT c."workspace_id" FROM "chats" c WHERE c."id" = ${chat})`;
      }
      break;
    case 'scoped':
      ws = colText(t, ok.workspaceColumn, alias);
      if (ok.userColumn) users.push(colText(t, ok.userColumn, alias));
      if (ok.conversationColumn) chat = colText(t, ok.conversationColumn, alias);
      break;
    case 'polymorphic': {
      const tc = colText(t, ok.typeColumn, alias);
      const oc = colText(t, ok.column, alias);
      if (ok.kinds.includes('workspace')) ws = `CASE WHEN ${tc} = 'workspace' THEN ${oc} END`;
      if (ok.kinds.includes('user')) users.push(`CASE WHEN ${tc} = 'user' THEN ${oc} END`);
      break;
    }
    default:
      break;
  }
  // Колонки-массивы (участники) и id людей внутри JSON (`personIds`) — хранитель среди элементов
  const userArrays: string[] = [];
  for (const s of policy.subjects) (field(t, s.column).list ? userArrays : users).push(colText(t, s.column, alias));
  if (policy.personIds) userArrays.push(`${q(policy.personIds.fn)}(${policy.personIds.args.map((a) => colText(t, a, alias)).join(', ')})`);

  const scopes: Prisma.Sql[] = [Prisma.sql`(h.scope = 'class' AND h.data_class = ${policy.dataClass})`];
  if (t.pk.length === 1) scopes.push(Prisma.sql`(h.scope = 'record' AND h.record_type = ${policy.id} AND h.record_id = ${Prisma.raw(`${alias}.${q(t.pk[0])}::text`)})`);
  const custodian: string[] = [];
  if (users.length) custodian.push(`h.custodian_user_id::text IN (${users.map((u) => `(${u})::text`).join(', ')})`);
  for (const arr of userArrays) custodian.push(`h.custodian_user_id::text = ANY((${arr})::text[])`);
  if (custodian.length) scopes.push(Prisma.raw(`(h.scope = 'custodian' AND (${custodian.join(' OR ')}))`));
  const spaces: string[] = [];
  if (ws) spaces.push(`(h.space_type = 'workspace' AND h.space_id = (${ws})::text)`);
  if (chat) spaces.push(`(h.space_type = 'chat' AND h.space_id = (${chat})::text)`);
  if (spaces.length) scopes.push(Prisma.raw(`(h.scope = 'space' AND (${spaces.join(' OR ')}))`));
  const tenant = ws ? Prisma.raw(`(h.workspace_id IS NULL OR h.workspace_id::text = (${ws})::text)`) : Prisma.sql`h.workspace_id IS NULL`;
  return Prisma.sql`h.released_at IS NULL AND ${tenant} AND (${Prisma.join(scopes, ' OR ')})`;
}

/** Глубина обхода `deep`-рёбер при поиске удерживаемых потомков и потолок узлов (размер оператора). */
const DESCENDANTS_MAX_DEPTH = 4;
const DESCENDANTS_MAX_NODES = 400;
const DESCENDANTS = new Map<string, Prisma.Sql | null>();

/**
 * «У строки есть удерживаемый потомок» по `deep`-рёбрам реестра (транзитивно, глубина ≤ 4):
 * удаление строки уносит потомков каскадом FK или шагом модуля (чат → сообщения, организация →
 * всё её), и заморозка потомка (хранитель автора, запись, класс) обязана держать и родителя —
 * иначе `DELETE` свободного родителя стёр бы удерживаемое каскадом. Потомок без holdAware
 * проходится насквозь (его дети могут быть удерживаемыми). `null` — удерживаемых потомков у
 * политики нет, проверка не нужна. Ссылка потомка сравнивается с ключом родителя по родному
 * типу (uuid = uuid — индекс ссылки работает).
 */
export function heldDescendantsSql(policy: LifecyclePolicy, t: LifecycleTable, alias = 't'): Prisma.Sql | null {
  const cacheable = alias === 't';
  if (cacheable && DESCENDANTS.has(policy.id)) return DESCENDANTS.get(policy.id) ?? null;
  const sql = descendantsSql(policy, t, alias, 1, new Set([policy.id]), { n: 0, root: policy.id });
  if (cacheable) DESCENDANTS.set(policy.id, sql);
  return sql;
}

function descendantsSql(
  p: LifecyclePolicy,
  pt: LifecycleTable,
  pAlias: string,
  depth: number,
  path: Set<string>,
  counter: { n: number; root: string },
): Prisma.Sql | null {
  if (depth > DESCENDANTS_MAX_DEPTH || pt.pk.length !== 1) return null;
  const parentPk = [...pt.fields.values()].find((f) => f.column === pt.pk[0]);
  const out: Prisma.Sql[] = [];
  for (const e of p.edges) {
    if (e.kind !== 'deep' || !e.via || path.has(e.to)) continue;
    const child = lifecyclePolicy(e.to);
    const ct = child ? lifecycleTableOf(child) : null;
    const via = ct?.fields.get(e.via);
    if (!child || !ct || !via) continue;
    if (++counter.n > DESCENDANTS_MAX_NODES) throw new Error(`lifecycle sql: deep edges of ${counter.root} exceed ${DESCENDANTS_MAX_NODES} nodes`);
    const a = `ld${counter.n}`;
    const childCol = `${a}.${q(via.column)}`;
    const parentCol = `${pAlias}.${q(pt.pk[0])}`;
    const link =
      via.native === 'Uuid' && parentPk?.native === 'Uuid'
        ? Prisma.raw(`${childCol} = ${parentCol}`)
        : parentPk?.native === 'Uuid'
          ? Prisma.raw(`${childCol} = ${parentCol}::text`)
          : Prisma.raw(`${childCol}::text = ${parentCol}::text`);
    path.add(e.to);
    const own = child.holdAware ? Prisma.sql`NOT (${holdFreeSql(child, ct, a)})` : null;
    const deeper = descendantsSql(child, ct, a, depth + 1, path, counter);
    path.delete(e.to);
    const cond = own && deeper ? Prisma.sql`(${own} OR ${deeper})` : (own ?? deeper);
    if (cond) out.push(Prisma.sql`EXISTS (SELECT 1 FROM ${ct.ident} ${Prisma.raw(a)} WHERE ${link} AND ${cond})`);
  }
  return out.length ? Prisma.sql`(${Prisma.join(out, ' OR ')})` : null;
}

/**
 * «Строку можно удалить сейчас»: сама не под заморозкой (если политика holdAware) и нет
 * удерживаемых потомков по `deep`-рёбрам. Ни одной действующей заморозки — быстрый путь:
 * некоррелированный EXISTS считается один раз на оператор, строки не проверяются. Для
 * ПРАВКИ строки (псевдонимизация, томбстоун) — `holdFreeSql`: потомки при правке не страдают.
 */
export function deletableSql(policy: LifecyclePolicy, t: LifecycleTable, alias = 't'): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (policy.holdAware) parts.push(holdFreeSql(policy, t, alias));
  const desc = heldDescendantsSql(policy, t, alias);
  if (desc) parts.push(Prisma.sql`NOT ${desc}`);
  if (!parts.length) return Prisma.sql`TRUE`;
  return Prisma.sql`(NOT EXISTS (SELECT 1 FROM "lifecycle_holds" WHERE released_at IS NULL) OR (${Prisma.join(parts, ' AND ')}))`;
}

/** Политике нужна проверка заморозок при удалении (своя или потомков). */
export function deleteNeedsHoldCheck(policy: LifecyclePolicy): boolean {
  const t = lifecycleTableOf(policy);
  return policy.holdAware || (!!t && heldDescendantsSql(policy, t) !== null);
}

/** Действующие заморозки, покрывающие одну строку политики (сохранение оригинала в hold store). */
export function holdsCoveringRowSql(policy: LifecyclePolicy, t: LifecycleTable, rowId: string): Prisma.Sql {
  const pkField = [...t.fields.values()].find((f) => f.column === t.pk[0]);
  if (!pkField || t.pk.length !== 1) throw new Error(`lifecycle sql: ${policy.id} has no single-column key`);
  return Prisma.sql`
    SELECT h.id::text AS id, h.workspace_id::text AS "workspaceId"
      FROM ${t.ident} t JOIN "lifecycle_holds" h ON ${holdCoversSql(policy, t)}
     WHERE ${eqSql(t, pkField.name, rowId)}`;
}

/** Правило срока политики: колонка времени, срок в сутках, условие строки. */
export interface LifecycleRule {
  index: number;
  column: string;
  days: number;
  filter?: LifecycleRowFilter;
  /** Срок выбран организацией: правило только для её строк (колонка организации — `wsColumn`) */
  workspaceId?: string;
  wsColumn?: string;
}

/** Колонка организации политики (срок, настраиваемый организацией, режется по ней). */
export function lifecycleWorkspaceColumn(policy: LifecyclePolicy): string | null {
  const ok = policy.ownerKey;
  if (ok.kind === 'scoped') return ok.workspaceColumn;
  if (ok.kind === 'workspace' && 'column' in ok) return ok.column;
  return null;
}

/** Правила срока общей пачки: основное (если срок конечен) + дополнительные. */
export function lifecycleRules(policy: LifecyclePolicy): LifecycleRule[] {
  const en = policy.enforcement;
  if (en.kind !== 'batched_delete') return [];
  const out: LifecycleRule[] = [];
  const { days } = resolveLifecycleRetention({ policy });
  if (days !== LIFECYCLE_FOREVER && days !== 0) out.push({ index: 0, column: en.column, days, filter: en.filter });
  (policy.extraRules ?? []).forEach((r, i) => out.push({ index: i + 1, column: r.column ?? en.column, days: r.days, filter: r.filter }));
  return out;
}

export function ruleCutoff(rule: Pick<LifecycleRule, 'days'>, now: Date): Date {
  return new Date(now.getTime() - rule.days * 86_400_000);
}

function candidatesWhere(policy: LifecyclePolicy, t: LifecycleTable, rule: LifecycleRule, cutoff: Date): Prisma.Sql {
  const hold = deletableSql(policy, t);
  const tenant = rule.workspaceId && rule.wsColumn ? Prisma.sql` AND ${eqSql(t, rule.wsColumn, rule.workspaceId)}` : Prisma.empty;
  return Prisma.sql`${colSql(t, rule.column)} < ${timeParamSql(t, rule.column, cutoff)}${tenant} AND ${filterSql(t, rule.filter)} AND ${hold}`;
}

/** Порядок пачки: правило организации идёт индексом (организация, id), прочие — колонкой времени. */
function batchOrder(t: LifecycleTable, rule: LifecycleRule): Prisma.Sql {
  return rule.workspaceId ? Prisma.raw(t.pk.map((c) => `t.${q(c)}`).join(', ')) : colSql(t, rule.column);
}

/**
 * Одна пачка общего удаления: старейшие строки правила, пропуская занятые (SKIP LOCKED),
 * с `NOT EXISTS (заморозка)` в самом операторе. Число удалённых — результат `$executeRaw`.
 */
export function deleteBatchSql(policy: LifecyclePolicy, t: LifecycleTable, rule: LifecycleRule, cutoff: Date, limit: number): Prisma.Sql {
  const pkList = Prisma.raw(t.pk.map((c) => `t.${q(c)}`).join(', '));
  const join = Prisma.raw(t.pk.map((c) => `t.${q(c)} = d.${q(c)}`).join(' AND '));
  return Prisma.sql`
    WITH doomed AS (
      SELECT ${pkList} FROM ${t.ident} t
      WHERE ${candidatesWhere(policy, t, rule, cutoff)}
      ORDER BY ${batchOrder(t, rule)}
      LIMIT ${limit}
      FOR UPDATE OF t SKIP LOCKED
    )
    DELETE FROM ${t.ident} t USING doomed d WHERE ${join}`;
}

/** Сколько строк правила к удалению сейчас (с потолком — счёт не читает таблицу целиком). */
export function estimateSql(policy: LifecyclePolicy, t: LifecycleTable, rule: LifecycleRule, cutoff: Date, cap: number): Prisma.Sql {
  return Prisma.sql`SELECT count(*)::bigint AS n FROM (
    SELECT 1 FROM ${t.ident} t WHERE ${candidatesWhere(policy, t, rule, cutoff)} LIMIT ${cap}
  ) x`;
}

/** Пачка строк организации по колонке (каскад удаления организации). */
export function tenantBatchSql(policy: LifecyclePolicy, t: LifecycleTable, column: string, workspaceId: string, limit: number): Prisma.Sql {
  const pkList = Prisma.raw(t.pk.map((c) => `t.${q(c)}`).join(', '));
  const join = Prisma.raw(t.pk.map((c) => `t.${q(c)} = d.${q(c)}`).join(' AND '));
  const hold = deletableSql(policy, t);
  return Prisma.sql`
    WITH doomed AS (
      SELECT ${pkList} FROM ${t.ident} t
      WHERE ${eqSql(t, column, workspaceId)} AND ${hold}
      LIMIT ${limit}
      FOR UPDATE OF t SKIP LOCKED
    )
    DELETE FROM ${t.ident} t USING doomed d WHERE ${join}`;
}

export function tenantEstimateSql(t: LifecycleTable, column: string, workspaceId: string): Prisma.Sql {
  return Prisma.sql`SELECT count(*)::bigint AS n FROM ${t.ident} t WHERE ${eqSql(t, column, workspaceId)}`;
}

/** Пачку или запрос проверки остановил потолок замка/времени (`lock_timeout` / `statement_timeout`). */
export function isQueryTimeout(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  const code = e?.meta?.code ?? e?.code;
  return code === '55P03' || code === '57014' || /lock timeout|canceling statement due to statement timeout|could not obtain lock/i.test(String(e?.message ?? ''));
}

/** Общий замок заморозок в транзакции пачки (см. `LIFECYCLE_HOLD_LOCK`). */
export async function lockHoldsShared(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${LIFECYCLE_HOLD_LOCK})`;
}

/**
 * Организация под заморозкой: любая действующая заморозка ЭТОЙ организации (класс, хранитель,
 * запись, пространство) или заморозка самого пространства «организация». Каскад удаления
 * организации такую не трогает вовсе — каскад FK от её строки снёс бы удерживаемое.
 */
export async function tenantHeld(tx: Tx, workspaceId: string): Promise<boolean> {
  const [{ held }] = await tx.$queryRaw<Array<{ held: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "lifecycle_holds"
       WHERE released_at IS NULL
         AND (workspace_id::text = ${workspaceId} OR (space_type = 'workspace' AND space_id = ${workspaceId}))
    ) AS held`;
  return held;
}

/**
 * Организация под заморозкой. Всегда — заморозки ЭТОЙ организации (`tenantHeld`). `deep` — и
 * удерживаемое среди её данных по `deep`-рёбрам строки организации (хранитель, класс, запись —
 * в том числе заморозки ПЛАТФОРМЫ): удаление строки организации унесло бы удержанное
 * FK-каскадом. Строки организации нет (уборка хвостов) — глубокой проверке не на что опереться.
 */
export async function workspaceHeld(tx: Tx, workspaceId: string, deep: boolean): Promise<boolean> {
  await lockHoldsShared(tx);
  if (await tenantHeld(tx, workspaceId)) return true;
  if (!deep) return false;
  const policy = lifecyclePolicy('Workspace');
  const t = policy ? lifecycleTableOf(policy) : null;
  if (!policy || !t) throw new Error('lifecycle: registry has no Workspace table policy');
  const [r] = await tx.$queryRaw<Array<{ held: boolean }>>`SELECT NOT ${deletableSql(policy, t)} AS held FROM ${t.ident} t WHERE ${eqSql(t, 'id', workspaceId)}`;
  return !!r?.held;
}

/** Исключительный замок — постановка заморозки ждёт идущих пачек (Э4, `LifecycleHoldsService`). */
export async function lockHoldsExclusive(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LIFECYCLE_HOLD_LOCK})`;
}

/**
 * id строк политики, которые можно удалить сейчас (`deletableSql`: сама без заморозки и без
 * удерживаемых потомков по `deep`-рёбрам) — в транзакции удаления шага модуля, под общим
 * замком. Нет ни одной заморозки — быстрый путь без чтения таблицы.
 */
export async function releasableIds(tx: Tx, policy: LifecyclePolicy, ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  await lockHoldsShared(tx);
  if (!deleteNeedsHoldCheck(policy)) return [...ids];
  const [{ any }] = await tx.$queryRaw<Array<{ any: boolean }>>`SELECT EXISTS (SELECT 1 FROM "lifecycle_holds" WHERE released_at IS NULL) AS any`;
  if (!any) return [...ids];
  const t = lifecycleTableOf(policy);
  if (!t || t.pk.length !== 1) throw new Error(`lifecycle: policy ${policy.id} has no single-column table for hold checks`);
  const pk = Prisma.raw(`t.${q(t.pk[0])}`);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT ${pk}::text AS id FROM ${t.ident} t WHERE ${pkAnySql(t, ids)} AND ${deletableSql(policy, t)}`;
  return rows.map((r) => r.id);
}

// ============================================================
// Стирание человека: общий шаг по колонкам `by` (план `lifecycleSubjectErasurePlan`)
// ============================================================

/** Строки ТОЛЬКО личные (вне организации): scoped — колонка организации пуста, polymorphic — владелец-человек. */
function personalSql(policy: LifecyclePolicy, t: LifecycleTable, alias = 't'): Prisma.Sql {
  const ok = policy.ownerKey;
  if (ok.kind === 'scoped') return Prisma.sql`${colSql(t, ok.workspaceColumn, alias)} IS NULL`;
  if (ok.kind === 'polymorphic') return Prisma.sql`${colSql(t, ok.typeColumn, alias)}::text = 'user'`;
  throw new Error(`lifecycle sql: ${policy.id} cannot tell personal rows (owner key ${ok.kind})`);
}

/** «Строка человека» общего шага: любая колонка `by` = человек (+ только личные). */
export function subjectWhereSql(policy: LifecyclePolicy, t: LifecycleTable, by: readonly string[], userId: string, personalOnly: boolean, alias = 't'): Prisma.Sql {
  if (!by.length) throw new Error(`lifecycle sql: ${policy.id} erasure step has no columns`);
  const any = Prisma.join(by.map((c) => eqSql(t, c, userId, alias)), ' OR ');
  return personalOnly ? Prisma.sql`(${any}) AND ${personalSql(policy, t, alias)}` : Prisma.sql`(${any})`;
}

/** Строковые поля псевдонимизации/редакции — только String (снимки внутри JSON правит модуль своим хуком). */
function subjectFields(t: LifecycleTable, fields: readonly string[], policyId: string): LifecycleField[] {
  return fields.map((name) => {
    const f = field(t, name);
    if (f.type !== 'String') throw new Error(`lifecycle sql: ${policyId}.${name} is ${f.type} — the generic step rewrites String fields only`);
    return f;
  });
}

/**
 * Одна пачка общего шага стирания человека: `delete` удаляет строки, `pseudonymize` пишет
 * метку томбстоуна в непустые строковые поля, `redact` — NULL. Удерживаемое пропускается
 * (`NOT EXISTS` в самом операторе), обработанные строки в следующую пачку не попадают.
 */
export function subjectBatchSql(
  policy: LifecyclePolicy,
  t: LifecycleTable,
  step: { action: 'delete' | 'pseudonymize' | 'redact'; by: readonly string[]; fields: readonly string[]; personalOnly: boolean },
  userId: string,
  label: string,
  limit: number,
): Prisma.Sql {
  const pkList = Prisma.raw(t.pk.map((c) => `t.${q(c)}`).join(', '));
  const join = Prisma.raw(t.pk.map((c) => `t.${q(c)} = d.${q(c)}`).join(' AND '));
  // Удаление уносит потомков — проверка и их заморозок; правка строки — только её собственной
  const hold = step.action === 'delete' ? deletableSql(policy, t) : policy.holdAware ? holdFreeSql(policy, t) : Prisma.sql`TRUE`;
  const who = subjectWhereSql(policy, t, step.by, userId, step.personalOnly);
  if (step.action === 'delete') {
    return Prisma.sql`
      WITH doomed AS (
        SELECT ${pkList} FROM ${t.ident} t WHERE ${who} AND ${hold} LIMIT ${limit} FOR UPDATE OF t SKIP LOCKED
      )
      DELETE FROM ${t.ident} t USING doomed d WHERE ${join}`;
  }
  const fields = subjectFields(t, step.fields, policy.id);
  const needs = step.action === 'pseudonymize'
    ? Prisma.join(fields.map((f) => Prisma.sql`(${Prisma.raw(`t.${q(f.column)}`)} IS NOT NULL AND ${Prisma.raw(`t.${q(f.column)}`)} <> ${label})`), ' OR ')
    : Prisma.raw(fields.map((f) => `t.${q(f.column)} IS NOT NULL`).join(' OR '));
  const sets = step.action === 'pseudonymize'
    ? Prisma.join(fields.map((f) => Prisma.sql`${Prisma.raw(q(f.column))} = CASE WHEN ${Prisma.raw(`t.${q(f.column)}`)} IS NULL THEN NULL ELSE ${label} END`), ', ')
    : Prisma.raw(fields.map((f) => `${q(f.column)} = NULL`).join(', '));
  return Prisma.sql`
    WITH doomed AS (
      SELECT ${pkList} FROM ${t.ident} t WHERE ${who} AND (${needs}) AND ${hold} LIMIT ${limit} FOR UPDATE OF t SKIP LOCKED
    )
    UPDATE ${t.ident} t SET ${sets} FROM doomed d WHERE ${join}`;
}

/** Сколько строк человека шаг оставил под заморозкой (заявка ждёт снятия). */
export function subjectHeldSql(
  policy: LifecyclePolicy,
  t: LifecycleTable,
  step: { action: 'delete' | 'pseudonymize' | 'redact'; by: readonly string[]; personalOnly: boolean },
  userId: string,
): Prisma.Sql {
  const free = step.action === 'delete' ? (deleteNeedsHoldCheck(policy) ? deletableSql(policy, t) : null) : policy.holdAware ? holdFreeSql(policy, t) : null;
  if (!free) return Prisma.sql`SELECT 0::bigint AS n`;
  return Prisma.sql`SELECT count(*)::bigint AS n FROM ${t.ident} t WHERE ${subjectWhereSql(policy, t, step.by, userId, step.personalOnly)} AND NOT (${free})`;
}

// ============================================================
// Канарейка стирания: предикаты «чья строка» по ключу владельца реестра
// ============================================================

/** «Личная строка человека» по ключу владельца: колонка, полиморфный владелец-человек, scoped без организации; `null` — владелец не человек. */
export function userOwnedSql(policy: LifecyclePolicy, t: LifecycleTable, userId: string, alias = 't'): Prisma.Sql | null {
  const ok = policy.ownerKey;
  if (ok.kind === 'user' && 'column' in ok) return eqSql(t, ok.column, userId, alias);
  if (ok.kind === 'polymorphic' && ok.kinds.includes('user')) return Prisma.sql`(${colSql(t, ok.typeColumn, alias)}::text = 'user' AND ${eqSql(t, ok.column, userId, alias)})`;
  if (ok.kind === 'scoped' && ok.userColumn) return Prisma.sql`(${colSql(t, ok.workspaceColumn, alias)} IS NULL AND ${eqSql(t, ok.userColumn, userId, alias)})`;
  return null;
}

/**
 * «Строка ссылается на человека»: владелец, любая колонка субъекта (автор, получатель, актор…)
 * или id внутри JSON строки (`personIds` реестра — по GIN-индексу функции); `null` — не на что опереться.
 */
export function userReferencedSql(policy: LifecyclePolicy, t: LifecycleTable, userId: string, alias = 't'): Prisma.Sql | null {
  const parts: Prisma.Sql[] = [];
  const own = userOwnedSql(policy, t, userId, alias);
  if (own) parts.push(own);
  for (const s of policy.subjects) if (t.fields.has(s.column)) parts.push(eqSql(t, s.column, userId, alias));
  if (policy.personIds) {
    const call = Prisma.raw(`${q(policy.personIds.fn)}(${policy.personIds.args.map((a) => colText(t, a, alias)).join(', ')})`);
    parts.push(Prisma.sql`(${call} @> ARRAY[${userId}]::text[] AND ${call} <> '{}'::text[])`);
  }
  return parts.length ? Prisma.sql`(${Prisma.join(parts, ' OR ')})` : null;
}

/** «Строка организации» по ключу владельца (у беседы — чат организации); `null` — организация строкой не владеет. */
export function workspaceOwnedSql(policy: LifecyclePolicy, t: LifecycleTable, workspaceId: string, alias = 't'): Prisma.Sql | null {
  const ok = policy.ownerKey;
  if (ok.kind === 'workspace' && 'column' in ok) return eqSql(t, ok.column, workspaceId, alias);
  if (ok.kind === 'scoped') return eqSql(t, ok.workspaceColumn, workspaceId, alias);
  if (ok.kind === 'polymorphic' && ok.kinds.includes('workspace')) return Prisma.sql`(${colSql(t, ok.typeColumn, alias)}::text = 'workspace' AND ${eqSql(t, ok.column, workspaceId, alias)})`;
  if (ok.kind === 'conversation' && 'column' in ok) return Prisma.sql`${colSql(t, ok.column, alias)} IN (SELECT c."id" FROM "chats" c WHERE c."workspace_id" = ${workspaceId}::uuid)`;
  return null;
}

/** Строки таблицы политики по первичному ключу — id и строка целиком текстом (проверка посева канарейки). */
export function rowsByPkSql(t: LifecycleTable, ids: readonly string[]): Prisma.Sql {
  if (t.pk.length !== 1) throw new Error(`lifecycle sql: ${t.name} has no single-column key`);
  return Prisma.sql`SELECT ${Prisma.raw(`t.${q(t.pk[0])}`)}::text AS id, to_jsonb(t)::text AS j FROM ${t.ident} t WHERE ${pkAnySql(t, ids)}`;
}

/** Удалить строки таблицы политики по первичному ключу (уборка синтетики канарейки). */
export function deleteByPkSql(t: LifecycleTable, ids: readonly string[]): Prisma.Sql {
  if (t.pk.length !== 1) throw new Error(`lifecycle sql: ${t.name} has no single-column key`);
  return Prisma.sql`DELETE FROM ${t.ident} t WHERE ${pkAnySql(t, ids)}`;
}
