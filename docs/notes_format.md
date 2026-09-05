# Формат заметки: NoteDoc, Markdown-диалект, проекции

> Собственный JSON-формат документа заметки и всё, что из него выводится: Markdown-диалект платформы, чистый текст, теги/упоминания/вики-ссылки, чанки под RAG. Сервис, права и API — в [notes.md](notes.md).
>
> Код: `packages/shared/src/notes/` (`note-doc.ts` · `note-markdown.ts` · `note-extract.ts`), схемы входа ручек — `packages/shared/src/validation/notes.ts`.

## Состав

- **`NoteDoc`** (`packages/shared/src/notes/note-doc.ts`) — свой JSON: блоки `paragraph, heading(1–3), bulletList/orderedList/listItem, taskList/taskItem, blockquote, codeBlock, image(fileId), horizontalRule, table/tableRow/tableCell|tableHeader`; инлайн `text(bold, italic, underline, strike, code, link)`, `mention(userId,name)`, `wikilink(noteId,title)`, `tag(name)`, `hardBreak`. `validateNoteDoc` — лимиты (512 КБ, глубина 12, 20 000 узлов) + Zod, fail-closed на сервере; **порядок несущий**: форма считается обходом СТЕКОМ до `JSON.stringify` и до рекурсивной Zod-схемы. `canonicalNoteJson` — сортировка ключей для `contentHash`.
- **Адрес ссылки — белый список схем**: `isSafeNoteHref`/`normalizeNoteHref` (там же) пропускают только `http(s)`, `mailto`, `tel`, путь внутри приложения и якорь; `javascript:`, `data:`, протокол-относительные и адреса со скрытыми управляющими символами — не ссылка. Один и тот же список на ВСЕХ путях: Zod документа, парсер Markdown, вставка HTML в редактор (`parseDOM`), рендер (`toDOM`), форма ссылки в панели. Иначе клик по чужой заметке выполнял бы код в сессии зрителя.
- **Markdown-диалект** (`note-markdown.ts`): `@[Имя](user:<uuid>)`, `[[note:<uuid>|Заголовок]]`, `#тег`, `![alt|320](file:<uuid>)`, `- [ ]`, `<u>…</u>`. Сериализатор и СВОЙ парсер (CommonMark/GFM-подмножество) — round-trip байт-в-байт на собственном выводе; внешние библиотеки отвергнуты (mdast ESM-only при CJS-API). `markdownToNoteDoc` — вход ИИ (`POST /notes {markdown}`) и вставка Markdown из буфера.
- **Экстракторы** (`note-extract.ts`): теги (нижний регистр), упоминания, вики-ссылки, картинки, `deriveNoteTitle`, `noteSnippet`, **`chunkNoteDoc`** — короткая заметка = 1 чанк, длинная — по H1–H3, окна ~400 токенов (≤600) с перекрытием 60, `headingPath`. Контекст-префикс чанка собирает джоб (заметка · пространство · теги · привязки · дата) — Contextual Retrieval. Колонка `embedding` и движок `core/embeddings` — следующая задача (общая с Процессами Ф5).

## Связанные доки

[notes.md](notes.md) · [search_engine.md](search_engine.md) · [files_engine.md](files_engine.md)
