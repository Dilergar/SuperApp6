import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  documentFromFileSchema,
  documentOpenSchema,
  documentRenditionSchema,
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
  @ApiOperation({ summary: 'Статус движка документов (веб прячет кнопки, когда выключен)' })
  status() {
    return { success: true, data: this.docs.getStatus() };
  }

  @Post('from-file')
  @ApiOperation({ summary: 'Оживить загруженный файл в документ (явный акт человека)' })
  async fromFile(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = documentFromFileSchema.parse(body);
    return { success: true, data: await this.docs.createFromFile(user.sub, dto) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Документ (права зрителя считаются с учётом места, откуда пришёл)' })
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
  @ApiOperation({ summary: 'Переименовать / перевести в «только чтение» (владелец)' })
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const dto = documentUpdateSchema.parse(body);
    return { success: true, data: await this.docs.update(user.sub, id, dto) };
  }

  @Get(':id/versions')
  @ApiOperation({ summary: 'Вехи документа (неизменяемые снимки)' })
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
  @ApiOperation({ summary: '«Сохранить версию» вручную (pre_sign — отпечаток под ЭЦП)' })
  async createVersion(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const dto = documentVersionCreateSchema.parse(body ?? {});
    await this.docs.createVersion(user.sub, id, dto.reason);
    return { success: true };
  }

  @Post(':id/rendition')
  @ApiOperation({ summary: 'Заказать производную: PDF-отпечаток (печать/ЭЦП) или текст для ИИ' })
  async rendition(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const dto = documentRenditionSchema.parse(body ?? {});
    return { success: true, data: await this.docs.requestRendition(user.sub, id, dto.target) };
  }

  @Post(':id/open')
  @ApiOperation({ summary: 'Запуск редактора: адрес iframe + токен для form POST' })
  async open(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const dto = documentOpenSchema.parse(body);
    return { success: true, data: await this.docs.open(user.sub, id, dto) };
  }
}
