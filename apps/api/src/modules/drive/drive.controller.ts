import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  driveCopySchema,
  driveFolderCreateSchema,
  driveIdsSchema,
  driveListQuerySchema,
  driveMoveSchema,
  driveNodeCreateSchema,
  driveNodeUpdateSchema,
  driveOverviewQuerySchema,
  drivePhotoBucketsQuerySchema,
  drivePhotoQuerySchema,
  driveShareSchema,
  driveTrashQuerySchema,
  type DriveListPageDto,
  type DriveNodeDetailDto,
} from '@superapp/shared';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { DrivePhotosService } from './drive-photos.service';
import { DriveService } from './drive.service';
import { DriveShareService } from './drive-share.service';
import { DriveTreeService } from './drive-tree.service';
import { DriveVersionsService } from './drive-versions.service';

/**
 * Диск — тонкий контроллер (Zod → сервис). Каждая операция вызываема программно,
 * то есть это же будущие AI-инструменты сервиса (Принцип 4).
 */
@ApiTags('Drive')
@ApiBearerAuth()
@Controller('drive')
export class DriveController {
  constructor(
    private readonly drive: DriveService,
    private readonly tree: DriveTreeService,
    private readonly shares_: DriveShareService,
    private readonly versions_: DriveVersionsService,
    private readonly photos: DrivePhotosService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Drive: the space, other drives shared with me, space used' })
  async overview(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = driveOverviewQuerySchema.parse(query);
    const data = await this.drive.overview(user.sub, q);
    return { success: true, data };
  }

  @Get('nodes')
  @ApiOperation({ summary: 'Folder contents (keyset; folders first)' })
  async list(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = driveListQuerySchema.parse(query);
    // DriveListPageDto наконец стоит на ОБЕИХ сторонах провода: он и был web-only
    // ровно потому, что контроллер разбирал страницу сервиса здесь.
    return { success: true, data: await this.drive.listNodes(user.sub, q) };
  }

  @Get('trash')
  @ApiOperation({ summary: 'Trash (explicitly deleted items only)' })
  async trashList(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = driveTrashQuerySchema.parse(query);
    const { items, nextCursor } = await this.tree.listTrash(user.sub, q, q);
    const page: DriveListPageDto = {
      items: await this.drive.serializeNodes(user.sub, items),
      nextCursor,
    };
    return { success: true, data: page };
  }

  @Get('nodes/:id')
  @ApiOperation({ summary: 'Item: path, viewer rights, where else the file is used' })
  async detail(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const { node, access } = await this.drive.requireNode(user.sub, id);
    const space = await this.drive.loadSpace(node.spaceId);
    // Открытие объекта — единственный сигнал «недавнего», который у нас есть; без него
    // раздел «Недавние» в сайдбаре был пуст всегда (ни одной строки в таблице).
    // Отметка не должна мешать выдаче, поэтому она best-effort внутри самого метода.
    await this.drive.touchRecent(user.sub, node.id);
    const [dto] = await this.drive.serializeNodes(user.sub, [node]);
    const data: DriveNodeDetailDto = {
      node: dto,
      breadcrumbs: await this.drive.breadcrumbs(node),
      space: await this.drive.serializeSpace(space, await this.drive.spaceAccessOf(user.sub, space)),
      access,
      usedElsewhere: await this.drive.usedElsewhere(node.fileId),
    };
    return { success: true, data };
  }

  @Post('folders')
  @ApiOperation({ summary: 'Create a folder' })
  async createFolder(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = driveFolderCreateSchema.parse(body);
    const data = await this.drive.createFolder(user.sub, dto);
    return { success: true, data };
  }

  @Post('nodes')
  @ApiOperation({ summary: 'Put an already uploaded file on the Drive (the engine takes the bytes itself)' })
  async attach(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = driveNodeCreateSchema.parse(body);
    const data = await this.drive.attachFile(user.sub, dto);
    return { success: true, data };
  }

  @Patch('nodes/:id')
  @ApiOperation({ summary: 'Rename' })
  async rename(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const { name } = driveNodeUpdateSchema.parse(body);
    const data = await this.drive.rename(user.sub, id, name);
    return { success: true, data };
  }

  @Post('nodes/move')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move to another folder of the same drive' })
  async move(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = driveMoveSchema.parse(body);
    const moved = await this.tree.move(user.sub, dto.ids, dto.parentId);
    return { success: true, data: { moved } };
  }

  @Post('nodes/trash')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'To the trash (the file stays alive: a chat attachment keeps working)' })
  async trash(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = driveIdsSchema.parse(body);
    const trashed = await this.tree.trash(user.sub, dto.ids);
    return { success: true, data: { trashed } };
  }

  @Post('nodes/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore from the trash' })
  async restore(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = driveIdsSchema.parse(body);
    const restored = await this.tree.restore(user.sub, dto.ids);
    return { success: true, data: { restored } };
  }

  @Delete('nodes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete for good (the file dies everywhere, chat attachments included)' })
  async purge(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = driveIdsSchema.parse(body);
    const purged = await this.tree.purge(user.sub, dto.ids);
    return { success: true, data: { purged } };
  }

  @Post('nodes/:id/star')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add to starred' })
  async star(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.drive.setStar(user.sub, id, true);
    return { success: true, data: { starred: true } };
  }

  @Delete('nodes/:id/star')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove from starred' })
  async unstar(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.drive.setStar(user.sub, id, false);
    return { success: true, data: { starred: false } };
  }

  @Post('nodes/copy')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Copy (to another drive too; the original stays)' })
  async copy(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = driveCopySchema.parse(body);
    const data = await this.tree.copy(user.sub, dto.ids, dto);
    return { success: true, data };
  }

  // ---- Доступ ----

  @Get('nodes/:id/shares')
  @ApiOperation({ summary: 'Who has access (inherited from ancestor folders included)' })
  async shares(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.shares_.listShares(user.sub, id);
    return { success: true, data };
  }

  @Post('nodes/:id/shares')
  @ApiOperation({ summary: 'Give access to a person, Group, department, position or site' })
  async share(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const dto = driveShareSchema.parse(body);
    const data = await this.shares_.share(user.sub, id, dto);
    return { success: true, data };
  }

  @Delete('nodes/:id/shares/:principalType/:principalId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke access' })
  async unshare(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('principalType') principalType: string,
    @Param('principalId') principalId: string,
  ) {
    const data = await this.shares_.unshare(user.sub, id, principalType, principalId);
    return { success: true, data };
  }

  // ---- Версии ----

  @Get('nodes/:id/versions')
  @ApiOperation({ summary: 'File versions (office documents keep their own, in core/docs)' })
  async versions(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.versions_.list(user.sub, id);
    return { success: true, data };
  }

  @Post('nodes/:id/versions')
  @ApiOperation({ summary: 'Save the current content as a version' })
  async snapshot(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.versions_.snapshot(user.sub, id);
    return { success: true, data };
  }

  @Post('nodes/:id/versions/:versionId/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore a version (the current content goes into the history)' })
  async restoreVersion(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    const versionNo = await this.versions_.restore(user.sub, id, versionId);
    return { success: true, data: { versionNo } };
  }

  @Get('starred')
  @ApiOperation({ summary: 'The viewer’s starred items' })
  async starred(@CurrentUser() user: JwtPayload) {
    const data = await this.drive.listStarred(user.sub);
    return { success: true, data };
  }

  @Get('recent')
  @ApiOperation({ summary: 'Recently opened' })
  async recent(@CurrentUser() user: JwtPayload) {
    const data = await this.drive.listRecent(user.sub);
    return { success: true, data };
  }

  // ---- Лента «Фото» ----

  @Get('photos/buckets')
  @ApiOperation({ summary: 'Photo counts by month (they feed the scrubber)' })
  async photoBuckets(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = drivePhotoBucketsQuerySchema.parse(query);
    const data = await this.photos.buckets(user.sub, q);
    return { success: true, data };
  }

  @Get('photos')
  @ApiOperation({ summary: 'A page of the Photos feed (a columnar response with ready links)' })
  async photoPage(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = drivePhotoQuerySchema.parse(query);
    const data = await this.photos.page(user.sub, q);
    return { success: true, data };
  }
}
