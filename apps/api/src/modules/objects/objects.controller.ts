import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createObjectSchema,
  moveObjectSchema,
  objectTreeQuerySchema,
  updateObjectSchema,
} from '@superapp/shared';
import { z } from 'zod';
import { ObjectsService } from './objects.service';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';

/**
 * Сервис «Объекты» — дерево физических площадок организации.
 * Статические пути (`tree`, `mine`) объявлены ДО `:objectId` (иначе Nest ищет
 * объект с именем «tree»).
 */
const attachFileSchema = z.object({ fileId: z.string().uuid() }).strict();

@ApiTags('Objects')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/objects')
export class ObjectsController {
  constructor(private objects: ObjectsService) {}

  @Get('tree')
  @ApiOperation({ summary: 'Дерево объектов, обрезанное правами зрителя' })
  async tree(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Query() query: unknown,
  ) {
    const q = objectTreeQuerySchema.parse(query ?? {});
    const data = await this.objects.tree(user.sub, workspaceId, q.archived === true);
    return { success: true, data };
  }

  @Get('mine')
  @ApiOperation({ summary: 'Мои объекты (где я работаю)' })
  async mine(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = await this.objects.mine(user.sub, workspaceId);
    return { success: true, data };
  }

  @Get('settings')
  @ApiOperation({ summary: 'Словари и потолки сервиса + права зрителя на уровне организации' })
  async settings(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = await this.objects.settings(user.sub, workspaceId);
    return { success: true, data };
  }

  @Post()
  @ApiOperation({ summary: 'Создать объект (верхний уровень — admin+; внутрь ветки — управляющий)' })
  async create(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const dto = createObjectSchema.parse(body);
    const data = await this.objects.create(user.sub, workspaceId, dto);
    return { success: true, data };
  }

  @Get(':objectId')
  @ApiOperation({ summary: 'Объект + права зрителя' })
  async getOne(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
  ) {
    const data = await this.objects.getNode(user.sub, workspaceId, objectId);
    return { success: true, data };
  }

  @Get(':objectId/people')
  @ApiOperation({ summary: 'Коллеги объекта (с поддеревом)' })
  async people(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
  ) {
    const data = await this.objects.people(user.sub, workspaceId, objectId);
    return { success: true, data };
  }

  @Get(':objectId/files')
  @ApiOperation({ summary: 'Файлы объекта (фото площадки, схемы)' })
  async files(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
  ) {
    const data = await this.objects.listFiles(user.sub, workspaceId, objectId);
    return { success: true, data };
  }

  @Post(':objectId/files')
  @ApiOperation({ summary: 'Приложить файл к объекту (управляющий)' })
  async attachFile(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
    @Body() body: unknown,
  ) {
    const { fileId } = attachFileSchema.parse(body);
    await this.objects.attachFile(user.sub, workspaceId, objectId, fileId);
    return { success: true, data: { ok: true } };
  }

  @Delete(':objectId/files/:fileId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отвязать файл от объекта' })
  async detachFile(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
    @Param('fileId') fileId: string,
  ) {
    await this.objects.detachFile(user.sub, workspaceId, objectId, fileId);
    return { success: true, data: { ok: true } };
  }

  @Patch(':objectId')
  @ApiOperation({ summary: 'Изменить объект (управляющий объектом)' })
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
    @Body() body: unknown,
  ) {
    const dto = updateObjectSchema.parse(body);
    const data = await this.objects.update(user.sub, workspaceId, objectId, dto);
    return { success: true, data };
  }

  @Post(':objectId/move')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Перенести узел (цикл — 409; поддерево пересчитывается)' })
  async move(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
    @Body() body: unknown,
  ) {
    const dto = moveObjectSchema.parse(body);
    const data = await this.objects.move(user.sub, workspaceId, objectId, dto.parentId);
    return { success: true, data };
  }

  @Post(':objectId/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'В архив (вместе с поддеревом)' })
  async archive(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
  ) {
    const data = await this.objects.archive(user.sub, workspaceId, objectId, false);
    return { success: true, data };
  }

  @Post(':objectId/make-default')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Сделать объект основным (владелец/админ)' })
  async makeDefault(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
  ) {
    const data = await this.objects.makeDefault(user.sub, workspaceId, objectId);
    return { success: true, data };
  }

  @Post(':objectId/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Вернуть из архива' })
  async restore(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
  ) {
    const data = await this.objects.archive(user.sub, workspaceId, objectId, true);
    return { success: true, data };
  }

  @Delete(':objectId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить пустой объект (дети/люди — 409)' })
  async remove(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
  ) {
    await this.objects.remove(user.sub, workspaceId, objectId);
    return { success: true, data: { ok: true } };
  }
}
