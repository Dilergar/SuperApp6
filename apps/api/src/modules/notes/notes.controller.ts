import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createNoteFolderSchema,
  createNoteSchema,
  noteBoardPutSchema,
  noteBoardQuerySchema,
  noteListQuerySchema,
  noteRelatedRefSchema,
  noteShareSchema,
  noteSidebarQuerySchema,
  noteTargetSearchQuerySchema,
  noteVersionParam,
  noteWikilinkCandidatesQuerySchema,
  updateNoteFolderSchema,
  updateNoteSchema,
  type NoteBoardDto,
  type NoteBoardItemDto,
  type NoteDetailDto,
  type NoteDoc,
  type NoteFolderDto,
  type NoteListItemDto,
  type NoteRevisionDto,
  type NoteSaveResultDto,
  type NoteShareDto,
  type NoteSidebarDto,
  type NoteTargetSearchItemDto,
  type NoteWikilinkCandidateDto,
  type NotesByTargetDto,
  type CursorPage,
} from '@superapp/shared';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { NotesAccessService } from './notes-access.service';
import { NotesBoardService } from './notes-board.service';
import { NotesFoldersService } from './notes-folders.service';
import { NotesLinksService } from './notes-links.service';
import { NotesShareService } from './notes-share.service';
import { NotesService } from './notes.service';

/**
 * Заметки — тонкий контроллер: Zod-разбор → сервис (AI-ready). Пространство адресуется
 * `?workspaceId=` (организация) или ничем (личное) — модель Диска. Статические пути
 * объявлены ДО `:id` (иначе Nest ищет заметку «folders»/«board»).
 */
@ApiTags('notes')
@Controller('notes')
export class NotesController {
  constructor(
    private readonly notes: NotesService,
    private readonly folders: NotesFoldersService,
    private readonly acl: NotesAccessService,
    private readonly share: NotesShareService,
    private readonly board: NotesBoardService,
    private readonly links: NotesLinksService,
  ) {}

  // ============================================================
  // Левая панель и папки
  // ============================================================

  @Get('sidebar')
  @ApiOperation({ summary: 'Дерево папок, теги, счётчики пространства' })
  async sidebar(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = noteSidebarQuerySchema.parse(query);
    const data: NoteSidebarDto = await this.notes.sidebar(user.sub, q);
    return { success: true, data };
  }

  @Post('folders')
  @ApiOperation({ summary: 'Создать папку' })
  async createFolder(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const dto = createNoteFolderSchema.parse(body);
    const scope = await this.acl.scopeFor(user.sub, { workspaceId: dto.workspaceId });
    const folder = await this.folders.create(scope, dto);
    const data: NoteFolderDto = this.folders.toDto(folder, 'manager', 0);
    return { success: true, data };
  }

  @Patch('folders/:folderId')
  @ApiOperation({ summary: 'Переименовать / перекрасить / перенести папку' })
  async updateFolder(@CurrentUser() user: JwtPayload, @Param('folderId') folderId: string, @Body() body: unknown) {
    const dto = updateNoteFolderSchema.parse(body);
    const scope = await this.acl.scopeForSpaceId(user.sub, await this.spaceOfFolder(folderId));
    const folder = await this.folders.update(scope, folderId, dto);
    const data: NoteFolderDto = this.folders.toDto(folder, this.acl.folderAccess(scope, folder) ?? 'viewer', 0);
    return { success: true, data };
  }

  @Post('folders/:folderId/trash')
  @ApiOperation({ summary: 'Папку с содержимым — в корзину' })
  async trashFolder(@CurrentUser() user: JwtPayload, @Param('folderId') folderId: string) {
    const scope = await this.acl.scopeForSpaceId(user.sub, await this.spaceOfFolder(folderId));
    const data = await this.folders.trash(scope, folderId);
    return { success: true, data };
  }

  @Post('folders/:folderId/restore')
  @ApiOperation({ summary: 'Восстановить папку из корзины' })
  async restoreFolder(@CurrentUser() user: JwtPayload, @Param('folderId') folderId: string) {
    const scope = await this.acl.scopeForSpaceId(user.sub, await this.spaceOfFolder(folderId));
    const data = await this.folders.restore(scope, folderId);
    return { success: true, data };
  }

  @Get('folders/:folderId/shares')
  @ApiOperation({ summary: 'Кому открыта папка (с унаследованными)' })
  async folderShares(@CurrentUser() user: JwtPayload, @Param('folderId') folderId: string) {
    const data: NoteShareDto[] = await this.share.listFolderShares(user.sub, folderId);
    return { success: true, data };
  }

  @Post('folders/:folderId/shares')
  @ApiOperation({ summary: 'Открыть папку человеку / Группе / отделу / должности / объекту / всей организации' })
  async shareFolder(@CurrentUser() user: JwtPayload, @Param('folderId') folderId: string, @Body() body: unknown) {
    const dto = noteShareSchema.parse(body);
    const data: NoteShareDto[] = await this.share.shareFolder(user.sub, folderId, dto);
    return { success: true, data };
  }

  @Delete('folders/:folderId/shares/:principalType/:principalId')
  @ApiOperation({ summary: 'Закрыть папку получателю' })
  async unshareFolder(
    @CurrentUser() user: JwtPayload,
    @Param('folderId') folderId: string,
    @Param('principalType') principalType: string,
    @Param('principalId') principalId: string,
  ) {
    const data: NoteShareDto[] = await this.share.unshareFolder(user.sub, folderId, principalType, principalId);
    return { success: true, data };
  }

  // ============================================================
  // Доска стикеров
  // ============================================================

  @Get('board')
  @ApiOperation({ summary: 'Доска выбранного раздела: его заметки + моя раскладка' })
  async getBoard(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = noteBoardQuerySchema.parse(query);
    const data: NoteBoardDto = await this.board.board(user.sub, q);
    return { success: true, data };
  }

  @Put('board/:noteId')
  @ApiOperation({ summary: 'Запомнить положение карточки на моей доске' })
  async putBoard(@CurrentUser() user: JwtPayload, @Param('noteId') noteId: string, @Body() body: unknown) {
    const dto = noteBoardPutSchema.parse(body ?? {});
    const data: NoteBoardItemDto = await this.board.put(user.sub, noteId, dto);
    return { success: true, data };
  }

  // ============================================================
  // Кандидаты пикеров и панели сущностей
  // ============================================================

  @Get('wikilink-candidates')
  @ApiOperation({ summary: 'Кандидаты для [[вики-ссылки]]' })
  async wikilinkCandidates(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = noteWikilinkCandidatesQuerySchema.parse(query);
    const scope = await this.acl.scopeFor(user.sub, { workspaceId: q.workspaceId });
    const data: NoteWikilinkCandidateDto[] = await this.links.wikilinkCandidates(scope, q.q, q.exclude);
    return { success: true, data };
  }

  @Get('targets/search')
  @ApiOperation({ summary: 'Пикер «Привязать к…»: задачи / контрагенты / объекты / документы' })
  async searchTargets(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = noteTargetSearchQuerySchema.parse(query);
    const scope = await this.acl.scopeFor(user.sub, { workspaceId: q.workspaceId });
    const data: NoteTargetSearchItemDto[] = await this.links.searchTargets(user.sub, scope, q.type, q.q);
    return { success: true, data };
  }

  @Get('by-target/:targetType/:targetId')
  @ApiOperation({ summary: 'Заметки, привязанные к сущности (панель на карточке)' })
  async byTarget(@CurrentUser() user: JwtPayload, @Param('targetType') targetType: string, @Param('targetId') targetId: string) {
    const data: NotesByTargetDto = await this.notes.listByTarget(user.sub, targetType, targetId);
    return { success: true, data };
  }

  // ============================================================
  // Заметки
  // ============================================================

  @Get()
  @ApiOperation({ summary: 'Список заметок пространства (папка / тег / поиск / корзина; keyset)' })
  async list(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = noteListQuerySchema.parse(query);
    const data: CursorPage<NoteListItemDto> = await this.notes.list(user.sub, q);
    return { success: true, data };
  }

  @Post()
  @ApiOperation({ summary: 'Создать заметку (документом или Markdown)' })
  async create(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const dto = createNoteSchema.parse(body);
    const data: NoteDetailDto = await this.notes.create(user.sub, dto);
    return { success: true, data };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Карточка заметки' })
  async get(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data: NoteDetailDto = await this.notes.get(user.sub, id);
    return { success: true, data };
  }

  @Get(':id/markdown')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  @ApiOperation({ summary: 'Заметка как Markdown (экспорт / ИИ-чтение)' })
  async markdown(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<string> {
    const { note } = await this.notes.requireNote(user.sub, id, 'viewer');
    return note.contentMd;
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Сохранить заметку (оптимистическая версия; 409 при конфликте)' })
  async update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
    const dto = updateNoteSchema.parse(body);
    const data: NoteSaveResultDto = await this.notes.update(user.sub, id, dto);
    return { success: true, data };
  }

  @Post(':id/trash')
  @ApiOperation({ summary: 'В корзину' })
  async trash(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.notes.trash(user.sub, id);
    return { success: true, data: { ok: true } };
  }

  @Post(':id/restore')
  @ApiOperation({ summary: 'Восстановить из корзины' })
  async restore(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data: NoteDetailDto = await this.notes.restore(user.sub, id);
    return { success: true, data };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Удалить навсегда (только из корзины)' })
  async purge(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.notes.purge(user.sub, id);
    return { success: true, data: { ok: true } };
  }

  // ---- история версий

  @Get(':id/revisions')
  @ApiOperation({ summary: 'История версий заметки (снимки сохранений)' })
  async revisions(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data: NoteRevisionDto[] = await this.notes.revisions(user.sub, id);
    return { success: true, data };
  }

  @Get(':id/revisions/:version')
  @ApiOperation({ summary: 'Содержимое версии (предпросмотр перед откатом)' })
  async revision(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('version') version: string) {
    const data: NoteDoc = await this.notes.revision(user.sub, id, noteVersionParam.parse(version));
    return { success: true, data };
  }

  @Post(':id/revisions/:version/restore')
  @ApiOperation({ summary: 'Откатить заметку к версии (новой версией, история не переписывается)' })
  async restoreRevision(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('version') version: string) {
    const data: NoteSaveResultDto = await this.notes.restoreRevision(user.sub, id, noteVersionParam.parse(version));
    return { success: true, data };
  }

  // ---- доступ

  @Get(':id/shares')
  @ApiOperation({ summary: 'Кому открыта заметка (с унаследованными от папок)' })
  async shares(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data: NoteShareDto[] = await this.share.listNoteShares(user.sub, id);
    return { success: true, data };
  }

  @Post(':id/shares')
  @ApiOperation({ summary: 'Поделиться заметкой' })
  async shareNote(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
    const dto = noteShareSchema.parse(body);
    const data: NoteShareDto[] = await this.share.shareNote(user.sub, id, dto);
    return { success: true, data };
  }

  @Post(':id/shares/mentioned')
  @ApiOperation({ summary: 'Дать «читать» всем упомянутым без доступа' })
  async shareMentioned(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data: NoteShareDto[] = await this.share.shareWithMentioned(user.sub, id);
    return { success: true, data };
  }

  @Delete(':id/shares/:principalType/:principalId')
  @ApiOperation({ summary: 'Закрыть доступ получателю' })
  async unshareNote(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('principalType') principalType: string,
    @Param('principalId') principalId: string,
  ) {
    const data: NoteShareDto[] = await this.share.unshareNote(user.sub, id, principalType, principalId);
    return { success: true, data };
  }

  // ---- привязки

  @Post(':id/related')
  @ApiOperation({ summary: 'Привязать заметку к задаче / контрагенту / объекту / документу' })
  async addRelated(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
    const dto = noteRelatedRefSchema.parse(body);
    const data: NoteDetailDto = await this.notes.addRelated(user.sub, id, dto.targetType, dto.targetId);
    return { success: true, data };
  }

  @Delete(':id/related/:targetType/:targetId')
  @ApiOperation({ summary: 'Отвязать заметку от сущности' })
  async removeRelated(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('targetType') targetType: string,
    @Param('targetId') targetId: string,
  ) {
    const data: NoteDetailDto = await this.notes.removeRelated(user.sub, id, targetType, targetId);
    return { success: true, data };
  }

  private async spaceOfFolder(folderId: string): Promise<string> {
    return this.folders.spaceIdOf(folderId);
  }
}
