/* eslint-disable */
// Разовый перенос: название заметки перестало быть отдельным полем — теперь это ПЕРВАЯ
// СТРОКА документа. У заметок, заведённых раньше, название могло не совпадать с текстом;
// чтобы оно не пропало из виду, вставляем его заголовком в начало документа и
// пересчитываем производные (title, markdown, чистый текст, теги, хеш).
//
// Идемпотентно: заметка, у которой первая строка уже равна названию, не трогается.
// Run: node scripts/migrate-note-titles.cjs [--apply]
const { PrismaClient } = require('@prisma/client');
const {
  canonicalNoteJson,
  deriveNoteTitle,
  extractNoteTags,
  noteDocToMarkdown,
  noteDocToPlainText,
} = require('@superapp/shared');
const { createHash } = require('crypto');

const APPLY = process.argv.includes('--apply');

function withTitleLine(doc, title) {
  const heading = { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: title }] };
  const rest = Array.isArray(doc?.content) ? doc.content : [];
  // Пустой первый абзац не тащим — заголовок встаёт на его место
  const tail = rest.length === 1 && rest[0]?.type === 'paragraph' && !rest[0]?.content ? [] : rest;
  return { type: 'doc', content: [heading, ...tail] };
}

async function main() {
  const prisma = new PrismaClient();
  const notes = await prisma.note.findMany({ select: { id: true, title: true, content: true } });
  let moved = 0;
  let retitled = 0;
  for (const note of notes) {
    const doc = note.content;
    const derived = deriveNoteTitle(doc, '').slice(0, 200);
    if (note.title && note.title !== derived) {
      const next = withTitleLine(doc, note.title);
      const canonical = canonicalNoteJson(next);
      moved += 1;
      if (APPLY) {
        await prisma.note.update({
          where: { id: note.id },
          data: {
            content: JSON.parse(canonical),
            title: deriveNoteTitle(next, '').slice(0, 200),
            contentMd: noteDocToMarkdown(next),
            plainText: noteDocToPlainText(next),
            tags: extractNoteTags(next),
            contentHash: createHash('sha256').update(canonical).digest('hex'),
          },
        });
      }
      continue;
    }
    if (note.title !== derived) {
      retitled += 1;
      if (APPLY) await prisma.note.update({ where: { id: note.id }, data: { title: derived } });
    }
  }
  console.log(
    `${APPLY ? 'Перенесено' : 'Будет перенесено'}: название стало первой строкой у ${moved}; ` +
      `название пересчитано из текста у ${retitled}; всего заметок ${notes.length}` +
      (APPLY ? '' : ' (пробный прогон, повторите с --apply)'),
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
