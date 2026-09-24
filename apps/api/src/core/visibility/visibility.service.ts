import { Injectable, Logger } from '@nestjs/common';
import {
  HIDDEN,
  VISIBILITY_CLASS_RANK,
  VISIBILITY_ERROR_CODES,
  VISIBILITY_EXTERNAL_PURPOSES,
  VISIBILITY_LEVEL_RANK,
  VISIBILITY_LIMITS,
  VISIBILITY_REDIS,
  WORKSPACE_ROLE_RANK,
  applyMask,
  isGuardMarker,
  isVisibilityRecordType,
  looksMasked,
  visibilityFieldEntry,
  visibilityFieldsOf,
  visibilityTypeDef,
  type Guarded,
  type Masked,
  type VisibilityExplainDto,
  type VisibilityFieldCap,
  type VisibilityFieldEntry,
  type VisibilityMaskKind,
  type VisibilityPlanDto,
  type VisibilityPurpose,
  type VisibilityRecordType,
  type VisibilityTypeDef,
  type WorkspaceRole,
} from '@superapp/shared';
import { WorkspaceContextService } from '../../shared/context/workspace-context.service';
import { DatabaseService } from '../../shared/database/database.service';
import { badRequest, forbidden } from '../../shared/errors/api-error';
import { RedisService } from '../../shared/redis/redis.service';
import { AccessService } from '../access/access.service';
import { RolesService } from '../roles/roles.service';
import { TtlLru, VisibilityCache } from './visibility.cache';
import { VisibilityMetrics } from './visibility.metrics';
import { VisibilityScrapeDetector } from './visibility.scrape.service';
import {
  EMPTY_POLICY,
  HIDDEN_DECISION,
  decideControllerField,
  decidePersonalField,
  normalizeForMask,
  personalSetting,
  projectValue,
  type CompiledPolicy,
  type FieldDecision,
  type PersonalRelation,
  type RowRelation,
  type ViewerFacts,
} from './visibility.plan';
import {
  VisibilityPersonalGraphRegistry,
  VisibilityRelationRegistry,
  type VisibilityPersonalGraphRelation,
  type VisibilityRecordRef,
} from './visibility.registry';

/** «Шляпа» запроса: кто смотрит и в каком контексте. Одна на запрос (решение §5.5 п. 7). */
export interface VisibilityViewer {
  userId: string | null;
  kind: 'user' | 'bot' | 'guest' | 'system';
  /** Организация из адреса (`X-Workspace-Id`) — владелец служебной политики по умолчанию */
  workspaceId: string | null;
  keyId: string | null;
  /** Ключу выдан флаг «Доступ к контактным данным» (R9) */
  botContactAccess: boolean;
  purpose: VisibilityPurpose;
  /**
   * Синтетический зритель РОЛИ (предпросмотр «как видит сотрудник»): решения по одной роли
   * организации, без отделов/должностей/объектов и без «сам» — никакой чужой сессии и токена.
   */
  asRole?: WorkspaceRole;
}

/** Одна запись на вход `shape`: кто она (для «сам»/руководителя/этапа) и сырые значения полей. */
export interface ShapeInput {
  ref: VisibilityRecordRef;
  /** Ключи реестра (секции) или пола типа → сырое значение. Поля, которых нет, не читаются. */
  values: Record<string, unknown>;
}

export type ShapedValues = Record<string, Guarded<unknown>>;

/** Бренд ответа, прошедшего `shape()` (невидим в JSON): страж ответа не трогает брендированные объекты. */
export const VISIBILITY_SHAPED = Symbol.for('superapp.visibility.shaped');

export function markShaped<T extends object>(obj: T): T {
  if (obj && typeof obj === 'object' && !Object.prototype.hasOwnProperty.call(obj, VISIBILITY_SHAPED)) {
    Object.defineProperty(obj, VISIBILITY_SHAPED, { value: true, enumerable: false });
  }
  return obj;
}

export function isShaped(obj: unknown): boolean {
  return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, VISIBILITY_SHAPED);
}

/**
 * Кэшируемые факты о зрителе — ТОЛЬКО принципалы оргструктуры (их эпоха живёт в ключе).
 * Роль в организации сюда не кладётся намеренно: роли живут в `user_roles`, а в рёбра
 * `core/access` попадают проекцией best-effort, и не всякая смена роли меняет ребро
 * (Сотрудник ↔ Стажёр — одно и то же `member`): эпоха не бампалась бы, и бывший Сотрудник
 * жил бы в кэше ролью ещё 5 минут. Роль читается из `RolesService` — его кэш сбрасывается
 * самой сменой роли.
 */
interface ViewerFactsCached {
  principals: string[];
}

/** План зрителя по типу в одной организации — считается ОДИН раз на запрос. */
interface Prepared {
  recordType: string;
  def: VisibilityTypeDef;
  viewer: VisibilityViewer;
  workspaceId: string | null;
  facts: ViewerFacts;
  policy: CompiledPolicy;
  subordinates: ReadonlySet<string>;
  headed: ReadonlySet<string>;
  payroll: ReadonlySet<string>;
  /** Объекты, где зритель ведёт график (руководитель/управляющий/делегат `scheduler`) */
  scheduled: ReadonlySet<string>;
  /** Объекты субъектов (лениво, пакетом) — для «руководитель объекта субъекта» */
  subjectBranches: Map<string, string[]>;
}

/** Запрос к списку (чокпойнт Q): по каким полям фильтр, сортировка, поиск, группировка, агрегат. */
export interface VisibilityQuerySpec {
  filter?: readonly string[];
  sort?: readonly string[];
  search?: readonly string[];
  group?: readonly string[];
  aggregate?: readonly string[];
}

/** Изменение хроники в форме движка (`changes[] from/to`). */
export interface VisibilityChange {
  field: string;
  from: unknown;
  to: unknown;
  [k: string]: unknown;
}

const ROLE_ORDER = Object.keys(WORKSPACE_ROLE_RANK) as WorkspaceRole[];
const WS_CONTEXT = 'workspace';

/**
 * core/visibility — 27-й платформенный движок: «какие ПОЛЯ видимой записи и в каком виде».
 * Тонкий слой НАД `core/access` (право на запись решает он и гейт сервиса). Семь чокпойнтов:
 * D — решение (`visibility.plan.ts`), Q — `assertQueryable`, P — `shape`, W — `assertWritable`,
 * R — `maskChanges` (хроника) и рендер уведомлений, E — `forExternal`, L — журнал (раскрытие).
 * Любая неясность — `hidden` (fail-closed). docs/visibility_engine.md.
 */
@Injectable()
export class VisibilityService {
  private readonly logger = new Logger(VisibilityService.name);
  private readonly factsL1 = new TtlLru<ViewerFactsCached>(VISIBILITY_LIMITS.planL1Max, VISIBILITY_LIMITS.planL1TtlMs);
  private readonly prepMemo = new WeakMap<object, Map<string, Prepared>>();

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly ctx: WorkspaceContextService,
    private readonly access: AccessService,
    private readonly roles: RolesService,
    private readonly cache: VisibilityCache,
    private readonly relations: VisibilityRelationRegistry,
    private readonly graph: VisibilityPersonalGraphRegistry,
    private readonly metrics: VisibilityMetrics,
    private readonly scrape: VisibilityScrapeDetector,
  ) {}

  // ============================================================
  // Зритель
  // ============================================================

  /** Зритель текущего запроса (из ALS): человек сессией, бот/ключ, организация из адреса. */
  viewer(purpose: VisibilityPurpose = 'api', overrides: Partial<VisibilityViewer> = {}): VisibilityViewer {
    const store = this.ctx.get();
    const actor = store?.request?.actor;
    const userId = overrides.userId !== undefined ? overrides.userId : (store?.userId ?? actor?.id ?? null);
    const viaKey = !!actor?.keyId || actor?.kind === 'bot';
    return {
      userId,
      kind: overrides.kind ?? (userId ? (viaKey ? 'bot' : 'user') : 'guest'),
      workspaceId: overrides.workspaceId !== undefined ? overrides.workspaceId : (store?.activeWorkspaceId ?? null),
      keyId: overrides.keyId !== undefined ? overrides.keyId : (actor?.keyId ?? null),
      // R9: флаг ключа/бота «Доступ к контактным данным» — из снимка аутентификации
      botContactAccess: overrides.botContactAccess ?? (viaKey && !!actor?.contactAccess),
      purpose: overrides.purpose ?? purpose,
    };
  }

  /** Зритель от имени человека вне запроса (джоб, синтетический зритель «Проверить сотрудника»). */
  viewerFor(userId: string, workspaceId: string | null, purpose: VisibilityPurpose = 'api'): VisibilityViewer {
    return { userId, kind: 'user', workspaceId, keyId: null, botContactAccess: false, purpose };
  }

  /**
   * Синтетический зритель роли организации — предпросмотр «как видит сотрудник/менеджер»
   * для владельца/админа (право проверяет вызывающий). Не человек: «сам», руководитель и
   * раскрытие для него не срабатывают.
   */
  roleViewer(workspaceId: string, role: WorkspaceRole): VisibilityViewer {
    return { userId: null, kind: 'user', workspaceId, keyId: null, botContactAccess: false, purpose: 'api', asRole: role };
  }

  /** Гость ссылки наружу: только публичные поля. */
  guestViewer(): VisibilityViewer {
    return { userId: null, kind: 'guest', workspaceId: null, keyId: null, botContactAccess: false, purpose: 'guest' };
  }

  /**
   * Системный зритель — ТОЛЬКО для путей, которые сами не формируют ответ человеку (печать
   * шаблонов, выплаты, джобы). `system*` методы сервисов ответ не формируют (урок Odoo `su`).
   */
  systemViewer(): VisibilityViewer {
    return { userId: null, kind: 'system', workspaceId: null, keyId: null, botContactAccess: false, purpose: 'api' };
  }

  // ============================================================
  // D — подготовка плана
  // ============================================================

  private memoFor(): Map<string, Prepared> | null {
    const store = this.ctx.get();
    if (!store) return null;
    let m = this.prepMemo.get(store);
    if (!m) {
      m = new Map();
      this.prepMemo.set(store, m);
    }
    return m;
  }

  /** Старшая роль зрителя в организации — свежая (кэш `RolesService` сбрасывает сама смена роли). */
  private async roleIn(userId: string, workspaceId: string | null): Promise<WorkspaceRole | null> {
    if (!workspaceId) return null;
    let role: WorkspaceRole | null = null;
    for (const r of await this.roles.getUserRoles(userId)) {
      if (r.context !== WS_CONTEXT || r.tenantId !== workspaceId) continue;
      const rr = r.role as WorkspaceRole;
      if (!ROLE_ORDER.includes(rr)) continue;
      if (!role || WORKSPACE_ROLE_RANK[rr] > WORKSPACE_ROLE_RANK[role]) role = rr;
    }
    return role;
  }

  /** Принципалы оргструктуры зрителя: L1 (≤ 30 с) → L2 Redis (5 мин) → БД; ключ несёт эпоху принципалов. */
  private async factsCached(userId: string, workspaceId: string | null): Promise<ViewerFactsCached> {
    const epoch = await this.access.principalsEpoch();
    const key = VISIBILITY_REDIS.facts(workspaceId, userId, epoch);
    const l1 = this.factsL1.get(key);
    if (l1) {
      this.metrics.plan.inc({ hit: 'l1' });
      return l1;
    }
    try {
      const raw = await this.redis.get(key);
      if (raw) {
        const v = JSON.parse(raw) as ViewerFactsCached;
        if (Array.isArray(v?.principals)) {
          this.factsL1.set(key, v);
          this.metrics.plan.inc({ hit: 'l2' });
          return v;
        }
      }
    } catch {
      /* мимо кэша */
    }
    this.metrics.plan.inc({ hit: 'miss' });
    const principals = await this.access.principalsOf(userId);
    const v: ViewerFactsCached = {
      principals: principals
        .filter((p) => p.subjectType === 'department' || p.subjectType === 'position' || p.subjectType === 'branch')
        .map((p) => `${p.subjectType}:${p.subjectId}`),
    };
    this.factsL1.set(key, v);
    void this.redis.set(key, JSON.stringify(v), VISIBILITY_LIMITS.planL2TtlSec).catch(() => undefined);
    return v;
  }

  private async prepare(viewer: VisibilityViewer, recordType: string, workspaceId: string | null): Promise<Prepared> {
    const def = visibilityTypeDef(recordType);
    if (!def) throw badRequest(VISIBILITY_ERROR_CODES.unknownRecordType, undefined, { code: VISIBILITY_ERROR_CODES.unknownRecordType });
    const memoKey = `${recordType}|${workspaceId ?? '-'}|${viewer.userId ?? '-'}|${viewer.kind}|${viewer.purpose}|${viewer.botContactAccess ? 1 : 0}|${viewer.asRole ?? '-'}`;
    const memo = this.memoFor();
    const hit = memo?.get(memoKey);
    if (hit) return hit;

    let role: WorkspaceRole | null = null;
    let principals = new Set<string>();
    if (viewer.asRole) {
      role = viewer.asRole;
    } else if (viewer.userId && viewer.kind !== 'guest' && viewer.kind !== 'system') {
      const [r, f] = await Promise.all([this.roleIn(viewer.userId, workspaceId), this.factsCached(viewer.userId, workspaceId)]);
      role = r;
      principals = new Set(f.principals);
    }
    // Служебная политика — у организации записи; личная (user.card) — у каждого субъекта (в shape)
    const policy = def.owner === 'workspace' && workspaceId ? await this.cache.policy('workspace', workspaceId, recordType) : EMPTY_POLICY;

    const needsRelations =
      def.owner === 'workspace' &&
      !!workspaceId &&
      !!viewer.userId &&
      viewer.kind === 'user' &&
      (policy.rules.some((r) => r.audienceKind === 'manager_of' || r.audienceKind === 'branch_head_of' || r.audienceKind === 'branch_payroll' || r.audienceKind === 'branch_scheduler' || r.reveal === 'delegated') ||
        visibilityFieldsOf(recordType).some((e) => {
          const t = def.sections[e.section]?.defaults?.relative ?? e.def.defaults?.relative ?? def.defaults.relative;
          return !!t && Object.keys(t).length > 0;
        }));
    const provider = this.relations.get();
    let subordinates = new Set<string>();
    let headed = new Set<string>();
    let payroll = new Set<string>();
    let scheduled = new Set<string>();
    if (needsRelations && provider && workspaceId && viewer.userId) {
      const [s, h, p, sc] = await Promise.all([
        provider.subordinateIdsOf(workspaceId, viewer.userId).catch(() => [] as string[]),
        provider.headedBranchIdsOf(workspaceId, viewer.userId).catch(() => [] as string[]),
        provider.payrollBranchIdsOf(workspaceId, viewer.userId).catch(() => [] as string[]),
        provider.schedulerBranchIdsOf(workspaceId, viewer.userId).catch(() => [] as string[]),
      ]);
      subordinates = new Set(s);
      headed = new Set(h);
      payroll = new Set(p);
      scheduled = new Set(sc);
    }

    let revealDelegation = false;
    if (workspaceId && policy.rules.some((r) => r.reveal === 'delegated')) {
      const s = await this.db.workspaceVisibilitySettings.findUnique({ where: { workspaceId }, select: { allowDelegation: true } });
      revealDelegation = !!s?.allowDelegation;
    }

    const prepared: Prepared = {
      recordType,
      def,
      viewer,
      workspaceId,
      facts: {
        kind: viewer.kind,
        userId: viewer.userId,
        role,
        principals,
        botContactAccess: viewer.botContactAccess,
        purpose: viewer.purpose,
        revealDelegation,
      },
      policy,
      subordinates,
      headed,
      payroll,
      scheduled,
      subjectBranches: new Map(),
    };
    memo?.set(memoKey, prepared);
    return prepared;
  }

  /** Объекты субъектов пакетом (для «руководитель объекта / видит деньги» по человеку без объекта в записи). */
  private async loadSubjectBranches(p: Prepared, subjectIds: readonly string[]): Promise<void> {
    if (!p.workspaceId || (!p.headed.size && !p.payroll.size && !p.scheduled.size)) return;
    const need = [...new Set(subjectIds)].filter((id) => !p.subjectBranches.has(id));
    if (!need.length) return;
    const provider = this.relations.get();
    if (!provider) return;
    const map = await provider.branchIdsOfUsers(p.workspaceId, need).catch(() => new Map<string, string[]>());
    for (const id of need) p.subjectBranches.set(id, map.get(id) ?? []);
  }

  private rowRelation(p: Prepared, ref: VisibilityRecordRef | null): RowRelation {
    const subjectId = ref?.subjectId ?? null;
    const self = !!subjectId && !!p.viewer.userId && subjectId === p.viewer.userId && p.viewer.kind === 'user';
    const branchId = ref?.branchId ?? null;
    const subjectBranches = subjectId ? (p.subjectBranches.get(subjectId) ?? []) : [];
    const inSet = (set: ReadonlySet<string>) => (branchId ? set.has(branchId) : subjectBranches.some((b) => set.has(b)));
    return {
      self,
      managerOf: !!subjectId && p.subordinates.has(subjectId),
      branchHead: inSet(p.headed),
      branchPayroll: inSet(p.payroll),
      branchScheduler: inSet(p.scheduled),
      stage: ref?.stage ?? null,
    };
  }

  private decideController(p: Prepared, entry: VisibilityFieldEntry, ref: VisibilityRecordRef | null): FieldDecision {
    return this.decideWithRelation(p, entry, this.rowRelation(p, ref));
  }

  private decideWithRelation(p: Prepared, entry: VisibilityFieldEntry, rel: RowRelation): FieldDecision {
    try {
      return decideControllerField(p.recordType, entry, p.policy, p.facts, rel);
    } catch (err) {
      this.metrics.failClosed.inc({ record_type: p.recordType });
      this.logger.error(`visibility decision failed (${p.recordType}.${entry.key}): ${(err as Error).message}`);
      return HIDDEN_DECISION({ source: 'error' });
    }
  }

  // ============================================================
  // P — проекция ответа
  // ============================================================

  /**
   * P: проекция пачки записей одного типа. Возвращает по каждой записи объект «ключ поля →
   * `Guarded`». Поля пола проходят как есть; ключ вне реестра — `Hidden` (поле без класса =
   * скрыто, урок Spoutible). Внешнее назначение (вебхук/гость/ИИ) — зовите `forExternal`.
   */
  async shape(viewer: VisibilityViewer, recordType: VisibilityRecordType, inputs: readonly ShapeInput[]): Promise<ShapedValues[]> {
    const started = process.hrtime.bigint();
    const def = visibilityTypeDef(recordType);
    if (!def) throw new Error(`visibility: unknown record type ${recordType}`);
    const floor = new Set(def.floor);
    const out: ShapedValues[] = inputs.map(() => ({}));
    if (!inputs.length) return out;
    // Детекция скрейпинга: чужие строки, где хоть одно поле класса ≥ contact ушло целиком
    let exposedRows = 0;

    if (def.owner === 'user') {
      exposedRows = await this.shapePersonal(viewer, recordType, def, inputs, out, floor);
    } else {
      const byWs = new Map<string, number[]>();
      inputs.forEach((inp, i) => {
        const ws = inp.ref.workspaceId ?? viewer.workspaceId ?? '';
        const arr = byWs.get(ws);
        if (arr) arr.push(i);
        else byWs.set(ws, [i]);
      });
      for (const [ws, idxs] of byWs) {
        const p = await this.prepare(viewer, recordType, ws || null);
        await this.loadSubjectBranches(p, idxs.map((i) => inputs[i]!.ref.subjectId).filter((x): x is string => !!x));
        // Решение зависит только от поля и ОТНОШЕНИЯ зрителя к строке (сам / руководитель /
        // объект / этап), а их сочетаний единицы: считаем одно решение на (поле × отношение),
        // а не на каждую строку — 10k строк × 10 полей = десятки решений, не 100k
        const memo = new Map<string, FieldDecision>();
        for (const i of idxs) {
          const inp = inputs[i]!;
          const res = out[i]!;
          const rel = this.rowRelation(p, inp.ref);
          let exposed = false;
          const relKey = `${rel.self ? 1 : 0}${rel.managerOf ? 1 : 0}${rel.branchHead ? 1 : 0}${rel.branchPayroll ? 1 : 0}${rel.branchScheduler ? 1 : 0}|${rel.stage ?? ''}`;
          for (const [key, value] of Object.entries(inp.values)) {
            if (floor.has(key)) {
              res[key] = value;
              continue;
            }
            const entry = visibilityFieldEntry(recordType, key);
            if (!entry) {
              res[key] = HIDDEN;
              continue;
            }
            const memoKey = `${key}|${relKey}`;
            let d = memo.get(memoKey);
            if (!d) {
              d = this.decideWithRelation(p, entry, rel);
              memo.set(memoKey, d);
            }
            res[key] = projectValue(entry, d, value);
            if (!exposed && !rel.self && d.level === 'full' && isExposing(entry, value)) exposed = true;
          }
          if (exposed) exposedRows += 1;
        }
      }
    }
    this.scrape.count(viewer, recordType, exposedRows);
    this.metrics.shapeSeconds.observe({ record_type: recordType }, Number(process.hrtime.bigint() - started) / 1e9);
    return out;
  }

  /**
   * Маркер маски для ПРОИЗВОДНОГО значения проекции (дата рождения из двух полей реестра:
   * день-месяц виден, год — нет). Маску по-прежнему считает движок, фича лишь сообщает, какую.
   */
  maskValue(mask: VisibilityMaskKind, value: unknown): Masked {
    return { $v: 'masked', mask, display: applyMask(mask, normalizeForMask(value)), reveal: 'none' };
  }

  /** Одна запись. */
  async shapeOne(viewer: VisibilityViewer, recordType: VisibilityRecordType, input: ShapeInput): Promise<ShapedValues> {
    return (await this.shape(viewer, recordType, [input]))[0]!;
  }

  /** Личные поля: у каждого субъекта своя политика; связь зрителя — пакетом из личного графа. Возвращает число чужих строк с полями ≥ contact целиком. */
  private async shapePersonal(
    viewer: VisibilityViewer,
    recordType: string,
    def: VisibilityTypeDef,
    inputs: readonly ShapeInput[],
    out: ShapedValues[],
    floor: ReadonlySet<string>,
  ): Promise<number> {
    const p = await this.prepare(viewer, recordType, null);
    const subjectIds = [...new Set(inputs.map((i) => i.ref.subjectId).filter((x): x is string => !!x))];
    const [policies, relations, viewerPolicy] = await Promise.all([
      this.cache.policies('user', subjectIds, recordType),
      this.personalRelations(viewer, subjectIds),
      viewer.userId && viewer.kind === 'user' ? this.cache.policy('user', viewer.userId, recordType) : Promise.resolve(EMPTY_POLICY),
    ]);
    const presence = visibilityFieldsOf(recordType).find((e) => e.def.reciprocal);
    let exposedRows = 0;
    inputs.forEach((inp, i) => {
      const res = out[i]!;
      const subjectId = inp.ref.subjectId;
      const policy = (subjectId && policies.get(subjectId)) || EMPTY_POLICY;
      const rel = this.personalRelation(viewer, subjectId, relations.get(subjectId ?? ''), presence, viewerPolicy, recordType);
      let exposed = false;
      for (const [key, value] of Object.entries(inp.values)) {
        if (floor.has(key)) {
          res[key] = value;
          continue;
        }
        const entry = visibilityFieldEntry(recordType, key);
        if (!entry || entry.def.control !== 'subject') {
          res[key] = HIDDEN;
          continue;
        }
        let d: FieldDecision;
        try {
          d = decidePersonalField(recordType, entry, personalSetting(recordType, entry, policy), p.facts, rel);
        } catch (err) {
          this.metrics.failClosed.inc({ record_type: recordType });
          this.logger.error(`visibility personal decision failed (${recordType}.${key}): ${(err as Error).message}`);
          d = HIDDEN_DECISION({ source: 'error' });
        }
        res[key] = projectValue(entry, d, value);
        if (!exposed && !rel.self && d.level === 'full' && isExposing(entry, value)) exposed = true;
      }
      if (exposed) exposedRows += 1;
    });
    void def;
    return exposedRows;
  }

  private async personalRelations(viewer: VisibilityViewer, subjectIds: readonly string[]): Promise<Map<string, VisibilityPersonalGraphRelation>> {
    const provider = this.graph.get();
    if (!provider || !viewer.userId || viewer.kind === 'guest' || !subjectIds.length) return new Map();
    const others = subjectIds.filter((id) => id !== viewer.userId);
    if (!others.length) return new Map();
    return provider.relationsOf(viewer.userId, others);
  }

  /** Отношение зрителя к субъекту + взаимность: показывает ли зритель СВОЁ присутствие субъекту. */
  private personalRelation(
    viewer: VisibilityViewer,
    subjectId: string | null,
    g: VisibilityPersonalGraphRelation | undefined,
    presence: VisibilityFieldEntry | undefined,
    viewerPolicy: CompiledPolicy,
    recordType: string,
  ): PersonalRelation {
    const self = !!subjectId && !!viewer.userId && subjectId === viewer.userId;
    const rel: PersonalRelation = {
      self,
      linked: !!g?.linked,
      circleIds: new Set(g?.subjectCircleIds ?? []),
      colleagueWorkspaceIds: new Set(g?.sharedWorkspaceIds ?? []),
    };
    if (!self && presence && viewer.userId && subjectId && viewer.kind === 'user') {
      // Что ЗРИТЕЛЬ сам показывает субъекту: его настройка присутствия глазами субъекта
      const inverse: PersonalRelation = { self: false, linked: rel.linked, circleIds: new Set(g?.viewerCircleIds ?? []), colleagueWorkspaceIds: rel.colleagueWorkspaceIds };
      const mine = decidePersonalField(recordType, presence, personalSetting(recordType, presence, viewerPolicy), { ...systemlessFacts(subjectId) }, inverse);
      rel.viewerHidesOwnPresence = mine.level !== 'full';
    }
    return rel;
  }

  // ============================================================
  // select(plan) — не читать то, что никому из этой пачки не видно
  // ============================================================

  /**
   * Поля, которые МОГУТ оказаться видны зрителю хоть в какой-то записи (≥ masked базово, через
   * «сам» или относительного адресата). Остальные сервис не выбирает из БД вовсе: нет
   * расшифровки — нет `pii.read`. Личные поля (решает субъект) — читаются всегда.
   */
  async readableFields(viewer: VisibilityViewer, recordType: VisibilityRecordType, workspaceId?: string | null): Promise<Set<string>> {
    const def = visibilityTypeDef(recordType)!;
    const out = new Set<string>(def.floor);
    if (def.owner === 'user') {
      for (const e of visibilityFieldsOf(recordType)) out.add(e.key);
      return out;
    }
    const p = await this.prepare(viewer, recordType, workspaceId ?? viewer.workspaceId);
    const rels: RowRelation[] = [
      { self: false, managerOf: false, branchHead: false, branchPayroll: false, branchScheduler: false, stage: null },
      { self: false, managerOf: p.subordinates.size > 0, branchHead: p.headed.size > 0, branchPayroll: p.payroll.size > 0, branchScheduler: p.scheduled.size > 0, stage: null },
    ];
    for (const e of visibilityFieldsOf(recordType)) {
      const selfMode = e.def.self ?? 'full';
      if (def.subject === 'user' && viewer.kind === 'user' && selfMode !== 'hidden') {
        out.add(e.key);
        continue;
      }
      if (rels.some((r) => this.safeDecide(p, e, r).level !== 'hidden')) out.add(e.key);
    }
    return out;
  }

  private safeDecide(p: Prepared, e: VisibilityFieldEntry, rel: RowRelation): FieldDecision {
    try {
      return decideControllerField(p.recordType, e, p.policy, p.facts, rel);
    } catch {
      return HIDDEN_DECISION({ source: 'error' });
    }
  }

  // ============================================================
  // Q — страж запроса
  // ============================================================

  /**
   * Q: фильтр/сортировка/поиск/группировка/агрегат ТОЛЬКО по ключам реестра, которые зритель
   * видит ПОЛНОСТЬЮ и которым разрешена эта операция (`caps`). Порядок: поле существует →
   * разрешено. Отказ — `403 visibility.field_not_queryable` (`details.fieldKey`, без значения),
   * а не молчаливый пропуск (урок Frappe). Поля пола — всегда можно.
   */
  async assertQueryable(viewer: VisibilityViewer, recordType: VisibilityRecordType, spec: VisibilityQuerySpec, workspaceId?: string | null): Promise<void> {
    const def = visibilityTypeDef(recordType)!;
    const floor = new Set(def.floor);
    const checks: Array<[readonly string[] | undefined, VisibilityFieldCap]> = [
      [spec.filter, 'filter'],
      [spec.sort, 'sort'],
      [spec.search, 'search'],
      [spec.group, 'group'],
      [spec.aggregate, 'aggregate'],
    ];
    let p: Prepared | null = null;
    for (const [fields, cap] of checks) {
      for (const f of fields ?? []) {
        if (floor.has(f)) continue;
        const entry = visibilityFieldEntry(recordType, f);
        if (!entry) throw badRequest(VISIBILITY_ERROR_CODES.fieldNotQueryable, undefined, { code: VISIBILITY_ERROR_CODES.fieldNotQueryable, fieldKey: f });
        let ok = false;
        if (entry.def.control === 'controller') {
          p ??= await this.prepare(viewer, recordType, workspaceId ?? viewer.workspaceId);
          const d = this.safeDecide(p, entry, { self: false, managerOf: false, branchHead: false, branchPayroll: false, branchScheduler: false, stage: null });
          ok = d.level === 'full' && d.caps.includes(cap);
        }
        if (!ok) {
          this.metrics.queryDenied.inc({ record_type: recordType });
          throw forbidden(VISIBILITY_ERROR_CODES.fieldNotQueryable, undefined, { code: VISIBILITY_ERROR_CODES.fieldNotQueryable, fieldKey: f });
        }
      }
    }
  }

  // ============================================================
  // W — страж записи
  // ============================================================

  /**
   * W: правка guarded-поля — только при уровне `full` на ЭТОЙ записи (иначе
   * `403 visibility.field_forbidden`); маркер или значение, похожее на маску, — `400
   * visibility.masked_value_rejected`. Отсутствие поля в теле = «не менять» (сюда не попадает).
   */
  async assertWritable(viewer: VisibilityViewer, recordType: VisibilityRecordType, ref: VisibilityRecordRef, patch: Record<string, unknown>): Promise<void> {
    const def = visibilityTypeDef(recordType)!;
    const floor = new Set(def.floor);
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined && !floor.has(k) && visibilityFieldEntry(recordType, k));
    for (const k of keys) {
      const v = patch[k];
      if (isGuardMarker(v) || looksMasked(v)) {
        throw badRequest(VISIBILITY_ERROR_CODES.maskedValueRejected, undefined, { code: VISIBILITY_ERROR_CODES.maskedValueRejected, fieldKey: k });
      }
    }
    if (!keys.length) return;
    const shaped = await this.shapeOne(viewer, recordType, { ref, values: Object.fromEntries(keys.map((k) => [k, '__probe__'])) });
    for (const k of keys) {
      if (isGuardMarker(shaped[k])) throw forbidden(VISIBILITY_ERROR_CODES.fieldForbidden, undefined, { code: VISIBILITY_ERROR_CODES.fieldForbidden, fieldKey: k });
    }
  }

  // ============================================================
  // E — наружу (вебхуки, гости, ИИ): скрытое ОТСУТСТВУЕТ + redactions
  // ============================================================

  async forExternal(
    viewer: VisibilityViewer,
    recordType: VisibilityRecordType,
    input: ShapeInput,
  ): Promise<{ values: Record<string, unknown>; redactions: Array<{ path: string; reason: 'hidden' | 'masked' }> }> {
    const v: VisibilityViewer = VISIBILITY_EXTERNAL_PURPOSES.includes(viewer.purpose) ? viewer : { ...viewer, purpose: 'webhook' };
    const shaped = await this.shapeOne(v, recordType, input);
    const values: Record<string, unknown> = {};
    const redactions: Array<{ path: string; reason: 'hidden' | 'masked' }> = [];
    for (const [k, val] of Object.entries(shaped)) {
      if (isGuardMarker(val)) redactions.push({ path: k, reason: val.$v });
      else values[k] = val;
    }
    return { values, redactions };
  }

  // ============================================================
  // R — хроника: «было → стало» маскируется ПРИ ЧТЕНИИ по плану зрителя
  // ============================================================

  /**
   * `fieldMap` — имя поля в хронике → ключ реестра. Видно полностью — как есть; маска —
   * символы маски вместо значений; скрыто — значения стёрты, строка остаётся («изменено»).
   */
  async maskChanges<T extends VisibilityChange>(
    viewer: VisibilityViewer,
    recordType: VisibilityRecordType,
    ref: VisibilityRecordRef,
    changes: readonly T[],
    fieldMap: Readonly<Record<string, string>>,
  ): Promise<Array<T & { concealed?: 'masked' | 'hidden' }>> {
    const guarded = changes.filter((c) => fieldMap[c.field]);
    if (!guarded.length) return [...changes];
    const probe: Record<string, unknown> = {};
    for (const c of guarded) probe[`${fieldMap[c.field]}`] = '__probe__';
    const shaped = await this.shapeOne(viewer, recordType, { ref, values: probe });
    return changes.map((c) => {
      const key = fieldMap[c.field];
      if (!key) return c;
      const s = shaped[key];
      if (!isGuardMarker(s)) return c;
      if (s.$v === 'hidden') return { ...c, from: null, to: null, raw: null, display: null, concealed: 'hidden' as const };
      const entry = visibilityFieldEntry(recordType, key)!;
      const raw = (c as { raw?: { from?: unknown; to?: unknown } | null }).raw;
      const mask = (v: unknown) => (v === null || v === undefined ? null : applyMask(s.mask, normalizeForMask(v), { moneyBuckets: entry.def.moneyBuckets }));
      // Маска считается от СЫРОГО значения (у денег display — «150 000 ₸», корзина из него не собрать)
      return { ...c, from: mask(raw?.from ?? c.from), to: mask(raw?.to ?? c.to), raw: null, display: null, concealed: 'masked' as const };
    });
  }

  // ============================================================
  // План для клиента (R14) и объяснение
  // ============================================================

  /** Базовый план зрителя по типу (без «почему») — заголовки таблиц и фильтры прячут не-full поля. */
  async planDto(viewer: VisibilityViewer, recordType: VisibilityRecordType, workspaceId?: string | null): Promise<VisibilityPlanDto> {
    const def = visibilityTypeDef(recordType)!;
    const p = await this.prepare(viewer, recordType, def.owner === 'workspace' ? (workspaceId ?? viewer.workspaceId) : null);
    const fields: VisibilityPlanDto['fields'] = {};
    for (const f of def.floor) fields[f] = { level: 'full', mask: null, reveal: 'none', caps: ['filter', 'sort', 'search', 'group'] };
    for (const e of visibilityFieldsOf(recordType)) {
      const d = def.owner === 'workspace' ? this.safeDecide(p, e, { self: false, managerOf: false, branchHead: false, branchPayroll: false, branchScheduler: false, stage: null }) : HIDDEN_DECISION({ source: 'personal' });
      fields[e.key] = { level: d.level, mask: d.mask, reveal: d.reveal, caps: d.caps };
    }
    return { recordType, pv: p.policy.pv, fields };
  }

  /**
   * «Почему» по каждому полю для зрителя `viewerId` (и субъекта — для «сам»/руководителя).
   * Только вычисление плана — никаких токенов и чужих сессий (урок Facebook View As 2018).
   */
  async explain(viewerId: string, workspaceId: string | null, recordType: VisibilityRecordType, subjectId: string | null, extras: { branchId?: string | null } = {}): Promise<VisibilityExplainDto> {
    const def = visibilityTypeDef(recordType)!;
    const viewer = this.viewerFor(viewerId, workspaceId, 'explain');
    const ref: VisibilityRecordRef = { recordId: subjectId ?? '-', subjectId, workspaceId, stage: null, branchId: extras.branchId ?? null };
    const fields: VisibilityExplainDto['fields'] = [];
    if (def.owner === 'workspace') {
      const p = await this.prepare(viewer, recordType, workspaceId);
      if (subjectId) await this.loadSubjectBranches(p, [subjectId]);
      for (const e of visibilityFieldsOf(recordType)) {
        const d = this.decideController(p, e, ref);
        fields.push({ fieldKey: e.key, level: d.level, mask: d.mask, reveal: d.reveal, why: d.why });
      }
      return { recordType, viewerId, subjectId, pv: p.policy.pv, fields };
    }
    const p = await this.prepare(viewer, recordType, null);
    const policy = subjectId ? await this.cache.policy('user', subjectId, recordType) : EMPTY_POLICY;
    const rels = subjectId ? await this.personalRelations(viewer, [subjectId]) : new Map();
    const viewerPolicy = await this.cache.policy('user', viewerId, recordType);
    const presence = visibilityFieldsOf(recordType).find((e) => e.def.reciprocal);
    const rel = this.personalRelation(viewer, subjectId, rels.get(subjectId ?? ''), presence, viewerPolicy, recordType);
    for (const e of visibilityFieldsOf(recordType)) {
      const d = decidePersonalField(recordType, e, personalSetting(recordType, e, policy), p.facts, rel);
      fields.push({ fieldKey: e.key, level: d.level, mask: d.mask, reveal: d.reveal, why: d.why });
    }
    return { recordType, viewerId, subjectId, pv: policy.pv, fields };
  }

  /**
   * Предпросмотр СВОЕЙ личной карточки глазами синтетического зрителя (чужой / Окружение /
   * Группа / коллега): тот же расчёт, что у настоящего зрителя, без чужой сессии.
   */
  async previewPersonal(
    ownerId: string,
    recordType: VisibilityRecordType,
    as: { kind: 'stranger' | 'circle_all' | 'circle' | 'colleague' | 'user'; id?: string | null },
    values: Record<string, unknown>,
  ): Promise<ShapedValues> {
    const def = visibilityTypeDef(recordType)!;
    const policy = await this.cache.policy('user', ownerId, recordType);
    let rel: PersonalRelation;
    let viewerId: string | null = null;
    if (as.kind === 'user' && as.id) {
      viewerId = as.id;
      const g = (await this.graph.get()?.relationsOf(as.id, [ownerId]))?.get(ownerId);
      rel = { self: as.id === ownerId, linked: !!g?.linked, circleIds: new Set(g?.subjectCircleIds ?? []), colleagueWorkspaceIds: new Set(g?.sharedWorkspaceIds ?? []) };
    } else {
      rel = {
        self: false,
        linked: as.kind === 'circle_all' || as.kind === 'circle',
        circleIds: new Set(as.kind === 'circle' && as.id ? [as.id] : []),
        colleagueWorkspaceIds: new Set(as.kind === 'colleague' && as.id ? [as.id] : []),
      };
    }
    const facts: ViewerFacts = { kind: 'user', userId: viewerId ?? '00000000-0000-4000-8000-000000000000', role: null, principals: new Set(), botContactAccess: false, purpose: 'explain', revealDelegation: false };
    const out: ShapedValues = {};
    const floor = new Set(def.floor);
    for (const [key, value] of Object.entries(values)) {
      if (floor.has(key)) {
        out[key] = value;
        continue;
      }
      const entry = visibilityFieldEntry(recordType, key);
      if (!entry) {
        out[key] = HIDDEN;
        continue;
      }
      const d = decidePersonalField(recordType, entry, personalSetting(recordType, entry, policy), facts, rel);
      // Предпросмотр — не раскрытие: кнопка «Показать» в нём не рисуется
      out[key] = projectValue(entry, { ...d, reveal: 'none' }, value);
    }
    return out;
  }

  /** Уровень одного поля одной записи (для точечных решений сервиса: «можно ли раскрыть»). */
  async decisionFor(viewer: VisibilityViewer, recordType: VisibilityRecordType, ref: VisibilityRecordRef, fieldKey: string): Promise<FieldDecision> {
    const entry = visibilityFieldEntry(recordType, fieldKey);
    if (!entry || !isVisibilityRecordType(recordType)) return HIDDEN_DECISION({ source: 'no_record' });
    const def = visibilityTypeDef(recordType)!;
    if (def.owner === 'user') {
      const p = await this.prepare(viewer, recordType, null);
      const policy = ref.subjectId ? await this.cache.policy('user', ref.subjectId, recordType) : EMPTY_POLICY;
      const rels = ref.subjectId ? await this.personalRelations(viewer, [ref.subjectId]) : new Map();
      const vp = viewer.userId ? await this.cache.policy('user', viewer.userId, recordType) : EMPTY_POLICY;
      const presence = visibilityFieldsOf(recordType).find((e) => e.def.reciprocal);
      const rel = this.personalRelation(viewer, ref.subjectId, rels.get(ref.subjectId ?? ''), presence, vp, recordType);
      return decidePersonalField(recordType, entry, personalSetting(recordType, entry, policy), p.facts, rel);
    }
    const p = await this.prepare(viewer, recordType, ref.workspaceId ?? viewer.workspaceId);
    if (ref.subjectId) await this.loadSubjectBranches(p, [ref.subjectId]);
    return this.decideController(p, entry, ref);
  }

  /** Сравнение уровней — для потребителей (`caps.payrollView` объекта и т. п.). */
  static atLeast(a: FieldDecision['level'], b: FieldDecision['level']): boolean {
    return VISIBILITY_LEVEL_RANK[a] >= VISIBILITY_LEVEL_RANK[b];
  }
}

/**
 * Поле «выдаёт» человека наружу (для детекции скрейпинга): класс ≥ contact, непустое значение,
 * не присутствие и не фото (их опрашивают постоянно и они не идентифицируют).
 */
function isExposing(entry: VisibilityFieldEntry, value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (entry.def.kind === 'presence' || entry.def.kind === 'image' || entry.def.kind === 'bool') return false;
  return VISIBILITY_CLASS_RANK[entry.def.class] >= VISIBILITY_CLASS_RANK.contact;
}

/** Факты «субъекта как зрителя» для проверки взаимности (без роли и принципалов). */
function systemlessFacts(userId: string): ViewerFacts {
  return { kind: 'user', userId, role: null, principals: new Set(), botContactAccess: false, purpose: 'api', revealDelegation: false };
}
