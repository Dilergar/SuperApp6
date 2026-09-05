import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NOTE_JOB_TYPES, chunkNoteDoc, type NoteDoc } from '@superapp/shared';
import { JobDiscardError, JobsRegistry } from '../../core/jobs/jobs.registry';
import { DatabaseService } from '../../shared/database/database.service';
import { NotesSearchService } from './notes-search.service';

/**
 * Фоновые проекции заметки (core/jobs): витрина поиска и чанки под RAG.
 *
 * Ставится `enqueue(tx)` в транзакции мутации (сохранение, переименование, корзина,
 * восстановление) с uniqueKey по версии и состоянию корзины. Обработчик идемпотентен и
 * работает по ТЕКУЩЕМУ состоянию: версия в БД новее payload — джоб устарел и тихо
 * заканчивается; заметка в корзине или удалена — витрина и чанки чистятся.
 */
@Injectable()
export class NotesJobs implements OnModuleInit {
  private readonly logger = new Logger(NotesJobs.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: JobsRegistry,
    private readonly search: NotesSearchService,
  ) {}

  onModuleInit(): void {
    this.registry.register(NOTE_JOB_TYPES.project, (payload) => this.project(payload), {
      queue: 'default',
      maxAttempts: 5,
    });
  }

  private async project(payload: Record<string, unknown>): Promise<void> {
    const noteId = typeof payload.noteId === 'string' ? payload.noteId : null;
    const contentHash = typeof payload.contentHash === 'string' ? payload.contentHash : null;
    if (!noteId || !contentHash) throw new JobDiscardError('notes.project: нет noteId/contentHash');
    const version = typeof payload.version === 'number' ? payload.version : null;

    const note = await this.db.note.findUnique({
      where: { id: noteId },
      select: {
        id: true,
        spaceId: true,
        title: true,
        plainText: true,
        version: true,
        content: true,
        contentHash: true,
        tags: true,
        updatedAt: true,
        deletedAt: true,
        space: { select: { ownerType: true, ownerId: true } },
        links: { where: { kind: 'related' }, select: { targetType: true, targetId: true } },
      },
    });
    // Заметки нет — чистим следы (витрина поиска ведётся ЗДЕСЬ: синхронный вызов
    // после коммита best-effort, а этот джоб — гарантия, что витрина всё же сойдётся).
    if (!note) {
      await this.search.remove(noteId);
      throw new JobDiscardError('заметка удалена');
    }
    if (version !== null && note.version > version) return; // работа устарела, следующий джоб уже стоит
    if (note.deletedAt) {
      await this.search.remove(noteId);
      await this.db.noteChunk.deleteMany({ where: { noteId } });
      return;
    }
    await this.search.index({ ...note, ownerType: note.space.ownerType, ownerId: note.space.ownerId });
    if (note.contentHash !== contentHash) return;

    const already = await this.db.noteChunk.findFirst({ where: { noteId, contentHash }, select: { id: true } });
    if (already) return; // идемпотентность: этот хеш уже нарезан

    const doc = note.content as unknown as NoteDoc;
    const drafts = chunkNoteDoc(doc);
    const prefixBase = await this.contextPrefix(note);

    await this.db.$transaction(async (tx) => {
      await tx.noteChunk.deleteMany({ where: { noteId } });
      if (!drafts.length) return;
      await tx.noteChunk.createMany({
        data: drafts.map((d) => ({
          noteId,
          spaceId: note.spaceId,
          ord: d.ord,
          headingPath: d.headingPath,
          text: d.text,
          contextPrefix: d.headingPath.length ? `${prefixBase} · ${d.headingPath.join(' › ')}` : prefixBase,
          tokenCount: d.tokenCount,
          contentHash,
        })),
      });
    });
    this.logger.debug(`заметка ${noteId}: ${drafts.length} чанков`);
  }

  /**
   * Контекст-префикс чанка (Contextual Retrieval): заголовок, где живёт заметка, теги,
   * к чему привязана, дата. Считается один раз на заметку, дописывается путём заголовков.
   */
  private async contextPrefix(note: {
    title: string;
    tags: string[];
    updatedAt: Date;
    space: { ownerType: string; ownerId: string };
    links: Array<{ targetType: string; targetId: string }>;
  }): Promise<string> {
    let where = 'личные заметки';
    if (note.space.ownerType === 'workspace') {
      const ws = await this.db.workspace.findUnique({ where: { id: note.space.ownerId }, select: { name: true } });
      where = ws ? `организация «${ws.name}»` : 'организация';
    }
    const parts = [`Заметка «${note.title || 'Без названия'}»`, where];
    if (note.tags.length) parts.push(`теги: ${note.tags.map((t) => `#${t}`).join(' ')}`);
    if (note.links.length) parts.push(`привязано: ${note.links.map((l) => `${l.targetType}:${l.targetId}`).join(', ')}`);
    parts.push(note.updatedAt.toISOString().slice(0, 10));
    return parts.join(' · ');
  }
}

export type { Prisma };
