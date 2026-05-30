/* eslint-disable */
// Phase 0 check for the unified access engine (core/access). Spins up the REAL
// AccessService on the extended Prisma client + Redis (no full Nest boot). Exercises:
// direct grant, public wildcard, group userset (circle#member), parent inheritance
// (showcase ← shop), calendar levels (busy < detailed), capability mapping, listObjects
// (reverse), and INSTANT revocation via epoch-invalidated cache.
// Run after `nest build`: `node scripts/verify-access.cjs`
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

const P = 'acltest'; // all test ids are prefixed so cleanup is targeted
const user = (id) => ({ type: 'user', id: `${P}-${id}` });

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

  const wipe = async () => {
    await db.relationTuple.deleteMany({ where: { resourceId: { startsWith: P } } });
    await db.relationTuple.deleteMany({ where: { subjectId: { startsWith: P } } });
  };

  try {
    await wipe();

    // 1) Direct grant
    await access.grant({ resourceType: 'card', resourceId: `${P}-card1`, relation: 'viewer', subjectType: 'user', subjectId: `${P}-u1` });
    await check('direct: granted user sees card', () => access.check(user('u1'), 'viewer', { type: 'card', id: `${P}-card1` }), true);
    await check('direct: other user does not', () => access.check(user('u2'), 'viewer', { type: 'card', id: `${P}-card1` }), false);

    // 2) Public wildcard
    await access.grant({ resourceType: 'card', resourceId: `${P}-card2`, relation: 'viewer', subjectType: 'public', subjectId: '*' });
    await check('public: any user sees public card', () => access.check(user('nobody'), 'viewer', { type: 'card', id: `${P}-card2` }), true);

    // 3) Group userset: circle members see a showcase shared to the circle
    await access.grant({ resourceType: 'circle', resourceId: `${P}-fam`, relation: 'member', subjectType: 'user', subjectId: `${P}-u2` });
    await access.grant({ resourceType: 'showcase', resourceId: `${P}-sc1`, relation: 'viewer', subjectType: 'circle', subjectId: `${P}-fam`, subjectRelation: 'member' });
    await check('group: circle member sees showcase', () => access.check(user('u2'), 'viewer', { type: 'showcase', id: `${P}-sc1` }), true);
    await check('group: non-member does not', () => access.check(user('u3'), 'viewer', { type: 'showcase', id: `${P}-sc1` }), false);

    // 4) Inheritance: shop owner manages (and so can view) every showcase under the shop
    await access.grant({ resourceType: 'shop', resourceId: `${P}-shop1`, relation: 'owner', subjectType: 'user', subjectId: `${P}-own` });
    await access.grant({ resourceType: 'showcase', resourceId: `${P}-sc2`, relation: 'parent', subjectType: 'shop', subjectId: `${P}-shop1` });
    await check('inherit: shop owner manages child showcase', () => access.check(user('own'), 'manager', { type: 'showcase', id: `${P}-sc2` }), true);
    await check('inherit: → also viewer (viewer ⊇ manager)', () => access.check(user('own'), 'viewer', { type: 'showcase', id: `${P}-sc2` }), true);

    // 5) Calendar levels: owner = detailed; explicit busy = busy; none = null
    await access.grant({ resourceType: 'calendar', resourceId: `${P}-cal1`, relation: 'owner', subjectType: 'user', subjectId: `${P}-own` });
    await access.grant({ resourceType: 'calendar', resourceId: `${P}-cal1`, relation: 'busy_viewer', subjectType: 'user', subjectId: `${P}-vu` });
    await check('level: owner → detailed', () => access.resolveLevel(user('own'), { type: 'calendar', id: `${P}-cal1` }), 'detailed_viewer');
    await check('level: busy share → busy', () => access.resolveLevel(user('vu'), { type: 'calendar', id: `${P}-cal1` }), 'busy_viewer');
    await check('level: stranger → null', () => access.resolveLevel(user('u3'), { type: 'calendar', id: `${P}-cal1` }), null);

    // 6) Capability mapping
    await check('capability: showcase.view via group', () => access.can(user('u2'), 'showcase.view', `${P}-sc1`), true);

    // 7) listObjects (reverse): which showcases can u2 view → sc1 (via circle)
    await check('listObjects: u2 viewable showcases', async () => {
      const ids = await access.listObjects(user('u2'), 'viewer', 'showcase');
      return ids.includes(`${P}-sc1`) && !ids.includes(`${P}-sc2`);
    }, true);

    // 8) INSTANT revocation: remove the circle→showcase grant, re-check (epoch busts cache)
    await access.revoke({ resourceType: 'showcase', resourceId: `${P}-sc1`, relation: 'viewer', subjectType: 'circle', subjectId: `${P}-fam`, subjectRelation: 'member' });
    await check('revoke: member loses access immediately', () => access.check(user('u2'), 'viewer', { type: 'showcase', id: `${P}-sc1` }), false);

    // 9) Platform persona (additive — gates FUTURE features, nothing existing)
    await access.grant({ resourceType: 'platform', resourceId: `${P}-plat`, relation: 'seller', subjectType: 'user', subjectId: `${P}-seller` });
    await check('persona: seller has marketplace.sell', () => access.can(user('seller'), 'marketplace.sell', `${P}-plat`), true);
    await check('persona: non-seller lacks marketplace.sell', () => access.can(user('u3'), 'marketplace.sell', `${P}-plat`), false);

    // 10) Phase 4 foundation — B2B employee-card visibility: a department grant upgrades that
    //     department's members from the floor (Имя+Должность) to the FULL card.
    await access.grant({ resourceType: 'card', resourceId: `${P}-emp`, relation: 'full_viewer', subjectType: 'department', subjectId: `${P}-sales`, subjectRelation: 'member' });
    await access.grant({ resourceType: 'department', resourceId: `${P}-sales`, relation: 'member', subjectType: 'user', subjectId: `${P}-colleague` });
    await check('card.view_full: sales member sees full employee card', () => access.can(user('colleague'), 'card.view_full', `${P}-emp`), true);
    await check('card.view_full: outsider sees only floor (no full)', () => access.can(user('u3'), 'card.view_full', `${P}-emp`), false);

    // 11) Phase 4 foundation — branch as a sharing principal (e.g. a showcase shared to a branch).
    await access.grant({ resourceType: 'showcase', resourceId: `${P}-bsc`, relation: 'viewer', subjectType: 'branch', subjectId: `${P}-br`, subjectRelation: 'member' });
    await access.grant({ resourceType: 'branch', resourceId: `${P}-br`, relation: 'member', subjectType: 'user', subjectId: `${P}-bemp` });
    await check('branch principal: branch member sees branch-shared showcase', () => access.can(user('bemp'), 'showcase.view', `${P}-bsc`), true);

    await wipe();
  } finally {
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
