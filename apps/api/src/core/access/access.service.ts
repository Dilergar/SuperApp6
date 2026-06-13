import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { createResolver, ResolverReaders } from './access-resolver';
import { ACCESS_SCHEMA, EPOCH_FANOUT } from './access-schema';
import { CAPABILITIES, CapabilityKey } from './access-capabilities';
import { Principal, ResourceRef, RelationTupleInput } from './access.types';

type Tx = Prisma.TransactionClient;

const CACHE_TTL_SECONDS = 600;
const EPOCH_KEY = 'acl:epoch'; // global fallback (types not in EPOCH_FANOUT)
const typeEpochKey = (t: string) => `acl:epoch:${t}`;

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

  /** Does `subject` hold `relation` on `resource`? Cached per (global.type) epoch. */
  async check(subject: Principal, relation: string, resource: ResourceRef): Promise<boolean> {
    const epoch = await this.epochFor(resource.type);
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
    await this.bumpEpochFor([tuple.resourceType]);
    if (tx) this.bumpLater([tuple.resourceType]);
  }

  async grantMany(tuples: RelationTupleInput[]): Promise<void> {
    if (tuples.length === 0) return;
    await this.db.relationTuple.createMany({
      data: tuples.map((t) => this.normalize(t)),
      skipDuplicates: true,
    });
    await this.bumpEpochFor(tuples.map((t) => t.resourceType));
  }

  async revoke(tuple: RelationTupleInput, tx?: Tx): Promise<void> {
    await (tx ?? this.db).relationTuple.deleteMany({ where: this.normalize(tuple) });
    await this.bumpEpochFor([tuple.resourceType]);
    if (tx) this.bumpLater([tuple.resourceType]);
  }

  /** Remove every edge on a resource (e.g. when the resource is deleted). */
  async revokeResource(resourceType: string, resourceId: string, tx?: Tx): Promise<void> {
    await (tx ?? this.db).relationTuple.deleteMany({ where: { resourceType, resourceId } });
    await this.bumpEpochFor([resourceType]);
    if (tx) this.bumpLater([resourceType]);
  }

  /** Delete specific tuples by id (used by the projection reconciler). */
  async revokeByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    // Resolve the affected types BEFORE deleting so the right epochs get bumped.
    const rows = await this.db.relationTuple.findMany({
      where: { id: { in: ids } },
      select: { resourceType: true },
      distinct: ['resourceType'],
    });
    await this.db.relationTuple.deleteMany({ where: { id: { in: ids } } });
    await this.bumpEpochFor(rows.map((r) => r.resourceType));
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

  /** Effective epoch for a resource type = global epoch . per-type epoch. */
  private async epochFor(resourceType: string): Promise<string> {
    const [g, t] = await this.redis.getClient().mget(EPOCH_KEY, typeEpochKey(resourceType));
    return `${g ?? '0'}.${t ?? '0'}`;
  }

  /** Bump the epochs of every type the mutated tuples can influence (EPOCH_FANOUT). */
  private async bumpEpochFor(resourceTypes: Iterable<string>): Promise<void> {
    const toBump = new Set<string>();
    let global = false;
    for (const rt of new Set(resourceTypes)) {
      const fan = EPOCH_FANOUT[rt];
      if (!fan) {
        global = true; // unmapped type → safe-by-default global invalidation
        continue;
      }
      for (const t of fan) toBump.add(t);
    }
    if (!global && toBump.size === 0) return;
    const m = this.redis.getClient().multi();
    if (global) m.incr(EPOCH_KEY);
    for (const t of toBump) m.incr(typeEpochKey(t));
    await m.exec();
  }

  /**
   * Re-bump shortly after the caller's transaction is expected to have committed. The in-tx
   * bump happens BEFORE commit, so a concurrent check() can read the pre-commit DB state and
   * cache it under the new epoch; this delayed second bump invalidates that window.
   */
  private bumpLater(resourceTypes: string[]): void {
    const timer = setTimeout(() => {
      void this.bumpEpochFor(resourceTypes).catch(() => undefined);
    }, 2000);
    timer.unref?.();
  }
}
