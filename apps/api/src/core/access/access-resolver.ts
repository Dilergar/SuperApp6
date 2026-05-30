// The rule evaluator: pure graph-walk over tuples + ACCESS_SCHEMA rewrite rules.
// Decoupled from Prisma via the ResolverReaders interface (so it is unit-testable and
// the service can wire it to the DB / a cache). Handles DAGs (memoization) and cycles
// (in-progress guard), with a depth cap.

import { ACCESS_SCHEMA, RelationRule } from './access-schema';
import { Principal, ResourceRef, SubjectRef } from './access.types';

const MAX_DEPTH = 24;
const MAX_VISITED = 10_000; // listObjects frontier safety cap

export interface ResolverReaders {
  /** Subject side of every tuple on (resourceType, resourceId, relation). Forward walk. */
  subjectsOf(resourceType: string, resourceId: string, relation: string): Promise<SubjectRef[]>;
  /** Every edge where (subjectType, subjectId) is the subject. Reverse walk for listObjects. */
  edgesForSubject(
    subjectType: string,
    subjectId: string,
  ): Promise<Array<{ resourceType: string; resourceId: string; relation: string; subjectRelation: string }>>;
}

interface CheckCtx {
  subject: Principal;
  memo: Map<string, boolean>; // (resource#relation) -> result, for the fixed subject
  inProgress: Set<string>; // cycle guard
}

export function createResolver(readers: ResolverReaders) {
  async function check(subject: Principal, relation: string, resource: ResourceRef): Promise<boolean> {
    return checkInner(relation, resource, 0, {
      subject,
      memo: new Map(),
      inProgress: new Set(),
    });
  }

  async function checkInner(
    relation: string,
    resource: ResourceRef,
    depth: number,
    ctx: CheckCtx,
  ): Promise<boolean> {
    if (depth > MAX_DEPTH) return false;
    const rule = ACCESS_SCHEMA[resource.type]?.relations[relation];
    if (!rule) return false;

    const key = `${resource.type}:${resource.id}#${relation}`;
    const cached = ctx.memo.get(key);
    if (cached !== undefined) return cached;
    if (ctx.inProgress.has(key)) return false; // cycle: this path contributes nothing

    ctx.inProgress.add(key);
    const result = await evalRule(rule, relation, resource, depth, ctx);
    ctx.inProgress.delete(key);
    ctx.memo.set(key, result);
    return result;
  }

  async function evalRule(
    rule: RelationRule,
    relation: string,
    resource: ResourceRef,
    depth: number,
    ctx: CheckCtx,
  ): Promise<boolean> {
    switch (rule.kind) {
      case 'this': {
        const subjects = await readers.subjectsOf(resource.type, resource.id, relation);
        for (const s of subjects) {
          if (s.subjectType === 'public') return true;
          if (s.subjectRelation === '') {
            if (s.subjectType === ctx.subject.type && s.subjectId === ctx.subject.id) return true;
            // else: a directly-named object (e.g. a parent pointer) — not the actor; skip
          } else if (
            await checkInner(s.subjectRelation, { type: s.subjectType, id: s.subjectId }, depth + 1, ctx)
          ) {
            return true; // userset: actor holds subjectRelation on the subject object
          }
        }
        return false;
      }
      case 'computedUserset':
        return checkInner(rule.relation, resource, depth + 1, ctx);
      case 'tupleToUserset': {
        const parents = await readers.subjectsOf(resource.type, resource.id, rule.tupleset);
        for (const p of parents) {
          if (p.subjectRelation !== '') continue; // parent pointers are direct object subjects
          if (await checkInner(rule.computedUserset, { type: p.subjectType, id: p.subjectId }, depth + 1, ctx)) {
            return true;
          }
        }
        return false;
      }
      case 'union':
        for (const child of rule.children) {
          if (await evalRule(child, relation, resource, depth, ctx)) return true;
        }
        return false;
    }
    return false;
  }

  // Reverse query: which resources of `resourceType` does `subject` hold `relation` on.
  // BFS the reverse index from the subject (itself + public + every group/parent it
  // reaches) to gather candidate resources, then verify each with check() so the rule
  // rewrites (inheritance, levels, unions) are honored exactly.
  async function listObjects(subject: Principal, relation: string, resourceType: string): Promise<string[]> {
    const candidates = new Set<string>();
    const visited = new Set<string>();
    const frontier: Array<{ type: string; id: string }> = [
      { type: subject.type, id: subject.id },
      { type: 'public', id: '*' },
    ];

    while (frontier.length && visited.size < MAX_VISITED) {
      const p = frontier.pop()!;
      const pk = `${p.type}:${p.id}`;
      if (visited.has(pk)) continue;
      visited.add(pk);

      const edges = await readers.edgesForSubject(p.type, p.id);
      for (const e of edges) {
        if (e.resourceType === resourceType) candidates.add(e.resourceId);
        const nk = `${e.resourceType}:${e.resourceId}`;
        if (!visited.has(nk)) frontier.push({ type: e.resourceType, id: e.resourceId });
      }
    }

    const out: string[] = [];
    for (const id of candidates) {
      if (await check(subject, relation, { type: resourceType, id })) out.push(id);
    }
    return out;
  }

  return { check, listObjects };
}
