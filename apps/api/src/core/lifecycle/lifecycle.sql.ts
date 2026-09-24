import { Prisma } from '@prisma/client';
import { LIFECYCLE_FOREVER, resolveLifecycleRetention, type LifecyclePolicy, type LifecycleRowFilter } from '@superapp/shared';
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
    fields.set(f.name, { name: f.name, column: f.dbName ?? f.name, native, type: f.type });
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
      if ('column' in ok) chat = colText(t, ok.column, alias);
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
  for (const s of policy.subjects) users.push(colText(t, s.column, alias));

  const scopes: Prisma.Sql[] = [Prisma.sql`(h.scope = 'class' AND h.data_class = ${policy.dataClass})`];
  if (t.pk.length === 1) scopes.push(Prisma.sql`(h.scope = 'record' AND h.record_type = ${policy.id} AND h.record_id = ${Prisma.raw(`${alias}.${q(t.pk[0])}::text`)})`);
  if (users.length) scopes.push(Prisma.sql`(h.scope = 'custodian' AND h.custodian_user_id::text IN (${Prisma.raw(users.map((u) => `(${u})::text`).join(', '))}))`);
  const spaces: string[] = [];
  if (ws) spaces.push(`(h.space_type = 'workspace' AND h.space_id = (${ws})::text)`);
  if (chat) spaces.push(`(h.space_type = 'chat' AND h.space_id = (${chat})::text)`);
  if (spaces.length) scopes.push(Prisma.raw(`(h.scope = 'space' AND (${spaces.join(' OR ')}))`));
  const tenant = ws ? Prisma.raw(`(h.workspace_id IS NULL OR h.workspace_id::text = (${ws})::text)`) : Prisma.sql`h.workspace_id IS NULL`;
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "lifecycle_holds" h
    WHERE h.released_at IS NULL AND ${tenant} AND (${Prisma.join(scopes, ' OR ')})
  )`;
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
  const hold = policy.holdAware ? holdFreeSql(policy, t) : Prisma.sql`TRUE`;
  const tenant = rule.workspaceId && rule.wsColumn ? Prisma.sql` AND ${colSql(t, rule.wsColumn)}::text = ${rule.workspaceId}` : Prisma.empty;
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
  const hold = policy.holdAware ? holdFreeSql(policy, t) : Prisma.sql`TRUE`;
  return Prisma.sql`
    WITH doomed AS (
      SELECT ${pkList} FROM ${t.ident} t
      WHERE ${colSql(t, column)}::text = ${workspaceId} AND ${hold}
      LIMIT ${limit}
      FOR UPDATE OF t SKIP LOCKED
    )
    DELETE FROM ${t.ident} t USING doomed d WHERE ${join}`;
}

export function tenantEstimateSql(t: LifecycleTable, column: string, workspaceId: string): Prisma.Sql {
  return Prisma.sql`SELECT count(*)::bigint AS n FROM ${t.ident} t WHERE ${colSql(t, column)}::text = ${workspaceId}`;
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

/** Исключительный замок — постановка заморозки ждёт идущих пачек (Э4, `LifecycleHoldsService`). */
export async function lockHoldsExclusive(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LIFECYCLE_HOLD_LOCK})`;
}

/**
 * id строк политики без действующей заморозки — в транзакции удаления шага модуля, под
 * общим замком. Нет ни одной заморозки — быстрый путь без чтения таблицы.
 */
export async function releasableIds(tx: Tx, policy: LifecyclePolicy, ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  await lockHoldsShared(tx);
  if (!policy.holdAware) return [...ids];
  const [{ any }] = await tx.$queryRaw<Array<{ any: boolean }>>`SELECT EXISTS (SELECT 1 FROM "lifecycle_holds" WHERE released_at IS NULL) AS any`;
  if (!any) return [...ids];
  const t = lifecycleTableOf(policy);
  if (!t || t.pk.length !== 1) throw new Error(`lifecycle: policy ${policy.id} has no single-column table for hold checks`);
  const pk = Prisma.raw(`t.${q(t.pk[0])}`);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT ${pk}::text AS id FROM ${t.ident} t WHERE ${pk}::text = ANY(${[...ids]}::text[]) AND ${holdFreeSql(policy, t)}`;
  return rows.map((r) => r.id);
}
