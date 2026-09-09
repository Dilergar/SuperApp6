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
  @ApiOperation({ summary: 'The folder tree, the tags and the space counters' })
  async sidebar(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = noteSidebarQuerySchema.parse(query);
    const data: NoteSidebarDto = await this.notes.sidebar(user.sub, q);
    return { success: true, data };
  }

  @Post('folders')
  @ApiOperation({ summary: 'Create a folder' })
  async createFolder(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const dto = createNoteFolderSchema.parse(body);
    const scope = await this.acl.scopeFor(user.sub, { workspaceId: dto.workspaceId });
    const folder = await this.folders.create(scope, dto);
    const data: NoteFolderDto = this.folders.toDto(folder, 'manager', 0);
    return { success: true, data };
  }

  @Patch('folders/:folderId')
  @ApiOperation({ summary: 'Rename / recolor / move a folder' })
  async updateFolder(@CurrentUser() user: JwtPayload, @Param('folderId') folderId: string, @Body() body: unknown) {
    const dto = updateNoteFolderSchema.parse(body);
    const scope = await this.acl.scopeForSpaceId(user.sub, await this.spaceOfFolder(folderId));
    const folder = await this.folders.update(scope, folderId, dto);
    const data: NoteFolderDto = this.folders.toDto(folder, this.acl.folderAccess(scope, folder) ?? 'viewer', 0);
    return { success: true, data };
  }

  @Post('folders/:folderId/trash')
  @ApiOperation({ summary: 'The folder with its content — to the trash' })
  async trashFolder(@CurrentUser() user: JwtPayload, @Param('folderId') folderId: string) {
    const scope = await this.acl.scopeForSpaceId(user.sub, await this.spaceOfFolder(folderId));
    const data = await this.folders.trash(scope, folderId);
    return { success: true, data };
  }

  @Post('folders/:folderId/restore')
  @ApiOperation({ summary: 'Restore a folder from the trash' })
  async restoreFolder(@CurrentUser() user: JwtPayload, @Param('folderId') folderId: string) {
    const scope = await this.acl.scopeForSpaceId(user.sub, await this.spaceOfFolder(folderId));
    const data = await this.folders.restore(scope, folderId);
    return { success: true, data };
  }

  @Get('folders/:folderId/shares')
  @ApiOperation({ summary: 'Who the folder is open to (inherited included)' })
  async folderShares(@CurrentUser() user: JwtPayload, @Param('folderId') folderId: string) {
    const data: NoteShareDto[] = await this.share.listFolderShares(user.sub, folderId);
    return { success: true, data };
  }

  @Post('folders/:folderId/shares')
  @ApiOperation({ summary: 'Open the folder to a person / Group / department / position / site / the whole organization' })
  async shareFolder(@CurrentUser() user: JwtPayload, @Param('folderId') folderId: string, @Body() body: unknown) {
    const dto = noteShareSchema.parse(body);
    const data: NoteShareDto[] = await this.share.shareFolder(user.sub, folderId, dto);
    return { success: true, data };
  }

  @Delete('folders/:folderId/shares/:principalType/:principalId')
  @ApiOperation({ summary: 'Close the folder for a recipient' })
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
  @ApiOperation({ summary: 'The board of the selected section: its notes plus my layout' })
  async getBoard(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = noteBoardQuerySchema.parse(query);
    const data: NoteBoardDto = await this.board.board(user.sub, q);
    return { success: true, data };
  }

  @Put('board/:noteId')
  @ApiOperation({ summary: 'Remember the card position on my board' })
  async putBoard(@CurrentUser() user: JwtPayload, @Param('noteId') noteId: string, @Body() body: unknown) {
    const dto = noteBoardPutSchema.parse(body ?? {});
    const data: NoteBoardItemDto = await this.board.put(user.sub, noteId, dto);
    return { success: true, data };
  }

  // ============================================================
  // Кандидаты пикеров и панели сущностей
  // ============================================================

  @Get('wikilink-candidates')
  @ApiOperation({ summary: 'Candidates for a [[wikilink]]' })
  async wikilinkCandidates(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = noteWikilinkCandidatesQuerySchema.parse(query);
    const scope = await this.acl.scopeFor(user.sub, { workspaceId: q.workspaceId });
    const data: NoteWikilinkCandidateDto[] = await this.links.wikilinkCandidates(scope, q.q, q.exclude);
    return { success: true, data };
  }

  @Get('targets/search')
  @ApiOperation({ summary: 'The “Link to…” picker: tasks / counterparties / sites / documents' })
  async searchTargets(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = noteTargetSearchQuerySchema.parse(query);
    const scope = await this.acl.scopeFor(user.sub, { workspaceId: q.workspaceId });
    const data: NoteTargetSearchItemDto[] = await this.links.searchTargets(user.sub, scope, q.type, q.q);
    return { success: true, data };
  }

  @Get('by-target/:targetType/:targetId')
  @ApiOperation({ summary: 'The notes linked to an entity (the panel on its card)' })
  async byTarget(@CurrentUser() user: JwtPayload, @Param('targetType') targetType: string, @Param('targetId') targetId: string) {
    const data: NotesByTargetDto = await this.notes.listByTarget(user.sub, targetType, targetId);
    return { success: true, data };
  }

  // ============================================================
  // Заметки
  // ============================================================

  @Get()
  @ApiOperation({ summary: 'The notes of a space (folder / tag / search / trash; keyset)' })
  async list(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = noteListQuerySchema.parse(query);
    const data: CursorPage<NoteListItemDto> = await this.notes.list(user.sub, q);
    return { success: true, data };
  }

  @Post()
  @ApiOperation({ summary: 'Create a note (as a document or as Markdown)' })
  async create(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const dto = createNoteSchema.parse(body);
    const data: NoteDetailDto = await this.notes.create(user.sub, dto);
    return { success: true, data };
  }

  @Get(':id')
  @ApiOperation({ summary: 'The note card' })
  async get(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data: NoteDetailDto = await this.notes.get(user.sub, id);
    return { success: true, data };
  }

  @Get(':id/markdown')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  @ApiOperation({ summary: 'The note as Markdown (export / AI reading)' })
  async markdown(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<string> {
    const { note } = await this.notes.requireNote(user.sub, id, 'viewer');
    return note.contentMd;
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Save the note (optimistic version; 409 on a conflict)' })
  async update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
    const dto = updateNoteSchema.parse(body);
    const data: NoteSaveResultDto = await this.notes.update(user.sub, id, dto);
    return { success: true, data };
  }

  @Post(':id/trash')
  @ApiOperation({ summary: 'To the trash' })
  async trash(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.notes.trash(user.sub, id);
    return { success: true, data: { ok: true } };
  }

  @Post(':id/restore')
  @ApiOperation({ summary: 'Restore from the trash' })
  async restore(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data: NoteDetailDto = await this.notes.restore(user.sub, id);
    return { success: true, data };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete for good (from the trash only)' })
  async purge(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.notes.purge(user.sub, id);
    return { success: true, data: { ok: true } };
  }

  // ---- история версий

  @Get(':id/revisions')
  @ApiOperation({ summary: 'The note version history (the saved snapshots)' })
  async revisions(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data: NoteRevisionDto[] = await this.notes.revisions(user.sub, id);
    return { success: true, data };
  }

  @Get(':id/revisions/:version')
  @ApiOperation({ summary: 'The content of a version (a preview before the rollback)' })
  async revision(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('version') version: string) {
    const data: NoteDoc = await this.notes.revision(user.sub, id, noteVersionParam.parse(version));
    return { success: true, data };
  }

  @Post(':id/revisions/:version/restore')
  @ApiOperation({ summary: 'Roll the note back to a version (as a new version; the history is not rewritten)' })
  async restoreRevision(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('version') version: string) {
    const data: NoteSaveResultDto = await this.notes.restoreRevision(user.sub, id, noteVersionParam.parse(version));
    return { success: true, data };
  }

  // ---- доступ

  @Get(':id/shares')
  @ApiOperation({ summary: 'Who the note is open to (folder-inherited included)' })
  async shares(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data: NoteShareDto[] = await this.share.listNoteShares(user.sub, id);
    return { success: true, data };
  }

  @Post(':id/shares')
  @ApiOperation({ summary: 'Share the note' })
  async shareNote(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
    const dto = noteShareSchema.parse(body);
    const data: NoteShareDto[] = await this.share.shareNote(user.sub, id, dto);
    return { success: true, data };
  }

  @Post(':id/shares/mentioned')
  @ApiOperation({ summary: 'Grant “reads” to every mentioned person without access' })
  async shareMentioned(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data: NoteShareDto[] = await this.share.shareWithMentioned(user.sub, id);
    return { success: true, data };
  }

  @Delete(':id/shares/:principalType/:principalId')
  @ApiOperation({ summary: 'Close the access for a recipient' })
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
  @ApiOperation({ summary: 'Link the note to a task / counterparty / site / document' })
  async addRelated(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
    const dto = noteRelatedRefSchema.parse(body);
    const data: NoteDetailDto = await this.notes.addRelated(user.sub, id, dto.targetType, dto.targetId);
    return { success: true, data };
  }

  @Delete(':id/related/:targetType/:targetId')
  @ApiOperation({ summary: 'Unlink the note from an entity' })
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
