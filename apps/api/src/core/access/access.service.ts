import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { createResolver, ResolverReaders } from './access-resolver';
import {
  ACCESS_SCHEMA,
  CHAT_PARENT_SUBJECT_TYPES,
  EPOCH_FANOUT,
  OBJECT_EPOCH_TYPES,
} from './access-schema';
import { CAPABILITIES, CapabilityKey } from './access-capabilities';
import { Principal, ResourceRef, RelationTupleInput } from './access.types';

type Tx = Prisma.TransactionClient;
type EpochRef = { type: string; id: string };

const CACHE_TTL_SECONDS = 600;
const EPOCH_KEY = 'acl:epoch'; // global fallback (types not in EPOCH_FANOUT)
const typeEpochKey = (t: string) => `acl:epoch:${t}`;
const objectEpochKey = (t: string, id: string) => `acl:epoch:${t}:${id}`;
// Пообъектные эпох-ключи создаются INCR'ом навсегда — даём TTL сильно больше TTL
// кэш-записей (600с): истёкший ключ читается как '0', но записи под старой эпохой
// к тому моменту давно умерли.
const OBJECT_EPOCH_TTL_SECONDS = 3600;

/**
 * Unified authorization engine (ReBAC).
 *
 * Reads resolve permissions from relationship tuples + ACCESS_SCHEMA rewrite rules.
 * check() results are cached in Redis keyed by (global epoch . per-type epoch): a write
 * bumps ONLY the epochs of the types its tuples can influence (EPOCH_FANOUT), so a task
 * or chat mutation no longer flushes the WHOLE platform's ACL cache — grants/revokes
 * still take effect instantly for the affected types (the "new enemy" problem stays
 * closed). Unmapped types bump the global epoch (coarse but safe-by-default).
 *
 * Cross-cutting: deliberately NOT in the workspace chokepoint (RelationTuple is global).
 */
@Injectable()
export class AccessService {
  private readonly resolver: ReturnType<typeof createResolver>;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {
    const readers: ResolverReaders = {
      subjectsOf: (resourceType, resourceId, relation) =>
        this.db.relationTuple.findMany({
          where: { resourceType, resourceId, relation },
          select: { subjectType: true, subjectId: true, subjectRelation: true },
        }),
      edgesForSubjects: (nodes) => {
        const byType = new Map<string, string[]>();
        for (const n of nodes) {
          const ids = byType.get(n.type);
          if (ids) ids.push(n.id);
          else byType.set(n.type, [n.id]);
        }
        return this.db.relationTuple.findMany({
          where: { OR: [...byType.entries()].map(([t, ids]) => ({ subjectType: t, subjectId: { in: ids } })) },
          select: { resourceType: true, resourceId: true, relation: true, subjectRelation: true },
        });
      },
    };
    this.resolver = createResolver(readers);
  }

  // ------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------

  /** Does `subject` hold `relation` on `resource`? Cached per (global.type[.object]) epoch. */
  async check(subject: Principal, relation: string, resource: ResourceRef): Promise<boolean> {
    const epoch = await this.epochFor(resource.type, resource.id);
    const key = `acl:chk:${epoch}:${subject.type}:${subject.id}:${relation}:${resource.type}:${resource.id}`;
    const cached = await this.redis.get(key);
    if (cached !== null) return cached === '1';

    const result = await this.resolver.check(subject, relation, resource);
    await this.redis.set(key, result ? '1' : '0', CACHE_TTL_SECONDS);
    return result;
  }

  /** Capability-based check: maps a stable capability key to (resourceType, relation). */
  async can(subject: Principal, capability: CapabilityKey, resourceId: string): Promise<boolean> {
    const def = CAPABILITIES[capability];
    if (!def) return false;
    return this.check(subject, def.relation, { type: def.resourceType, id: resourceId });
  }

  /** Highest level (e.g. calendar busy/detailed) the subject holds, or null. */
  async resolveLevel(subject: Principal, resource: ResourceRef): Promise<string | null> {
    const levels = ACCESS_SCHEMA[resource.type]?.levels;
    if (!levels) return null;
    for (let i = levels.length - 1; i >= 0; i--) {
      if (await this.check(subject, levels[i], resource)) return levels[i];
    }
    return null;
  }

  /** Reverse query: resource ids of `resourceType` the subject holds `relation` on. */
  async listObjects(subject: Principal, relation: string, resourceType: string): Promise<string[]> {
    return this.resolver.listObjects(subject, relation, resourceType);
  }

  // ------------------------------------------------------------
  // Writes — every mutation bumps the epoch so caches invalidate instantly
  // ------------------------------------------------------------

  // grant/revoke accept an optional `tx` so a caller can write the tuple inside its OWN
  // transaction (e.g. create showcase + its parent pointer atomically), the way the wallet
  // ledger composes. The epoch bump is a Redis INCR after the write — a spurious bump on a
  // rolled-back tx is harmless (just a cache miss). When called INSIDE a tx, a delayed
  // re-bump fires after the expected commit: otherwise a concurrent reader could cache the
  // pre-commit state under the already-bumped epoch for the full TTL (10-min stale-ACL
  // windows from the arch review).
  async grant(tuple: RelationTupleInput, tx?: Tx): Promise<void> {
    const data = this.normalize(tuple);
    await (tx ?? this.db).relationTuple.upsert({
      where: {
        resourceType_resourceId_relation_subjectType_subjectId_subjectRelation: data,
      },
      create: data,
      update: {},
    });
    const refs = [{ type: tuple.resourceType, id: tuple.resourceId }];
    await this.bumpEpochs(refs);
    if (tx) this.bumpLater(refs);
  }

  async grantMany(tuples: RelationTupleInput[]): Promise<void> {
    if (tuples.length === 0) return;
    await this.db.relationTuple.createMany({
      data: tuples.map((t) => this.normalize(t)),
      skipDuplicates: true,
    });
    await this.bumpEpochs(tuples.map((t) => ({ type: t.resourceType, id: t.resourceId })));
  }

  async revoke(tuple: RelationTupleInput, tx?: Tx): Promise<void> {
    await (tx ?? this.db).relationTuple.deleteMany({ where: this.normalize(tuple) });
    const refs = [{ type: tuple.resourceType, id: tuple.resourceId }];
    await this.bumpEpochs(refs);
    if (tx) this.bumpLater(refs);
  }

  /** Remove every edge on a resource (e.g. when the resource is deleted). */
  async revokeResource(resourceType: string, resourceId: string, tx?: Tx): Promise<void> {
    await (tx ?? this.db).relationTuple.deleteMany({ where: { resourceType, resourceId } });
    const refs = [{ type: resourceType, id: resourceId }];
    await this.bumpEpochs(refs);
    if (tx) this.bumpLater(refs);
  }

  /** Delete specific tuples by id (used by the projection reconciler). */
  async revokeByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    // Resolve the affected refs BEFORE deleting so the right epochs get bumped
    // (including per-object chat epochs and chat-parent reverse lookups).
    const rows = await this.db.relationTuple.findMany({
      where: { id: { in: ids } },
      select: { resourceType: true, resourceId: true },
      distinct: ['resourceType', 'resourceId'],
    });
    await this.db.relationTuple.deleteMany({ where: { id: { in: ids } } });
    await this.bumpEpochs(rows.map((r) => ({ type: r.resourceType, id: r.resourceId })));
  }

  private normalize(t: RelationTupleInput) {
    return {
      resourceType: t.resourceType,
      resourceId: t.resourceId,
      relation: t.relation,
      subjectType: t.subjectType,
      subjectId: t.subjectId,
      subjectRelation: t.subjectRelation ?? '',
    };
  }

  /**
   * Effective epoch for a resource = global . per-type [. per-object].
   * Пообъектный компонент — только у OBJECT_EPOCH_TYPES (chat): тип-эпоха chat
   * раньше сбрасывалась почти любой доменной мутацией платформы (EPOCH_FANOUT
   * task/order/event/… → chat), и hit-rate кэша прав чатов стремился к нулю.
   */
  private async epochFor(resourceType: string, resourceId: string): Promise<string> {
    if (OBJECT_EPOCH_TYPES.has(resourceType)) {
      const [g, t, o] = await this.redis
        .getClient()
        .mget(EPOCH_KEY, typeEpochKey(resourceType), objectEpochKey(resourceType, resourceId));
      return `${g ?? '0'}.${t ?? '0'}.${o ?? '0'}`;
    }
    const [g, t] = await this.redis.getClient().mget(EPOCH_KEY, typeEpochKey(resourceType));
    return `${g ?? '0'}.${t ?? '0'}`;
  }

  /**
   * Bump the epochs the mutated tuples can influence:
   *  - тип-эпохи по EPOCH_FANOUT (объектные типы из фанаутов исключены — у них точечный бамп);
   *  - пообъектные эпохи изменённых chat-ресурсов;
   *  - реверс-lookup: мутация tuples родителя (task/order/event/office_room/workspace)
   *    бампает эпохи ЗАВИСИМЫХ чатов (chat#member@<parent>#<role>); сбой lookup'а →
   *    фолбэк на тип-эпоху chat (safe: Hard Revoke не ослабляется никогда).
   */
  private async bumpEpochs(refs: EpochRef[]): Promise<void> {
    const typeBumps = new Set<string>();
    const objectBumps = new Set<string>(); // `${type} ${id}`
    const parentIdsByType = new Map<string, Set<string>>();
    let global = false;

    const seenTypes = new Set<string>();
    for (const r of refs) {
      seenTypes.add(r.type);
      if (OBJECT_EPOCH_TYPES.has(r.type)) objectBumps.add(`${r.type} ${r.id}`);
      if (CHAT_PARENT_SUBJECT_TYPES.has(r.type)) {
        let ids = parentIdsByType.get(r.type);
        if (!ids) parentIdsByType.set(r.type, (ids = new Set()));
        ids.add(r.id);
      }
    }
    for (const rt of seenTypes) {
      const fan = EPOCH_FANOUT[rt];
      if (!fan) {
        global = true; // unmapped type → safe-by-default global invalidation
        continue;
      }
      for (const t of fan) {
        if (OBJECT_EPOCH_TYPES.has(t)) continue; // пообъектный тип — точечные бампы ниже
        typeBumps.add(t);
      }
    }

    if (parentIdsByType.size) {
      try {
        const dependents = await this.db.relationTuple.findMany({
          where: {
            resourceType: 'chat',
            OR: [...parentIdsByType.entries()].map(([t, ids]) => ({
              subjectType: t,
              subjectId: { in: [...ids] },
            })),
          },
          select: { resourceId: true },
          distinct: ['resourceId'],
        });
        for (const d of dependents) objectBumps.add(`chat ${d.resourceId}`);
      } catch {
        typeBumps.add('chat'); // fail-safe: зависимые не найдены → сброс всего типа
      }
    }

    if (!global && typeBumps.size === 0 && objectBumps.size === 0) return;
    const m = this.redis.getClient().multi();
    if (global) m.incr(EPOCH_KEY);
    for (const t of typeBumps) m.incr(typeEpochKey(t));
    for (const packed of objectBumps) {
      const sep = packed.indexOf(' ');
      const key = objectEpochKey(packed.slice(0, sep), packed.slice(sep + 1));
      m.incr(key);
      m.expire(key, OBJECT_EPOCH_TTL_SECONDS);
    }
    await m.exec();
  }

  /**
   * Re-bump shortly after the caller's transaction is expected to have committed. The in-tx
   * bump happens BEFORE commit, so a concurrent check() can read the pre-commit DB state and
   * cache it under the new epoch; this delayed second bump invalidates that window.
   */
  private bumpLater(refs: EpochRef[]): void {
    const timer = setTimeout(() => {
      void this.bumpEpochs(refs).catch(() => undefined);
    }, 2000);
    timer.unref?.();
  }
}
