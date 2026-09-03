// ============================================================
// Орг. структура — ЧИСТЫЕ функции вывода вертикали над снимком организации.
// ============================================================
// Граф ДОЛЖНОСТЕЙ и ОБЪЕКТОВ (не людей): руководящая должность у отдела и у объекта,
// точечное переопределение подчинения, заместители. Вертикаль ВЫЧИСЛЯЕТСЯ здесь —
// ничего из этого не хранится в рёбрах прав с датой (инвариант: RelationTuple —
// только независимые от времени факты; проекция не пересчитывается в полночь).
//
// Единственный санкционированный вход «кто мой руководитель / кто моя команда» —
// managerOf / subordinateIdsOf (образец ContactsService.resolveCircleMemberIds).
// subordinateIdsOf — ТОЧНАЯ инверсия managerOf: одно правило, два направления.
//
// Никакого Prisma здесь нет намеренно: снимок грузит OrgGraphService, функции
// проверяются в лоб, дата замещений — ВСЕГДА параметр (иначе кэш небезопасен).

import { APP_TIMEZONE, ORG_LIMITS, type OrgManagerReason } from '@superapp/shared';

export interface OrgDepartmentRow {
  id: string;
  name: string;
  parentId: string | null;
  headPositionId: string | null;
  sortOrder: number;
}
export interface OrgPositionRow {
  id: string;
  name: string;
  departmentId: string | null;
  reportsToPositionId: string | null;
  glyph: string | null;
  sortOrder: number;
}
export interface OrgBranchRow {
  id: string;
  name: string;
  isDefault: boolean;
  headPositionId: string | null;
  sortOrder: number;
}
export interface OrgAssignmentRow {
  id: string;
  userId: string;
  positionId: string;
  branchId: string;
  isPrimary: boolean;
  status: string;
  /** ISO — порядок «самое раннее» несёт смысл (основное место, фолбэки) */
  createdAt: string;
}
export interface OrgDeputyRow {
  id: string;
  positionId: string;
  branchId: string | null;
  deputyPositionId: string | null;
  deputyUserId: string | null;
  /** YYYY-MM-DD или null */
  startsOn: string | null;
  endsOn: string | null;
  note: string | null;
  createdById: string;
  createdAt: string;
}

/** Сериализуемый снимок (кладётся в Redis как есть) */
export interface OrgSnapshotData {
  workspaceId: string;
  ownerId: string;
  departments: OrgDepartmentRow[];
  positions: OrgPositionRow[];
  branches: OrgBranchRow[];
  assignments: OrgAssignmentRow[];
  deputies: OrgDeputyRow[];
  /** Живая команда (trainee+; Подрядчик — не команда): userId → роль */
  members: Array<{ userId: string; role: string }>;
}

/** Снимок + индексы (строится из OrgSnapshotData одним проходом) */
export interface OrgGraph extends OrgSnapshotData {
  departmentById: Map<string, OrgDepartmentRow>;
  positionById: Map<string, OrgPositionRow>;
  branchById: Map<string, OrgBranchRow>;
  childrenOf: Map<string, string[]>;
  assignmentById: Map<string, OrgAssignmentRow>;
  assignmentsByUser: Map<string, OrgAssignmentRow[]>;
  /** positionId → branchId → userId[] */
  holdersByPosBranch: Map<string, Map<string, string[]>>;
  /** positionId → все объекты, где у неё есть держатели */
  branchesOfPosition: Map<string, Set<string>>;
  deputiesByPosition: Map<string, OrgDeputyRow[]>;
  memberRole: Map<string, string>;
  defaultBranchId: string | null;
}

export function buildOrgGraph(data: OrgSnapshotData): OrgGraph {
  const departmentById = new Map(data.departments.map((d) => [d.id, d]));
  const positionById = new Map(data.positions.map((p) => [p.id, p]));
  const branchById = new Map(data.branches.map((b) => [b.id, b]));
  const childrenOf = new Map<string, string[]>();
  for (const d of data.departments) {
    if (!d.parentId) continue;
    const list = childrenOf.get(d.parentId) ?? [];
    list.push(d.id);
    childrenOf.set(d.parentId, list);
  }
  const assignmentById = new Map<string, OrgAssignmentRow>();
  const assignmentsByUser = new Map<string, OrgAssignmentRow[]>();
  const holdersByPosBranch = new Map<string, Map<string, string[]>>();
  const branchesOfPosition = new Map<string, Set<string>>();
  const sorted = [...data.assignments].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  for (const a of sorted) {
    assignmentById.set(a.id, a);
    const list = assignmentsByUser.get(a.userId) ?? [];
    list.push(a);
    assignmentsByUser.set(a.userId, list);
    let byBranch = holdersByPosBranch.get(a.positionId);
    if (!byBranch) holdersByPosBranch.set(a.positionId, (byBranch = new Map()));
    const holders = byBranch.get(a.branchId) ?? [];
    if (!holders.includes(a.userId)) holders.push(a.userId);
    byBranch.set(a.branchId, holders);
    let set = branchesOfPosition.get(a.positionId);
    if (!set) branchesOfPosition.set(a.positionId, (set = new Set()));
    set.add(a.branchId);
  }
  const deputiesByPosition = new Map<string, OrgDeputyRow[]>();
  for (const d of data.deputies) {
    const list = deputiesByPosition.get(d.positionId) ?? [];
    list.push(d);
    deputiesByPosition.set(d.positionId, list);
  }
  const memberRole = new Map(data.members.map((m) => [m.userId, m.role]));
  const defaultBranchId = data.branches.find((b) => b.isDefault)?.id ?? data.branches[0]?.id ?? null;
  return {
    ...data,
    departmentById,
    positionById,
    branchById,
    childrenOf,
    assignmentById,
    assignmentsByUser,
    holdersByPosBranch,
    branchesOfPosition,
    deputiesByPosition,
    memberRole,
    defaultBranchId,
  };
}

/** Сегодня в APP_TIMEZONE как YYYY-MM-DD (даты замещений — календарные, без пояса) */
export function orgToday(now: Date = new Date()): string {
  // en-CA даёт ровно YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function isDeputyDated(d: Pick<OrgDeputyRow, 'startsOn' | 'endsOn'>): boolean {
  return d.startsOn !== null || d.endsOn !== null;
}

/** Датированное замещение действует в день `at`; запасное (без дат) — «наготове» всегда */
export function isDeputyActiveOn(d: Pick<OrgDeputyRow, 'startsOn' | 'endsOn'>, at: string): boolean {
  if (d.startsOn && at < d.startsOn) return false;
  if (d.endsOn && at > d.endsOn) return false;
  return true;
}

/** Предки отдела (сам отдел первым), с гардом от повреждённого дерева */
export function departmentAncestors(g: OrgGraph, departmentId: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = departmentId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = g.departmentById.get(cur)?.parentId ?? null;
  }
  return out;
}

/** Поддерево отдела (сам отдел первым) */
export function departmentSubtree(g: OrgGraph, departmentId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [departmentId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    for (const c of g.childrenOf.get(cur) ?? []) stack.push(c);
  }
  return out;
}

export function departmentDepth(g: OrgGraph, departmentId: string): number {
  return Math.max(0, departmentAncestors(g, departmentId).length - 1);
}

/**
 * Руководящая ДОЛЖНОСТЬ над должностью в объекте — по убыванию силы:
 *  1. reportsToPositionId (переопределение);
 *  2. голова отдела должности, если это не она сама; иначе вверх по предкам до первого
 *     отдела с головой ≠ она;
 *  3. дерево не ответило → руководящая должность ОБЪЕКТА назначения (если ≠ она);
 *     в ТИПОВОЙ схеме (branchId = null — общий канвас, корни) объектом считается
 *     ОСНОВНОЙ объект организации: сеть одинаковых точек рисуется одной схемой
 *     «CEO → Управляющий → Продавец», а не десятком корней-продавцов;
 *  4. null — корень.
 *
 * Сверено: Бариста в отделе → 2; Главбух → 2 → CFO; CFO (вне отдела, ведёт «Финансовый»)
 * → 1 → CEO (без переопределения был бы вторым корнем — вот зачем оба механизма);
 * Продавец без отдела в «Магазин на Абая» → 3 → Управляющий; Управляющий → 1 или 4.
 */
export function superiorPositionOf(g: OrgGraph, positionId: string, branchId: string | null): string | null {
  const pos = g.positionById.get(positionId);
  if (!pos) return null;
  if (pos.reportsToPositionId && g.positionById.has(pos.reportsToPositionId) && pos.reportsToPositionId !== positionId) {
    return pos.reportsToPositionId;
  }
  for (const depId of departmentAncestors(g, pos.departmentId)) {
    const head = g.departmentById.get(depId)?.headPositionId ?? null;
    if (head && head !== positionId && g.positionById.has(head)) return head;
  }
  const effectiveBranchId = branchId ?? g.defaultBranchId;
  const branch = effectiveBranchId ? g.branchById.get(effectiveBranchId) : null;
  if (branch?.headPositionId && branch.headPositionId !== positionId && g.positionById.has(branch.headPositionId)) {
    return branch.headPositionId;
  }
  return null;
}

export interface HoldersResult {
  userIds: string[];
  viaDeputy: boolean;
  /** До какой даты действует датированное замещение (наименьший endsOn среди сработавших) */
  deputyUntil: string | null;
}

const EMPTY_HOLDERS: HoldersResult = { userIds: [], viaDeputy: false, deputyUntil: null };

/**
 * Кто СЕЙЧАС отвечает за должность в объекте — лестница объекта:
 *  1. ДАТИРОВАННОЕ замещение, действующее в `at` (объектное затеняет общее);
 *  2. держатели В ЭТОМ объекте;
 *  3. держатели в любом объекте — ТОЛЬКО если объект у должности ровно один
 *     (никогда не подставлять управляющего чужой точки);
 *  4. БЕССРОЧНЫЙ зам (запасной — только когда некому);
 *  5. пусто → managerOf поднимается выше.
 * Разворот «зам — должность» рекурсивен (visited, глубина ≤ ORG_LIMITS.maxDeputyDepth).
 * Живость людей (команда trainee+) проверяется здесь же — уволенный не отвечает ни за что.
 */
export function holdersForPosition(
  g: OrgGraph,
  positionId: string,
  branchId: string | null,
  at: string,
  visited: Set<string> = new Set(),
  depth = 0,
): HoldersResult {
  const key = `${positionId}:${branchId ?? ''}`;
  if (visited.has(key) || depth > ORG_LIMITS.maxDeputyDepth) return EMPTY_HOLDERS;
  visited.add(key);

  const alive = (ids: Iterable<string>) => [...new Set([...ids].filter((u) => g.memberRole.has(u)))];

  const deputies = g.deputiesByPosition.get(positionId) ?? [];
  const resolveDeputies = (rows: OrgDeputyRow[]): HoldersResult => {
    const ids = new Set<string>();
    let until: string | null = null;
    for (const d of rows) {
      if (d.deputyUserId) {
        ids.add(d.deputyUserId);
      } else if (d.deputyPositionId) {
        const sub = holdersForPosition(g, d.deputyPositionId, branchId, at, visited, depth + 1);
        sub.userIds.forEach((u) => ids.add(u));
      }
      if (d.endsOn && (until === null || d.endsOn < until)) until = d.endsOn;
    }
    const userIds = alive(ids);
    return userIds.length ? { userIds, viaDeputy: true, deputyUntil: until } : EMPTY_HOLDERS;
  };

  // 1. датированные, действующие сегодня: объектные сильнее общих
  const dated = deputies.filter((d) => isDeputyDated(d) && isDeputyActiveOn(d, at));
  const datedScoped = branchId ? dated.filter((d) => d.branchId === branchId) : [];
  const datedGeneral = dated.filter((d) => d.branchId === null);
  const datedPick = datedScoped.length ? datedScoped : datedGeneral;
  if (datedPick.length) {
    const r = resolveDeputies(datedPick);
    if (r.userIds.length) return r;
  }

  // 2. держатели в этом объекте
  const byBranch = g.holdersByPosBranch.get(positionId);
  if (branchId) {
    const here = alive(byBranch?.get(branchId) ?? []);
    if (here.length) return { userIds: here, viaDeputy: false, deputyUntil: null };
  }
  // 3. единственный объект должности — её держатели годятся отовсюду
  const branches = g.branchesOfPosition.get(positionId);
  if (byBranch && branches && branches.size === 1) {
    const only = [...branches][0];
    const there = alive(byBranch.get(only) ?? []);
    if (there.length) return { userIds: there, viaDeputy: false, deputyUntil: null };
  }
  if (!branchId && byBranch) {
    // Без объекта (общая схема): любые держатели
    const all = alive([...byBranch.values()].flat());
    if (all.length) return { userIds: all, viaDeputy: false, deputyUntil: null };
  }

  // 4. запасные (без дат)
  const standing = deputies.filter((d) => !isDeputyDated(d));
  const standingScoped = branchId ? standing.filter((d) => d.branchId === branchId) : [];
  const standingGeneral = standing.filter((d) => d.branchId === null);
  const standingPick = standingScoped.length ? standingScoped : standingGeneral;
  if (standingPick.length) {
    const r = resolveDeputies(standingPick);
    if (r.userIds.length) return r;
  }
  return EMPTY_HOLDERS;
}

export interface ManagerResolution {
  positionId: string | null;
  userIds: string[];
  viaDeputy: boolean;
  deputyUntil: string | null;
  branchId: string | null;
  reason: OrgManagerReason;
  /** Пройденные руководящие должности (для цепочки и диагностики) */
  chain: string[];
}

export interface ManagerOfOptions {
  branchId?: string | null;
  assignmentId?: string | null;
  at?: string;
}

/** Выбор назначения: явное → совпадение объекта (основное вперёд) → основное → самое раннее */
export function pickAssignment(g: OrgGraph, userId: string, opts: ManagerOfOptions = {}): OrgAssignmentRow | null {
  const list = g.assignmentsByUser.get(userId) ?? [];
  if (!list.length) return null;
  if (opts.assignmentId) {
    const a = g.assignmentById.get(opts.assignmentId);
    if (a && a.userId === userId) return a;
  }
  if (opts.branchId) {
    const inBranch = list.filter((a) => a.branchId === opts.branchId);
    if (inBranch.length) return inBranch.find((a) => a.isPrimary) ?? inBranch[0];
  }
  return list.find((a) => a.isPrimary) ?? list[0];
}

/**
 * Руководитель человека: назначение → руководящая должность → вверх, пока не найдутся
 * держатели (вакантная должность вертикаль не рвёт); человек не бывает своим
 * руководителем (Бариста, который ещё и Управляющий той же точки, поднимается выше);
 * стоп-кран ORG_LIMITS.maxChainDepth; пусто на вершине → ВЛАДЕЛЕЦ организации
 * (снимок не пуст, инвариант движка согласований цел; reason = owner_fallback).
 */
export function managerOf(g: OrgGraph, userId: string, opts: ManagerOfOptions = {}): ManagerResolution {
  const at = opts.at ?? orgToday();
  const assignment = pickAssignment(g, userId, opts);
  const chain: string[] = [];
  if (assignment) {
    const branchId = assignment.branchId;
    const seen = new Set<string>([assignment.positionId]);
    let cur = superiorPositionOf(g, assignment.positionId, branchId);
    let steps = 0;
    while (cur && !seen.has(cur) && steps < ORG_LIMITS.maxChainDepth) {
      seen.add(cur);
      chain.push(cur);
      const holders = holdersForPosition(g, cur, branchId, at);
      const userIds = holders.userIds.filter((u) => u !== userId);
      if (userIds.length) {
        return {
          positionId: cur,
          userIds,
          viaDeputy: holders.viaDeputy,
          deputyUntil: holders.deputyUntil,
          branchId,
          reason: 'position',
          chain,
        };
      }
      cur = superiorPositionOf(g, cur, branchId);
      steps += 1;
    }
    return ownerFallback(g, branchId, chain);
  }
  return ownerFallback(g, opts.branchId ?? null, chain);
}

function ownerFallback(g: OrgGraph, branchId: string | null, chain: string[]): ManagerResolution {
  return {
    positionId: null,
    userIds: g.ownerId ? [g.ownerId] : [],
    viaDeputy: false,
    deputyUntil: null,
    branchId,
    reason: 'owner_fallback',
    chain,
  };
}

export interface ChainStep {
  positionId: string;
  userIds: string[];
  viaDeputy: boolean;
}

/** Цепочка руководящих должностей вверх (по должностям, не по людям), с держателями */
export function managerChainOf(g: OrgGraph, userId: string, opts: ManagerOfOptions = {}): ChainStep[] {
  const at = opts.at ?? orgToday();
  const assignment = pickAssignment(g, userId, opts);
  if (!assignment) return [];
  const out: ChainStep[] = [];
  const seen = new Set<string>([assignment.positionId]);
  let cur = superiorPositionOf(g, assignment.positionId, assignment.branchId);
  while (cur && !seen.has(cur) && out.length < ORG_LIMITS.maxChainDepth) {
    seen.add(cur);
    const holders = holdersForPosition(g, cur, assignment.branchId, at);
    out.push({ positionId: cur, userIds: holders.userIds.filter((u) => u !== userId), viaDeputy: holders.viaDeputy });
    cur = superiorPositionOf(g, cur, assignment.branchId);
  }
  return out;
}

/**
 * Подчинённые человека — ТОЧНАЯ инверсия managerOf по КАЖДОМУ назначению каждого
 * члена команды (`я ∈ subordinateIdsOf(рук) ⇔ рук ∈ managerOf(я, {assignmentId})`).
 * Правило одно, и «мой руководитель» с «моей командой» не расходятся никогда.
 *
 * Обход идёт по ЖИВОЙ КОМАНДЕ (`memberRole`), а не по назначениям: человек без
 * назначений — тоже чей-то подчинённый (его вертикаль упирается в корень, и
 * managerOf отдаёт по нему владельца). Пока обход шёл по `assignmentsByUser`,
 * новичок «вне структуры» не попадал ни в чью команду — инверсия рвалась именно
 * на нём, и адресат `subordinates_of` молча терял таких людей.
 */
export function subordinateIdsOf(g: OrgGraph, managerUserId: string, at: string = orgToday()): string[] {
  const out = new Set<string>();
  for (const userId of g.memberRole.keys()) {
    if (userId === managerUserId) continue;
    const list = g.assignmentsByUser.get(userId) ?? [];
    if (list.length === 0) {
      if (managerOf(g, userId, { at }).userIds.includes(managerUserId)) out.add(userId);
      continue;
    }
    for (const a of list) {
      const r = managerOf(g, userId, { assignmentId: a.id, at });
      if (r.userIds.includes(managerUserId)) {
        out.add(userId);
        break;
      }
    }
  }
  return [...out];
}

/**
 * Проверка ПОЛНОЙ разрешённой цепочки на цикл — для каждой должности и каждого объекта
 * (цикл бывает смешанным: reportsTo + дерево + голова объекта). Возвращает первую
 * найденную петлю (id должностей) либо null. Мемо «безопасных» узлов держит O(P×B).
 */
export function findPositionCycle(g: OrgGraph): string[] | null {
  const branchIds: Array<string | null> = [null, ...g.branches.map((b) => b.id)];
  for (const branchId of branchIds) {
    const safe = new Set<string>();
    for (const p of g.positions) {
      if (safe.has(p.id)) continue;
      const path: string[] = [];
      const onPath = new Set<string>();
      let cur: string | null = p.id;
      while (cur) {
        if (safe.has(cur)) break;
        if (onPath.has(cur)) {
          return path.slice(path.indexOf(cur));
        }
        onPath.add(cur);
        path.push(cur);
        cur = superiorPositionOf(g, cur, branchId);
      }
      path.forEach((id) => safe.add(id));
    }
  }
  return null;
}

/** Должности без разрешимого руководителя в общей схеме или в объекте */
export function rootPositionIds(g: OrgGraph, branchId: string | null): string[] {
  return g.positions.filter((p) => superiorPositionOf(g, p.id, branchId) === null).map((p) => p.id);
}
