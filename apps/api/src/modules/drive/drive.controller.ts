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
  @ApiOperation({ summary: 'Диск: пространство, доступные мне чужие, занятое место' })
  async overview(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = driveOverviewQuerySchema.parse(query);
    const data = await this.drive.overview(user.sub, q);
    return { success: true, data };
  }

  @Get('nodes')
  @ApiOperation({ summary: 'Содержимое папки (keyset; папки вперёд)' })
  async list(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = driveListQuerySchema.parse(query);
    const { items, nextCursor } = await this.drive.listNodes(user.sub, q);
    return { success: true, data: items, nextCursor };
  }

  @Get('trash')
  @ApiOperation({ summary: 'Корзина (только явно удалённые объекты)' })
  async trashList(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = driveTrashQuerySchema.parse(query);
    const { items, nextCursor } = await this.tree.listTrash(user.sub, q, q);
    return { success: true, data: await this.drive.serializeNodes(user.sub, items), nextCursor };
  }

  @Get('nodes/:id')
  @ApiOperation({ summary: 'Объект: путь, права зрителя, где ещё используется файл' })
  async detail(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const { node, access } = await this.drive.requireNode(user.sub, id);
    const space = await this.drive.loadSpace(node.spaceId);
    // Открытие объекта — единственный сигнал «недавнего», который у нас есть; без него
    // раздел «Недавние» в сайдбаре был пуст всегда (ни одной строки в таблице).
    // Отметка не должна мешать выдаче, поэтому она best-effort внутри самого метода.
    await this.drive.touchRecent(user.sub, node.id);
    const [dto] = await this.drive.serializeNodes(user.sub, [node]);
    return {
      success: true,
      data: {
        node: dto,
        breadcrumbs: await this.drive.breadcrumbs(node),
        space: await this.drive.serializeSpace(space, await this.drive.spaceAccessOf(user.sub, space)),
        access,
        usedElsewhere: await this.drive.usedElsewhere(node.fileId),
      },
    };
  }

  @Post('folders')
  @ApiOperation({ summary: 'Создать папку' })
  async createFolder(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = driveFolderCreateSchema.parse(body);
    const data = await this.drive.createFolder(user.sub, dto);
    return { success: true, data };
  }

  @Post('nodes')
  @ApiOperation({ summary: 'Положить на Диск уже загруженный файл (движок принимает байты сам)' })
  async attach(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = driveNodeCreateSchema.parse(body);
    const data = await this.drive.attachFile(user.sub, dto);
    return { success: true, data };
  }

  @Patch('nodes/:id')
  @ApiOperation({ summary: 'Переименовать' })
  async rename(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const { name } = driveNodeUpdateSchema.parse(body);
    const data = await this.drive.rename(user.sub, id, name);
    return { success: true, data };
  }

  @Post('nodes/move')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Переместить в другую папку того же диска' })
  async move(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = driveMoveSchema.parse(body);
    const moved = await this.tree.move(user.sub, dto.ids, dto.parentId);
    return { success: true, data: { moved } };
  }

  @Post('nodes/trash')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'В корзину (файл ещё жив: вложение в чате работает)' })
  async trash(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = driveIdsSchema.parse(body);
    const trashed = await this.tree.trash(user.sub, dto.ids);
    return { success: true, data: { trashed } };
  }

  @Post('nodes/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Восстановить из корзины' })
  async restore(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = driveIdsSchema.parse(body);
    const restored = await this.tree.restore(user.sub, dto.ids);
    return { success: true, data: { restored } };
  }

  @Delete('nodes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить навсегда (файл гаснет везде, включая вложения в чатах)' })
  async purge(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = driveIdsSchema.parse(body);
    const purged = await this.tree.purge(user.sub, dto.ids);
    return { success: true, data: { purged } };
  }

  @Post('nodes/:id/star')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'В избранное' })
  async star(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.drive.setStar(user.sub, id, true);
    return { success: true, data: { starred: true } };
  }

  @Delete('nodes/:id/star')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Убрать из избранного' })
  async unstar(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.drive.setStar(user.sub, id, false);
    return { success: true, data: { starred: false } };
  }

  @Post('nodes/copy')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Копировать (в том числе на другой диск; оригинал остаётся)' })
  async copy(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = driveCopySchema.parse(body);
    const data = await this.tree.copy(user.sub, dto.ids, dto);
    return { success: true, data };
  }

  // ---- Доступ ----

  @Get('nodes/:id/shares')
  @ApiOperation({ summary: 'Кому открыт доступ (включая унаследованный от папок-предков)' })
  async shares(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.shares_.listShares(user.sub, id);
    return { success: true, data };
  }

  @Post('nodes/:id/shares')
  @ApiOperation({ summary: 'Открыть доступ человеку, Группе, отделу, должности или филиалу' })
  async share(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const dto = driveShareSchema.parse(body);
    const data = await this.shares_.share(user.sub, id, dto);
    return { success: true, data };
  }

  @Delete('nodes/:id/shares/:principalType/:principalId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Закрыть доступ' })
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
  @ApiOperation({ summary: 'Версии файла (у офисных документов — свои, в core/docs)' })
  async versions(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.versions_.list(user.sub, id);
    return { success: true, data };
  }

  @Post('nodes/:id/versions')
  @ApiOperation({ summary: 'Сохранить текущее содержимое версией' })
  async snapshot(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.versions_.snapshot(user.sub, id);
    return { success: true, data };
  }

  @Post('nodes/:id/versions/:versionId/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Вернуть версию (текущее содержимое уходит в историю)' })
  async restoreVersion(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    const versionNo = await this.versions_.restore(user.sub, id, versionId);
    return { success: true, data: { versionNo } };
  }

  @Get('starred')
  @ApiOperation({ summary: 'Избранное зрителя' })
  async starred(@CurrentUser() user: JwtPayload) {
    const data = await this.drive.listStarred(user.sub);
    return { success: true, data };
  }

  @Get('recent')
  @ApiOperation({ summary: 'Недавно открытые' })
  async recent(@CurrentUser() user: JwtPayload) {
    const data = await this.drive.listRecent(user.sub);
    return { success: true, data };
  }

  // ---- Лента «Фото» ----

  @Get('photos/buckets')
  @ApiOperation({ summary: 'Счётчики снимков по месяцам (кормят скруббер)' })
  async photoBuckets(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = drivePhotoBucketsQuerySchema.parse(query);
    const data = await this.photos.buckets(user.sub, q);
    return { success: true, data };
  }

  @Get('photos')
  @ApiOperation({ summary: 'Страница ленты «Фото» (колоночный ответ с готовыми ссылками)' })
  async photoPage(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = drivePhotoQuerySchema.parse(query);
    const data = await this.photos.page(user.sub, q);
    return { success: true, data };
  }
}
