import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  exportsSide,
  isMasked,
  isHidden,
  lifecycleExportFieldDenied,
  lifecycleExportPolicies,
  lifecyclePolicy,
  type LifecycleExportGuard,
  type LifecycleExportSide,
  type LifecyclePolicy,
  type VisibilityRecordType,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { VisibilityService, type ShapeInput } from '../visibility/visibility.service';
import { LifecycleExportRegistry, type LifecycleExportContext } from './lifecycle.export.registry';
import { LifecycleSettings } from './lifecycle.settings';
import {
  colSql,
  exportIdsSql,
  exportLiveSql,
  exportOwnedIdsSql,
  exportScopeSql,
  lifecycleTableOf,
  modelFieldsOf,
  pkFieldOf,
  timeParamSql,
  type LifecycleTable,
} from './lifecycle.sql';

/** Файл для архива: байты оригинала, путь в ZIP строится из id и имени. */
export interface LifecycleExportFileRef {
  fileId: string;
  storageKey: string;
  name: string;
  bytes: number;
  mime: string;
}

/** Страница сборщика: строки формы архива, курсор, файлы строк и поля под правилами видимости. */
export interface LifecycleCollectedPage {
  rows: Record<string, unknown>[];
  /** Строки уже текстом JSON (архив восстановления: `to_jsonb(t)::text` без разбора — bigint не теряет точность) */
  lines?: string[];
  next: string | null;
  files: LifecycleExportFileRef[];
  /** Поля политики, прошедшие проекцию видимости (для манифеста) */
  guarded: string[];
}

/** Перепроверка владельца нашла чужую строку — сборка останавливается целиком. */
export class LifecycleExportOwnerMismatch extends Error {
  constructor(readonly policyId: string) {
    super(`export owner re-check failed for ${policyId}`);
    this.name = 'LifecycleExportOwnerMismatch';
  }
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const INFECTED = new Set(['infected', 'blocked']);

type Row = Record<string, unknown>;

/**
 * Значение поля в JSON архива: даты ISO, большие числа и деньги строкой, байты не уходят; внутри
 * JSON-колонок ключ со словом-секретом (`token`, `signature`…) не уходит так же, как колонка.
 */
export function exportSafeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return undefined;
  if (Prisma.Decimal.isDecimal(v)) return (v as Prisma.Decimal).toString();
  if (Array.isArray(v)) return v.map(exportSafeValue).filter((x) => x !== undefined);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (lifecycleExportFieldDenied(k)) continue;
      const jv = exportSafeValue(x);
      if (jv !== undefined) out[k] = jv;
    }
    return out;
  }
  return v;
}

/** Путь поля защиты: колонка либо `колонка.ключ` внутри JSON. */
function readPath(row: Row, path: string): { has: boolean; value: unknown } {
  const [col, key] = path.split('.', 2) as [string, string | undefined];
  if (!(col in row)) return { has: false, value: undefined };
  if (key === undefined) return { has: true, value: row[col] };
  const obj = row[col];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !(key in (obj as Row))) return { has: false, value: undefined };
  return { has: true, value: (obj as Row)[key] };
}

function writePath(row: Row, path: string, value: unknown, hidden: boolean): void {
  const [col, key] = path.split('.', 2) as [string, string | undefined];
  if (key === undefined) {
    if (hidden) delete row[col];
    else row[col] = value;
    return;
  }
  const obj = { ...((row[col] as Row | null) ?? {}) };
  if (hidden) delete obj[key];
  else obj[key] = value;
  row[col] = obj;
}

/**
 * Сборщик выгрузки (core/lifecycle Э6): строки стороны по реестру — ключ владельца или
 * `exportScope`, провайдер модуля, где правил чтения больше (чаты, хроника, журнал).
 *
 * Страница общего пути: id по SQL стороны (живое, в сроке организации, keyset по ключу) →
 * строки Prisma-делегатом (ПДн расшифрованы расширением, поля по именам) → без секретов (слова
 * имени, Bytes) → поля `exportGuard` глазами заказчика (`shape()`: маска уходит маской,
 * скрытое — не уходит) → НЕЗАВИСИМАЯ перепроверка владельца по значениям загруженных строк
 * (Google Takeout 2019): чужая строка — `LifecycleExportOwnerMismatch`, сборка падает целиком.
 */
@Injectable()
export class LifecycleExportCollector implements OnApplicationBootstrap {
  private readonly logger = new Logger(LifecycleExportCollector.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly providers: LifecycleExportRegistry,
    private readonly visibility: VisibilityService,
    private readonly settings: LifecycleSettings,
  ) {}

  /**
   * Смоук бута: каждая экспортируемая сторона политики отбирается реестром (модель с одним
   * ключом и областью стороны) или провайдером модуля — иначе архив молча терял бы данные.
   */
  onApplicationBootstrap(): void {
    const problems: string[] = [];
    for (const side of ['user', 'workspace'] as const) {
      for (const p of lifecycleExportPolicies(side)) {
        if (this.providers.get(p.id, side)) continue;
        const t = lifecycleTableOf(p);
        if (!t) problems.push(`${p.id} (${side}): not a model — register a LifecycleExportRegistry provider`);
        else if (!pkFieldOf(t)) problems.push(`${p.id} (${side}): no single-column key — register a provider`);
        else if (!exportScopeSql(p, t, side, ZERO_UUID)) problems.push(`${p.id} (${side}): the owner key does not select rows of the ${side} — declare exportScope.${side} or register a provider`);
      }
    }
    if (problems.length) {
      const msg = `lifecycle export plan is invalid:\n  ${problems.join('\n  ')}`;
      this.logger.error(msg);
      throw new Error(msg);
    }
  }

  /** Политики стороны в порядке архива (родители раньше детей). */
  plan(side: LifecycleExportSide): string[] {
    return lifecycleExportPolicies(side).map((p) => p.id);
  }

  /** Сторона политики вне тарифа (провайдер решает) — строки не уходят. */
  async skipReason(ctx: LifecycleExportContext, policyId: string): Promise<'entitlement' | null> {
    return (await this.providers.get(policyId, ctx.side)?.skip?.(ctx)) ?? null;
  }

  async page(ctx: LifecycleExportContext, policyId: string, cursor: string | null, limit: number, opts: { injectForeign?: boolean } = {}): Promise<LifecycleCollectedPage> {
    const policy = lifecyclePolicy(policyId);
    if (!policy || !exportsSide(policy, ctx.side)) throw new Error(`lifecycle export: ${policyId} is not exported to ${ctx.side}`);
    const provider = this.providers.get(policyId, ctx.side);
    if (provider) {
      const page = await provider.page(ctx, cursor, limit);
      if (page.rows.length && !(await provider.verify(ctx, page.rows))) throw new LifecycleExportOwnerMismatch(policyId);
      return { rows: page.rows, next: page.next, files: [], guarded: [] };
    }
    return this.genericPage(ctx, policy, cursor, limit, opts);
  }

  private async genericPage(ctx: LifecycleExportContext, policy: LifecyclePolicy, cursor: string | null, limit: number, opts: { injectForeign?: boolean }): Promise<LifecycleCollectedPage> {
    const t = lifecycleTableOf(policy)!;
    const pk = pkFieldOf(t)!;
    const scope = exportScopeSql(policy, t, ctx.side, ctx.subjectId)!;
    const where: Prisma.Sql[] = [scope, exportLiveSql(t)];
    // Срок организации действует на чтении сразу (то, чего уже не видно, не уходит и в архив)
    if (ctx.side === 'workspace' && policy.retention.tenantConfigurable && policy.enforcement.kind === 'batched_delete') {
      const cutoff = await this.settings.readCutoff(policy, ctx.subjectId);
      if (cutoff) where.push(Prisma.sql`${colSql(t, policy.enforcement.column)} >= ${timeParamSql(t, policy.enforcement.column, cutoff)}`);
    }
    const idRows = await this.db.$queryRaw<Array<{ id: string }>>(exportIdsSql(t, Prisma.join(where, ' AND '), cursor, limit));
    const ids = idRows.map((r) => r.id);
    const next = ids.length === limit ? ids[ids.length - 1]! : null;
    // Дев-страж: чужая строка подсаживается в страницу — перепроверка обязана её поймать
    if (opts.injectForeign && ids.length) {
      const foreign = await this.db.$queryRaw<Array<{ id: string }>>(
        exportIdsSql(t, Prisma.sql`NOT (${exportScopeSql(policy, t, ctx.side, ctx.subjectId)!})`, null, 1),
      );
      if (foreign[0]) ids.push(foreign[0].id);
    }
    if (!ids.length) return { rows: [], next: null, files: [], guarded: [] };

    const delegate = (this.db as unknown as Record<string, { findMany: (a: unknown) => Promise<Row[]> }>)[policy.id.charAt(0).toLowerCase() + policy.id.slice(1)];
    if (!delegate) throw new Error(`lifecycle export: no Prisma delegate for ${policy.id}`);
    const keys = pk.type === 'BigInt' ? ids.map((id) => BigInt(id)) : ids;
    const loaded = await delegate.findMany({ where: { [pk.name]: { in: keys } }, orderBy: { [pk.name]: 'asc' } });

    await this.verifyOwned(ctx, policy, t, loaded);

    const fields = modelFieldsOf(t);
    const bytesFields = new Set(fields.filter((f) => f.type === 'Bytes').map((f) => f.name));
    const rows = loaded.map((r) => {
      const out: Row = {};
      for (const [k, v] of Object.entries(r)) {
        if (bytesFields.has(k) || lifecycleExportFieldDenied(k)) continue;
        const jv = exportSafeValue(v);
        if (jv !== undefined) out[k] = jv;
      }
      return out;
    });
    const guarded = await this.applyGuards(ctx, policy, t, rows);

    const files: LifecycleExportFileRef[] = [];
    if (policy.id === 'FileObject') {
      for (const r of loaded) {
        if (r.status !== 'ready' || INFECTED.has(String(r.scanStatus))) continue;
        files.push({ fileId: String(r.id), storageKey: String(r.storageKey), name: String(r.name ?? 'file'), bytes: Number(r.size ?? 0), mime: String(r.mime ?? 'application/octet-stream') });
      }
    }
    return { rows, next, files, guarded };
  }

  /**
   * Независимая перепроверка владельца: по ЗНАЧЕНИЯМ загруженных строк, а не тем же SQL, что их
   * выбрал. Колонки субъекта и полиморфный владелец — прямым сравнением; строки родителя по
   * `via` — отдельным запросом «эти id родителей — субъекта».
   */
  private async verifyOwned(ctx: LifecycleExportContext, policy: LifecyclePolicy, t: LifecycleTable, rows: readonly Row[]): Promise<void> {
    const subj = ctx.subjectId;
    const eq = (v: unknown) => (Array.isArray(v) ? v.map(String).includes(subj) : v !== null && v !== undefined && String(v) === subj);
    const sc = policy.exportScope?.[ctx.side];
    let ok: (r: Row) => boolean | Promise<boolean>;

    const parentOwned = async (parentId: string, values: readonly unknown[]): Promise<Set<string>> => {
      const parent = lifecyclePolicy(parentId);
      const pt = parent ? lifecycleTableOf(parent) : null;
      const vals = [...new Set(values.filter((v) => v !== null && v !== undefined).map(String))];
      if (!parent || !pt || !vals.length) return new Set();
      const sql = exportOwnedIdsSql(parent, pt, ctx.side, subj, vals);
      if (!sql) return new Set();
      return new Set((await this.db.$queryRaw<Array<{ id: string }>>(sql)).map((x) => x.id));
    };

    if (sc) {
      const viaOwned = sc.via ? await parentOwned(sc.via.policy, rows.flatMap((r) => sc.via!.columns.map((c) => r[c]))) : new Set<string>();
      ok = (r) => {
        const hit = (sc.columns ?? []).some((c) => eq(r[c])) || (sc.via?.columns ?? []).some((c) => r[c] !== null && r[c] !== undefined && viaOwned.has(String(r[c])));
        const filtered = Object.entries(sc.filter ?? {}).every(([c, values]) => values.some((v) => (v === null ? r[c] === null || r[c] === undefined : String(r[c]) === v)));
        return hit && filtered;
      };
    } else {
      const k = policy.ownerKey;
      if (ctx.side === 'user' && k.kind === 'user' && 'column' in k) ok = (r) => eq(r[k.column]);
      else if (ctx.side === 'workspace' && k.kind === 'workspace' && 'column' in k) ok = (r) => eq(r[k.column]);
      else if (k.kind === 'polymorphic') ok = (r) => String(r[k.typeColumn]) === ctx.side && eq(r[k.column]);
      else if (k.kind === 'scoped' && ctx.side === 'workspace') ok = (r) => eq(r[k.workspaceColumn]);
      else if (k.kind === 'scoped' && ctx.side === 'user' && k.userColumn) ok = (r) => (r[k.workspaceColumn] === null || r[k.workspaceColumn] === undefined) && eq(r[k.userColumn!]);
      else if (k.kind !== 'global' && 'via' in k) {
        const parent = lifecyclePolicy(k.via);
        const column = parent?.edges.find((e) => e.to === policy.id && !!e.via)?.via;
        if (!parent || !column) throw new LifecycleExportOwnerMismatch(policy.id);
        const owned = await parentOwned(parent.id, rows.map((r) => r[column]));
        ok = (r) => r[column] !== null && r[column] !== undefined && owned.has(String(r[column]));
      } else throw new LifecycleExportOwnerMismatch(policy.id);
    }
    for (const r of rows) {
      if (!(await ok(r))) {
        this.logger.error(`export ${ctx.exportId}: row of ${policy.id} does not belong to the ${ctx.side} — the build stops`);
        throw new LifecycleExportOwnerMismatch(policy.id);
      }
    }
    void t;
  }

  /**
   * Поля `exportGuard` глазами заказчика: пачкой на тип и организацию строки. Маска уходит
   * объектом `{ masked }`, скрытое — не уходит; сбой проекции — поле не уходит (fail-closed).
   */
  private async applyGuards(ctx: LifecycleExportContext, policy: LifecyclePolicy, t: LifecycleTable, rows: Row[]): Promise<string[]> {
    const guards = policy.exportGuard ?? [];
    if (!guards.length || !rows.length) return [];
    const pk = pkFieldOf(t)!;
    const wsField = t.fields.has('workspaceId') ? 'workspaceId' : null;
    const guarded = new Set<string>();
    for (const g of guards as readonly LifecycleExportGuard[]) {
      const paths = Object.keys(g.fields);
      paths.forEach((p) => guarded.add(p));
      // Зритель — заказчик в организации строки (у архива организации — она сама)
      const groups = new Map<string, number[]>();
      rows.forEach((r, i) => {
        const ws = ctx.side === 'workspace' ? ctx.subjectId : wsField && r[wsField] ? String(r[wsField]) : '';
        if (!groups.has(ws)) groups.set(ws, []);
        groups.get(ws)!.push(i);
      });
      for (const [ws, idx] of groups) {
        const inputs: ShapeInput[] = idx.map((i) => {
          const r = rows[i]!;
          const values: Record<string, unknown> = {};
          for (const path of paths) {
            const { has, value } = readPath(r, path);
            if (has) values[g.fields[path]!] = typeof value === 'number' ? String(value) : value;
          }
          return {
            ref: {
              recordId: String(r[pk.name]),
              subjectId: g.subject && r[g.subject] ? String(r[g.subject]) : null,
              workspaceId: ws || null,
              stage: g.stage && r[g.stage] ? String(r[g.stage]) : null,
              branchId: g.branch && r[g.branch] ? String(r[g.branch]) : null,
            },
            values,
          };
        });
        let shaped: Array<Record<string, unknown>> | null = null;
        try {
          shaped = await this.visibility.shape(this.visibility.viewerFor(ctx.requesterId, ws || null, 'export'), g.type as VisibilityRecordType, inputs);
        } catch (err) {
          this.logger.warn(`export ${ctx.exportId}: visibility shape of ${policy.id} failed (${(err as Error).message}) — guarded fields withheld`);
        }
        idx.forEach((i, k) => {
          const r = rows[i]!;
          for (const path of paths) {
            if (!readPath(r, path).has) continue;
            const v = shaped?.[k]?.[g.fields[path]!];
            if (!shaped || v === undefined || isHidden(v)) writePath(r, path, null, true);
            else if (isMasked(v)) writePath(r, path, { masked: v.display }, false);
            else writePath(r, path, v, false);
          }
        });
      }
    }
    return [...guarded];
  }
}
