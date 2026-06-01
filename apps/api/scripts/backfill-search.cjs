/* eslint-disable */
// Phase 6 one-time backfill: mirror existing text messages into the search index
// (search_documents). Idempotent (upsert) — safe to re-run. Chats + people are searched
// LIVE, so only messages need indexing. Run after migrate deploy: `node scripts/backfill-search.cjs`
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const BATCH = 1000;

async function main() {
  let cursor = undefined;
  let total = 0;
  for (;;) {
    const msgs = await prisma.message.findMany({
      where: { type: 'text', deletedAt: null, content: { not: null } },
      select: { id: true, chatId: true, authorId: true, content: true, seq: true, createdAt: true },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (msgs.length === 0) break;

    for (const m of msgs) {
      const data = {
        url: `/messenger?chat=${m.chatId}&msg=${m.id}`,
        body: m.content,
        chatId: m.chatId,
        seq: m.seq,
        authorId: m.authorId,
        itemCreatedAt: m.createdAt,
      };
      await prisma.searchDocument.upsert({
        where: { sourceType_sourceId: { sourceType: 'message', sourceId: m.id } },
        create: { sourceType: 'message', sourceId: m.id, ...data },
        update: data,
      });
      total++;
    }
    cursor = msgs[msgs.length - 1].id;
    if (msgs.length < BATCH) break;
  }
  console.log(`search backfill: indexed ${total} messages`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
