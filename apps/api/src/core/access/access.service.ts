import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { createResolver, ResolverReaders } from './access-resolver';
import { ACCESS_SCHEMA } from './access-schema';
import { CAPABILITIES, CapabilityKey } from './access-capabilities';
import { Principal, ResourceRef, RelationTupleInput } from './access.types';

type Tx = Prisma.TransactionClient;

const CACHE_TTL_SECONDS = 600;
const EPOCH_KEY = 'acl:epoch';

/**
 * Unified authorization engine (ReBAC). Phase 0: the core only — nothing consumes it yet.
 *
 * Reads resolve permissions from relationship tuples + ACCESS_SCHEMA rewrite rules.
 * check() results are cached in Redis keyed by a global EPOCH; every write bumps the
 * epoch (INCR), so a grant/revoke takes effect instantly (closes the "new enemy"
 * problem). The global epoch is coarse but correct (writes are rare vs reads); a
 * per-scope epoch / Leopard-style index is a later perf optimization.
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
      edgesForSubject: (subjectType, subjectId) =>
        this.db.relationTuple.findMany({
          where: { subjectType, subjectId },
          select: { resourceType: true, resourceId: true, relation: true, subjectRelation: true },
        }),
    };
    this.resolver = createResolver(readers);
  }

  // ------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------

  /** Does `subject` hold `relation` on `resource`? Cached per epoch. */
  async check(subject: Principal, relation: string, resource: ResourceRef): Promise<boolean> {
    const epoch = await this.epoch();
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
  // rolled-back tx is harmless (just a cache miss).
  async grant(tuple: RelationTupleInput, tx?: Tx): Promise<void> {
    const data = this.normalize(tuple);
    await (tx ?? this.db).relationTuple.upsert({
      where: {
        resourceType_resourceId_relation_subjectType_subjectId_subjectRelation: data,
      },
      create: data,
      update: {},
    });
    await this.bumpEpoch();
  }

  async grantMany(tuples: RelationTupleInput[]): Promise<void> {
    if (tuples.length === 0) return;
    await this.db.relationTuple.createMany({
      data: tuples.map((t) => this.normalize(t)),
      skipDuplicates: true,
    });
    await this.bumpEpoch();
  }

  async revoke(tuple: RelationTupleInput, tx?: Tx): Promise<void> {
    await (tx ?? this.db).relationTuple.deleteMany({ where: this.normalize(tuple) });
    await this.bumpEpoch();
  }

  /** Remove every edge on a resource (e.g. when the resource is deleted). */
  async revokeResource(resourceType: string, resourceId: string, tx?: Tx): Promise<void> {
    await (tx ?? this.db).relationTuple.deleteMany({ where: { resourceType, resourceId } });
    await this.bumpEpoch();
  }

  /** Delete specific tuples by id (used by the projection reconciler). */
  async revokeByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.relationTuple.deleteMany({ where: { id: { in: ids } } });
    await this.bumpEpoch();
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

  private async epoch(): Promise<string> {
    return (await this.redis.get(EPOCH_KEY)) ?? '0';
  }

  private async bumpEpoch(): Promise<void> {
    await this.redis.getClient().incr(EPOCH_KEY);
  }
}
