import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  NOTE_FOLDER_REF_TYPE,
  NOTE_REF_TYPE,
  NOTE_ROLES,
  WORKSPACE_ROLE_RANK,
  extractNoteMentions,
  type AudienceKind,
  type NoteDoc,
  type NoteRole,
  type NoteShareDto,
  type NoteShareInput,
} from '@superapp/shared';
import { AudiencesService } from '../../core/audiences/audiences.service';
import { DatabaseService } from '../../shared/database/database.service';
import { fullName } from '../../shared/utils/user-name';
import { ContactsService } from '../contacts/contacts.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotesAccessService, type NoteScope } from './notes-access.service';
import { noteUrl } from './notes-dto';
import { NotesFoldersService } from './notes-folders.service';
import { NotesService } from './notes.service';

const ROLE_LABEL: Record<NoteRole, string> = {
  viewer: 'читает',
  editor: 'правит',
  manager: 'управляет доступом',
};

type RefType = typeof NOTE_REF_TYPE | typeof NOTE_FOLDER_REF_TYPE;

/**
 * Шеринг заметок и папок. Грант — ОДНА строка в core/access на самой заметке или папке;
 * наследование вглубь бесплатно (предикат по folderPath), поэтому «открыть папку
 * отделу» — одна запись. Кому можно выдавать — те же правила, что у Диска: на личных
 * заметках — человек из окружения и СВОЯ Группа; в организации — её сотрудник и её оси.
 */
@Injectable()
export class NotesShareService {
  private readonly logger = new Logger(NotesShareService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly acl: NotesAccessService,
    private readonly notes: NotesService,
    private readonly folders: NotesFoldersService,
    private readonly contacts: ContactsService,
    private readonly notifications: NotificationsService,
    private readonly audiences: AudiencesService,
  ) {}

  // ============================================================
  // Чтение
  // ============================================================

  /** Гранты на заметке и на всех папках её пути (унаследованные — с пометкой) */
  async listNoteShares(userId: string, noteId: string): Promise<NoteShareDto[]> {
    const { note } = await this.notes.requireNote(userId, noteId, 'viewer');
    const [own, inherited] = await Promise.all([
      this.acl.listGrants(NOTE_REF_TYPE, [note.id]),
      this.acl.listGrants(NOTE_FOLDER_REF_TYPE, note.folderPath),
    ]);
    const folderNames = await this.folderNames(note.folderPath);
    const refs = [
      ...own.map((t) => ({ ...t, refType: NOTE_REF_TYPE as RefType, refName: this.notes.displayTitle(note), inherited: false })),
      ...inherited.map((t) => ({ ...t, refType: NOTE_FOLDER_REF_TYPE as RefType, refName: folderNames.get(t.resourceId) ?? '', inherited: true })),
    ];
    return this.decorate(refs);
  }

  async listFolderShares(userId: string, folderId: string): Promise<NoteShareDto[]> {
    const scope = await this.scopeOfFolder(userId, folderId);
    const { folder } = await this.folders.requireFolder(scope, folderId, 'viewer');
    const chain = [folder.id, ...folder.ancestorIds];
    const tuples = await this.acl.listGrants(NOTE_FOLDER_REF_TYPE, chain);
    const names = await this.folderNames(chain);
    return this.decorate(
      tuples.map((t) => ({ ...t, refType: NOTE_FOLDER_REF_TYPE as RefType, refName: names.get(t.resourceId) ?? '', inherited: t.resourceId !== folder.id })),
    );
  }

  private async decorate(
    rows: Array<{ resourceId: string; relation: string; subjectType: string; subjectId: string; refType: RefType; refName: string; inherited: boolean }>,
  ): Promise<NoteShareDto[]> {
    const labels = await this.principalLabels(rows.map((r) => ({ type: r.subjectType, id: r.subjectId })));
    return rows.map((r) => ({
      principalType: r.subjectType as NoteShareDto['principalType'],
      principalId: r.subjectId,
      principalName: labels.get(`${r.subjectType}:${r.subjectId}`) ?? r.subjectType,
      role: r.relation as NoteRole,
      refType: r.refType,
      refId: r.resourceId,
      refName: r.refName,
      inherited: r.inherited,
    }));
  }

  private async folderNames(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await this.db.noteFolder.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async principalLabels(refs: Array<{ type: string; id: string }>): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!refs.length) return out;
    const uniq = [...new Map(refs.map((r) => [`${r.type}:${r.id}`, r])).values()];
    const labels = await this.audiences.labelMany(
      uniq.map((r) => ({ type: r.type as AudienceKind, id: r.id })),
      { workspaceId: null },
    );
    for (const l of labels) out.set(`${l.type}:${l.id}`, l.label);
    return out;
  }

  // ============================================================
  // Запись
  // ============================================================

  async shareNote(userId: string, noteId: string, input: NoteShareInput): Promise<NoteShareDto[]> {
    const { note, scope } = await this.notes.requireNote(userId, noteId, 'manager');
    await this.assertPrincipalAllowed(userId, scope, input);
    const label = await this.principalLabel(input.principalType, input.principalId);
    await this.db.$transaction(async (tx) => {
      await this.acl.grant(NOTE_REF_TYPE, noteId, input.role, { type: input.principalType, id: input.principalId }, tx);
      await this.notes.log(tx, scope, noteId, 'note.shared', {
        targetName: this.notes.displayTitle(note),
        principalLabel: label,
        roleLabel: ROLE_LABEL[input.role],
      });
    });
    await this.notifyRecipient(scope, userId, input, this.notes.displayTitle(note), noteUrl(scope.space, noteId));
    return this.listNoteShares(userId, noteId);
  }

  async unshareNote(userId: string, noteId: string, principalType: string, principalId: string): Promise<NoteShareDto[]> {
    const { note, scope } = await this.notes.requireNote(userId, noteId, 'manager');
    const label = await this.principalLabel(principalType, principalId);
    await this.db.$transaction(async (tx) => {
      for (const role of NOTE_ROLES) {
        await this.acl.revoke(NOTE_REF_TYPE, noteId, role, { type: principalType, id: principalId }, tx);
      }
      await this.notes.log(tx, scope, noteId, 'note.unshared', { targetName: this.notes.displayTitle(note), principalLabel: label });
    });
    return this.listNoteShares(userId, noteId);
  }

  async shareFolder(userId: string, folderId: string, input: NoteShareInput): Promise<NoteShareDto[]> {
    const scope = await this.scopeOfFolder(userId, folderId);
    const { folder } = await this.folders.requireFolder(scope, folderId, 'manager');
    await this.assertPrincipalAllowed(userId, scope, input);
    const label = await this.principalLabel(input.principalType, input.principalId);
    await this.db.$transaction(async (tx) => {
      await this.acl.grant(NOTE_FOLDER_REF_TYPE, folderId, input.role, { type: input.principalType, id: input.principalId }, tx);
      // Открытая папка отдаёт доступ ко ВСЕМУ поддереву — это событие для хроники
      await this.folders.log(tx, scope, folderId, 'note.folder.shared', {
        targetName: folder.name,
        principalLabel: label,
        roleLabel: ROLE_LABEL[input.role],
      });
    });
    const url = scope.space.ownerType === 'workspace' ? `/workspaces/${scope.space.ownerId}/notes?folder=${folderId}` : `/notes?folder=${folderId}`;
    await this.notifyRecipient(scope, userId, input, folder.name, url);
    return this.listFolderShares(userId, folderId);
  }

  async unshareFolder(userId: string, folderId: string, principalType: string, principalId: string): Promise<NoteShareDto[]> {
    const scope = await this.scopeOfFolder(userId, folderId);
    const { folder } = await this.folders.requireFolder(scope, folderId, 'manager');
    const label = await this.principalLabel(principalType, principalId);
    await this.db.$transaction(async (tx) => {
      for (const role of NOTE_ROLES) {
        await this.acl.revoke(NOTE_FOLDER_REF_TYPE, folderId, role, { type: principalType, id: principalId }, tx);
      }
      await this.folders.log(tx, scope, folderId, 'note.folder.unshared', { targetName: folder.name, principalLabel: label });
    });
    return this.listFolderShares(userId, folderId);
  }

  /** Подсказка редактора: выдать «читать» всем упомянутым, кто заметку не видит */
  async shareWithMentioned(userId: string, noteId: string): Promise<NoteShareDto[]> {
    const { note, scope } = await this.notes.requireNote(userId, noteId, 'manager');
    const mentioned = extractNoteMentions(note.content as unknown as NoteDoc).filter((m) => m.userId !== userId);
    for (const m of mentioned) {
      if (await this.notes.canUserView(m.userId, note)) continue;
      try {
        await this.assertPrincipalAllowed(userId, scope, { principalType: 'user', principalId: m.userId });
      } catch {
        continue; // упомянут человек вне окружения/организации — молча пропускаем
      }
      await this.acl.grant(NOTE_REF_TYPE, noteId, 'viewer', { type: 'user', id: m.userId });
      await this.notifyRecipient(scope, userId, { principalType: 'user', principalId: m.userId, role: 'viewer' }, this.notes.displayTitle(note), noteUrl(scope.space, noteId));
    }
    return this.listNoteShares(userId, noteId);
  }

  /**
   * Связь между людьми разорвана — снимаем ЛИЧНЫЕ гранты в обе стороны в личных
   * пространствах (групповые рёбра умирают вместе с членством). Идемпотентно.
   */
  async revokeBetween(userAId: string, userBId: string): Promise<void> {
    for (const [owner, other] of [
      [userAId, userBId],
      [userBId, userAId],
    ]) {
      const space = await this.db.noteSpace.findUnique({ where: { ownerType_ownerId: { ownerType: 'user', ownerId: owner } }, select: { id: true } });
      if (!space) continue;
      // Идём ОТ грантов, а не от заметок: их единицы, а заметок в пространстве могут
      // быть десятки тысяч — грузить всё пространство в память ради разрыва связи ни к чему.
      const tuples = await this.db.relationTuple.findMany({
        where: { subjectType: 'user', subjectId: other, resourceType: { in: [NOTE_REF_TYPE, NOTE_FOLDER_REF_TYPE] } },
        select: { id: true, resourceType: true, resourceId: true },
      });
      if (!tuples.length) continue;
      const noteIds = tuples.filter((t) => t.resourceType === NOTE_REF_TYPE).map((t) => t.resourceId);
      const folderIds = tuples.filter((t) => t.resourceType === NOTE_FOLDER_REF_TYPE).map((t) => t.resourceId);
      const [notesHere, foldersHere] = await Promise.all([
        noteIds.length ? this.db.note.findMany({ where: { id: { in: noteIds }, spaceId: space.id }, select: { id: true } }) : [],
        folderIds.length ? this.db.noteFolder.findMany({ where: { id: { in: folderIds }, spaceId: space.id }, select: { id: true } }) : [],
      ]);
      const mine = new Set([...notesHere.map((n) => n.id), ...foldersHere.map((f) => f.id)]);
      const doomed = tuples.filter((t) => mine.has(t.resourceId));
      if (!doomed.length) continue;
      await this.db.relationTuple.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } });
      this.logger.log(`отозвано ${doomed.length} грантов Заметок между ${owner} и ${other}`);
    }
  }

  // ============================================================
  // Кому можно выдавать доступ (правила Диска, один в один)
  // ============================================================

  private async assertPrincipalAllowed(userId: string, scope: NoteScope, input: { principalType: string; principalId: string }): Promise<void> {
    const personal = scope.space.ownerType === 'user';
    switch (input.principalType) {
      case 'user': {
        if (input.principalId === userId) throw new BadRequestException('Себе доступ выдавать не нужно');
        if (personal) {
          await this.contacts.assertReachable(userId, [input.principalId], 'Открыть доступ можно только человеку из вашего окружения', {
            personalOnly: true,
          });
        } else {
          const rank = await this.acl.workspaceRank(input.principalId, scope.space.ownerId);
          if (rank < WORKSPACE_ROLE_RANK.trainee) throw new BadRequestException('Этот человек не состоит в организации');
        }
        return;
      }
      case 'circle': {
        if (!personal) throw new BadRequestException('В организации доступ выдаётся её сотрудникам, отделам, должностям и объектам');
        const circle = await this.db.circle.findUnique({ where: { id: input.principalId }, select: { ownerId: true } });
        if (!circle || circle.ownerId !== userId) throw new BadRequestException('Такой Группы у вас нет');
        return;
      }
      case 'workspace': {
        if (personal || input.principalId !== scope.space.ownerId) {
          throw new BadRequestException('Открыть доступ всей команде можно только в заметках этой организации');
        }
        return;
      }
      case 'department':
      case 'position':
      case 'branch': {
        if (personal) throw new BadRequestException('Отделы, должности и объекты бывают только у организации');
        const owner = await this.staffOwnerWorkspace(input.principalType, input.principalId);
        if (owner !== scope.space.ownerId) throw new BadRequestException('Этот справочник принадлежит другой организации');
        return;
      }
      default:
        throw new BadRequestException('Неизвестный тип получателя доступа');
    }
  }

  private async staffOwnerWorkspace(type: string, id: string): Promise<string | null> {
    const row =
      type === 'department'
        ? await this.db.staffDepartment.findUnique({ where: { id }, select: { workspaceId: true } })
        : type === 'position'
          ? await this.db.staffPosition.findUnique({ where: { id }, select: { workspaceId: true } })
          : await this.db.staffBranch.findUnique({ where: { id }, select: { workspaceId: true } });
    return row?.workspaceId ?? null;
  }

  // ============================================================
  // Служебное
  // ============================================================

  private async scopeOfFolder(userId: string, folderId: string): Promise<NoteScope> {
    const folder = await this.db.noteFolder.findUnique({ where: { id: folderId }, select: { spaceId: true } });
    if (!folder) throw new BadRequestException('Папка не найдена');
    return this.acl.scopeForSpaceId(userId, folder.spaceId);
  }

  private async notifyRecipient(scope: NoteScope, actorId: string, input: { principalType: string; principalId: string; role: NoteRole }, name: string, url: string): Promise<void> {
    // Адресно — только человеку: рассылка «всему отделу» о каждой папке стала бы шумом.
    if (input.principalType !== 'user') return;
    const actor = await this.db.user.findUnique({ where: { id: actorId }, select: { firstName: true, lastName: true } });
    await this.notifications
      .notify(input.principalId, 'note.shared', { ownerName: fullName(actor), noteName: name, roleLabel: ROLE_LABEL[input.role] }, { actionUrl: url })
      .catch(() => undefined);
  }

  private async principalLabel(type: string, id: string): Promise<string> {
    return this.audiences.label({ type: type as AudienceKind, id }, { workspaceId: null });
  }
}
