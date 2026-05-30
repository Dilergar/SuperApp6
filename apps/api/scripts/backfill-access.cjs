/* eslint-disable */
// Phase 1 one-time backfill: mirror existing Circle memberships + workspace UserRoles
// into the access engine's tuple store (diff-based — safe to re-run; also self-heals
// orphan tuples). Run after `nest build`: `node scripts/backfill-access.cjs`
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

async function main() {
  const db = buildScopedPrismaClient(new WorkspaceContextService());
  await db.$connect();
  const redis = new RedisService();
  const projection = new AccessProjectionService(db, new AccessService(db, redis));
  try {
    const res = await projection.reconcile();
    const shops = await projection.backfillShops();
    const calendar = await projection.backfillCalendar();
    const tasks = await projection.backfillTasks();
    console.log('access backfill/reconcile:', JSON.stringify({ ...res, shops, calendar, tasks }, null, 2));
  } finally {
    await db.$disconnect();
    await redis.getClient().quit();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
