import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  documentFromFileSchema,
  documentOpenSchema,
  documentRenditionSchema,
  documentRestoreSchema,
  documentUpdateSchema,
  documentVersionCreateSchema,
} from '@superapp/shared';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { DocsService } from './docs.service';

/**
 * Движок документов — тонкий контроллер (Zod → сервис, AI-ready по Принципу 4).
 * Сервиса «Документы» со списками и папками в v1 НЕТ намеренно: документ живёт там,
 * где живёт его файл (задача, чат), и открывается кнопкой на вложении.
 */
@ApiTags('Docs')
@ApiBearerAuth()
@Controller('docs')
export class DocsController {
  constructor(private readonly docs: DocsService) {}

  @Get('status')
  @ApiOperation({ summary: 'The documents engine status (the web hides its buttons when it is off)' })
  status() {
    return { success: true, data: this.docs.getStatus() };
  }

  @Post('from-file')
  @ApiOperation({ summary: 'Turn an uploaded file into a document (an explicit human act)' })
  async fromFile(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = documentFromFileSchema.parse(body);
    return { success: true, data: await this.docs.createFromFile(user.sub, dto) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'The document (the viewer rights account for the place they came from)' })
  async get(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('refType') refType?: string,
    @Query('refId') refId?: string,
  ) {
    const ctx = refType && refId ? { refType, refId } : null;
    return { success: true, data: await this.docs.getDocument(user.sub, id, ctx) };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename it / switch it to read-only (the owner)' })
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const dto = documentUpdateSchema.parse(body);
    return { success: true, data: await this.docs.update(user.sub, id, dto) };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Close the document for good (the owner): editing and the milestone history' })
  async remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.docs.archiveByUser(user.sub, id);
    return { success: true };
  }

  @Get(':id/versions')
  @ApiOperation({ summary: 'The document milestones (immutable snapshots)' })
  async versions(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('refType') refType?: string,
    @Query('refId') refId?: string,
  ) {
    const ctx = refType && refId ? { refType, refId } : null;
    return { success: true, data: await this.docs.listVersions(user.sub, id, ctx) };
  }

  @Post(':id/versions')
  @ApiOperation({ summary: '“Save a version” manually (pre_sign — the imprint under an ECP signature)' })
  async createVersion(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const dto = documentVersionCreateSchema.parse(body ?? {});
    const ctx = dto.refType && dto.refId ? { refType: dto.refType, refId: dto.refId } : null;
    await this.docs.createVersion(user.sub, id, dto.reason, ctx);
    return { success: true };
  }

  @Post(':id/versions/:versionId/restore')
  @ApiOperation({ summary: 'Restore a milestone as the current content (the right is the editing right)' })
  async restoreVersion(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const dto = documentRestoreSchema.parse(body ?? {});
    const ctx = dto.refType && dto.refId ? { refType: dto.refType, refId: dto.refId } : null;
    await this.docs.restoreVersion(user.sub, id, versionId, ctx);
    return { success: true };
  }

  @Post(':id/rendition')
  @ApiOperation({ summary: 'Order a rendition: the PDF imprint (printing / ECP) or the text for AI' })
  async rendition(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const dto = documentRenditionSchema.parse(body ?? {});
    const ctx = dto.refType && dto.refId ? { refType: dto.refType, refId: dto.refId } : null;
    return { success: true, data: await this.docs.requestRendition(user.sub, id, dto.target, ctx) };
  }

  @Post(':id/open')
  @ApiOperation({ summary: 'Launching the editor: the iframe address plus the token for the form POST' })
  async open(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const dto = documentOpenSchema.parse(body);
    return { success: true, data: await this.docs.open(user.sub, id, dto) };
  }
}
