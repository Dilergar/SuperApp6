import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  NOTE_ERROR_CODES,
  NOTE_LIMITS,
  extractNoteWikilinks,
  type NoteBacklinkDto,
  type NoteDoc,
  type NoteRelatedDto,
  type NoteRelatedTargetType,
  type NoteTargetSearchItemDto,
  type NoteWikilinkCandidateDto,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { NotesAccessService, type NoteScope } from './notes-access.service';
import { NoteTargetRegistry } from './notes-targets.registry';

type Tx = Prisma.TransactionClient;

/**
 * Ссылки заметки: вики-ссылки на другие заметки (выводятся из документа при
 * сохранении) и привязки к бизнес-сущностям (модель Salesforce «Relate To»). Обе живут
 * в одной таблице NoteLink — обратные ссылки и панель «Заметки» на карточке сущности
 * читаются одним запросом по (target_type, target_id).
 */
@Injectable()
export class NotesLinksService {
  constructor(
    private readonly db: DatabaseService,
    private readonly acl: NotesAccessService,
    private readonly targets: NoteTargetRegistry,
  ) {}

  // ------------------------------------------------------------
  // Вики-ссылки
  // ------------------------------------------------------------

  /** Пересобрать вики-ссылки заметки из документа (diff: лишние снять, новые добавить) */
  async syncWikilinks(tx: Tx, noteId: string, doc: NoteDoc, actorId: string): Promise<void> {
    const wanted = new Set(extractNoteWikilinks(doc).map((w) => w.noteId).filter((id) => id !== noteId));
    const existing = await tx.noteLink.findMany({
      where: { noteId, kind: 'wikilink', targetType: 'note' },
      select: { id: true, targetId: true },
    });
    const have = new Set(existing.map((e) => e.targetId));
    const gone = existing.filter((e) => !wanted.has(e.targetId)).map((e) => e.id);
    if (gone.length) await tx.noteLink.deleteMany({ where: { id: { in: gone } } });
    const add = [...wanted].filter((id) => !have.has(id));
    if (add.length) {
      await tx.noteLink.createMany({
        data: add.map((targetId) => ({ noteId, targetType: 'note', targetId, kind: 'wikilink', createdById: actorId })),
        skipDuplicates: true,
      });
    }
  }

  /** Кто ссылается на эту заметку — только те источники, что видны зрителю */
  async backlinks(scope: NoteScope, noteId: string): Promise<NoteBacklinkDto[]> {
    const links = await this.db.noteLink.findMany({
      where: { targetType: 'note', targetId: noteId, kind: 'wikilink' },
      select: { noteId: true },
    });
    if (!links.length) return [];
    const rows = await this.db.note.findMany({
      where: {
        ...this.acl.visibleNotesWhere(scope),
        id: { in: links.map((l) => l.noteId) },
        deletedAt: null,
      },
      select: { id: true, title: true, folderId: true },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => ({ noteId: r.id, title: r.title, folderId: r.folderId }));
  }

  /** Кандидаты `[[` — заметки пространства, видимые зрителю */
  async wikilinkCandidates(scope: NoteScope, q: string | undefined, exclude?: string): Promise<NoteWikilinkCandidateDto[]> {
    const needle = (q ?? '').trim();
    const rows = await this.db.note.findMany({
      where: {
        ...this.acl.visibleNotesWhere(scope),
        deletedAt: null,
        ...(exclude ? { id: { not: exclude } } : {}),
        ...(needle ? { title: { contains: needle, mode: 'insensitive' } } : {}),
      },
      select: { id: true, title: true, folder: { select: { name: true } } },
      orderBy: { updatedAt: 'desc' },
      take: NOTE_LIMITS.pickerLimit,
    });
    return rows.map((r) => ({ id: r.id, title: r.title || 'Без названия', folderName: r.folder?.name ?? null }));
  }

  // ------------------------------------------------------------
  // Привязки к сущностям
  // ------------------------------------------------------------

  /**
   * Проверить, что зритель видит цель (право решает модуль-цель), и вернуть описание.
   * Рабочая заметка привязывается только к сущностям СВОЕЙ организации: иначе панель
   * «Заметки» карточки в одной организации показывала бы заметки из другой.
   */
  async requireTarget(viewerId: string, scope: NoteScope, targetType: NoteRelatedTargetType, targetId: string) {
    const resolver = this.targets.get(targetType);
    if (!resolver) throw new BadRequestException('Неизвестный тип сущности для привязки');
    // describe отдаёт null там же, где canView вернул бы false — хватает одного вызова
    const described = await resolver.describe(viewerId, targetId);
    if (!described) {
      throw new BadRequestException({
        message: 'Сущность не найдена или недоступна',
        details: { code: NOTE_ERROR_CODES.targetNotVisible },
      });
    }
    const noteWorkspaceId = scope.space.ownerType === 'workspace' ? scope.space.ownerId : null;
    if (noteWorkspaceId && described.workspaceId && described.workspaceId !== noteWorkspaceId) {
      throw new BadRequestException({
        message: 'Эта сущность принадлежит другой организации',
        details: { code: NOTE_ERROR_CODES.targetNotVisible },
      });
    }
    return described;
  }

  async addRelated(tx: Tx, noteId: string, targetType: NoteRelatedTargetType, targetId: string, actorId: string): Promise<boolean> {
    const count = await tx.noteLink.count({ where: { noteId, kind: 'related' } });
    if (count >= NOTE_LIMITS.maxRelated) throw new BadRequestException('Слишком много привязок у одной заметки');
    const res = await tx.noteLink.createMany({
      data: [{ noteId, targetType, targetId, kind: 'related', createdById: actorId }],
      skipDuplicates: true,
    });
    return res.count > 0;
  }

  async removeRelated(tx: Tx, noteId: string, targetType: string, targetId: string): Promise<boolean> {
    const res = await tx.noteLink.deleteMany({ where: { noteId, kind: 'related', targetType, targetId } });
    return res.count > 0;
  }

  /** Привязки заметки с заголовками — батчем по типам, чужие/исчезнувшие сущности отдаются заглушкой */
  async relatedOf(viewerId: string, noteIds: string[]): Promise<Map<string, NoteRelatedDto[]>> {
    const out = new Map<string, NoteRelatedDto[]>();
    if (!noteIds.length) return out;
    const links = await this.db.noteLink.findMany({
      where: { noteId: { in: noteIds }, kind: 'related' },
      orderBy: { createdAt: 'asc' },
    });
    // describe — по одной сущности; их ≤ maxRelated на заметку, а панель обычно про одну заметку.
    const cache = new Map<string, Promise<{ title: string; url: string | null } | null>>();
    for (const link of links) {
      const key = `${link.targetType}:${link.targetId}`;
      if (!cache.has(key)) {
        const resolver = this.targets.get(link.targetType);
        cache.set(
          key,
          resolver
            ? resolver
                .describe(viewerId, link.targetId)
                .then((d) => (d ? { title: d.title, url: d.url } : null))
                .catch(() => null)
            : Promise.resolve(null),
        );
      }
      const d = await cache.get(key)!;
      const list = out.get(link.noteId) ?? [];
      list.push({
        targetType: link.targetType as NoteRelatedTargetType,
        targetId: link.targetId,
        title: d?.title ?? 'Недоступно',
        url: d?.url ?? null,
      });
      out.set(link.noteId, list);
    }
    return out;
  }

  /** Заметки, привязанные к сущности (id без прав — права режет вызывающий по видимости) */
  async noteIdsByTarget(targetType: string, targetId: string): Promise<string[]> {
    const rows = await this.db.noteLink.findMany({
      where: { targetType, targetId, kind: 'related' },
      select: { noteId: true },
    });
    return rows.map((r) => r.noteId);
  }

  /** Пикер «Привязать к…»: кандидаты от модуля-цели, уже обрезанные его правами */
  async searchTargets(viewerId: string, scope: NoteScope, type: NoteRelatedTargetType, q: string | undefined): Promise<NoteTargetSearchItemDto[]> {
    const resolver = this.targets.get(type);
    if (!resolver) return [];
    const ctx = { workspaceId: scope.space.ownerType === 'workspace' ? scope.space.ownerId : null };
    return resolver.search(viewerId, ctx, (q ?? '').trim(), NOTE_LIMITS.pickerLimit);
  }
}
