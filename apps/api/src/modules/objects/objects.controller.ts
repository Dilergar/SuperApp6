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
  @ApiOperation({ summary: 'The site tree, trimmed by the rights of the viewer' })
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
  @ApiOperation({ summary: 'My sites (where I work)' })
  async mine(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = await this.objects.mine(user.sub, workspaceId);
    return { success: true, data };
  }

  @Get('settings')
  @ApiOperation({ summary: 'Dictionaries and caps of the service + rights of the viewer at the organization level' })
  async settings(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = await this.objects.settings(user.sub, workspaceId);
    return { success: true, data };
  }

  @Post()
  @ApiOperation({ summary: 'Create a site (top level — admin+; inside a branch — its manager)' })
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
  @ApiOperation({ summary: 'A site + rights of the viewer' })
  async getOne(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
  ) {
    const data = await this.objects.getNode(user.sub, workspaceId, objectId);
    return { success: true, data };
  }

  @Get(':objectId/people')
  @ApiOperation({ summary: 'Colleagues of the site (with its subtree)' })
  async people(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
  ) {
    const data = await this.objects.people(user.sub, workspaceId, objectId);
    return { success: true, data };
  }

  @Get(':objectId/files')
  @ApiOperation({ summary: 'Files of the site (photos, floor plans)' })
  async files(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
  ) {
    const data = await this.objects.listFiles(user.sub, workspaceId, objectId);
    return { success: true, data };
  }

  @Post(':objectId/files')
  @ApiOperation({ summary: 'Attach a file to the site (the manager)' })
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
  @ApiOperation({ summary: 'Detach a file from the site' })
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
  @ApiOperation({ summary: 'Change the site (its manager)' })
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
  @ApiOperation({ summary: 'Move a node (a cycle — 409; the subtree is recomputed)' })
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
  @ApiOperation({ summary: 'Archive (together with the subtree)' })
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
  @ApiOperation({ summary: 'Make the site the main one (owner/admin)' })
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
  @ApiOperation({ summary: 'Restore from the archive' })
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
  @ApiOperation({ summary: 'Delete an empty site (children/people — 409)' })
  async remove(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
  ) {
    await this.objects.remove(user.sub, workspaceId, objectId);
    return { success: true, data: { ok: true } };
  }
}
