/* eslint-disable */
// Phase 1 check for the access PROJECTION (domain → tuples). Seeds real rows (users,
// circle, contact link, membership, workspace role), runs the REAL AccessProjectionService
// reconcile, and asserts the engine now answers from the mirrored tuples. Also checks the
// live hooks and drift cleanup. Cleans up after itself.
// Run after `nest build`: `node scripts/verify-access-projection.cjs`
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { buildScopedPrismaClient } = require('../dist/shared/database/database.service');
const { WorkspaceContextService } = require('../dist/shared/context/workspace-context.service');
const { RedisService } = require('../dist/shared/redis/redis.service');
const { AccessService } = require('../dist/core/access/access.service');
const { AccessProjectionService } = require('../dist/core/access/access-projection.service');

const PHONE_OWN = '+79990001011';
const PHONE_MEM = '+79990001012';
const WS = 'acl-test-ws-0001';
const GHOST = 'acl-test-ghost';

let fails = 0;
async function check(name, fn, expected) {
  const got = await fn();
  const ok = got === expected;
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${name}  (got ${JSON.stringify(got)})`);
  if (!ok) fails++;
}

async function main() {
  const db = buildScopedPrismaClient(new WorkspaceContextService());
  await db.$connect();
  const redis = new RedisService();
  const access = new AccessService(db, redis);
  const projection = new AccessProjectionService(db, access);

  let own, mem, circle;
  const u = (id) => ({ type: 'user', id });

  // Pre-clean any leftovers from a prior crashed run.
  await db.user.deleteMany({ where: { phone: { in: [PHONE_OWN, PHONE_MEM] } } });

  try {
    own = await db.user.create({ data: { phone: PHONE_OWN, password: 'x', firstName: 'AclOwn' } });
    mem = await db.user.create({ data: { phone: PHONE_MEM, password: 'x', firstName: 'AclMem' } });
    const [a, b] = own.id < mem.id ? [own.id, mem.id] : [mem.id, own.id];
    const link = await db.contactLink.create({ data: { userAId: a, userBId: b, initiatedBy: own.id } });
    circle = await db.circle.create({ data: { ownerId: own.id, name: 'AclTestGroup' } });
    await db.circleMembership.create({ data: { circleId: circle.id, contactLinkId: link.id } });
    await db.userRole.create({ data: { userId: mem.id, role: 'admin', context: 'workspace', tenantId: WS } });

    // 1) Reconcile mirrors domain → tuples
    await projection.reconcile();
    await check('reconcile: circle member projected', () => access.check(u(mem.id), 'member', { type: 'circle', id: circle.id }), true);
    await check('reconcile: workspace admin projected', () => access.check(u(mem.id), 'admin', { type: 'workspace', id: WS }), true);
    await check('reconcile: admin ⇒ member (role rule)', () => access.check(u(mem.id), 'member', { type: 'workspace', id: WS }), true);
    await check('reconcile: not owner', () => access.check(u(mem.id), 'owner', { type: 'workspace', id: WS }), false);

    // 2) Live hooks (best-effort grant/revoke used by CirclesService)
    await projection.circleMemberRemoved(circle.id, mem.id);
    await check('hook: member removed live', () => access.check(u(mem.id), 'member', { type: 'circle', id: circle.id }), false);
    await projection.circleMemberAdded(circle.id, mem.id);
    await check('hook: member re-added live', () => access.check(u(mem.id), 'member', { type: 'circle', id: circle.id }), true);

    // 3) Drift cleanup: a bogus tuple not backed by the domain is removed by reconcile
    await db.relationTuple.create({ data: { resourceType: 'circle', resourceId: circle.id, relation: 'member', subjectType: 'user', subjectId: GHOST, subjectRelation: '' } });
    await check('drift: ghost present before reconcile', () => access.check(u(GHOST), 'member', { type: 'circle', id: circle.id }), true);
    await projection.reconcile();
    await check('drift: ghost removed by reconcile', () => access.check(u(GHOST), 'member', { type: 'circle', id: circle.id }), false);

    // 4) resyncUserWorkspaceRoles after a role is revoked
    await db.userRole.updateMany({ where: { userId: mem.id, context: 'workspace', tenantId: WS }, data: { isActive: false } });
    await projection.resyncUserWorkspaceRoles(mem.id);
    await check('resync: revoked role removed', () => access.check(u(mem.id), 'admin', { type: 'workspace', id: WS }), false);
  } finally {
    // Cleanup: tuples (FK-free) then users (cascades circle/link/membership/role).
    const ids = [circle && circle.id, WS].filter(Boolean);
    const subj = [own && own.id, mem && mem.id, GHOST].filter(Boolean);
    await db.relationTuple.deleteMany({ where: { OR: [{ resourceId: { in: ids } }, { subjectId: { in: subj } }] } });
    await db.user.deleteMany({ where: { phone: { in: [PHONE_OWN, PHONE_MEM] } } });
    await db.$disconnect();
    await redis.getClient().quit();
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAIL(S)`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
