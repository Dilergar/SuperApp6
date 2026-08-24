import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  builderDocSchema,
  createDocTemplateSchema,
  createDocTypeSchema,
  docDeliverySchema,
  docDeliveryModeSchema,
  createFreeOrgDocumentSchema,
  createOrgDocumentSchema,
  createUploadedOrgDocumentSchema,
  docTemplateGrantSchema,
  listOrgDocumentsSchema,
  sendExternalOrgDocumentSchema,
  updateDocTemplateSchema,
  updateDocTypeSchema,
  updateOrgDocumentSchema,
} from '@superapp/shared';
import { z } from 'zod';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { DocumentsService } from './documents.service';

/**
 * Сервис «Документы» — тонкий контроллер: Zod-разбор → сервис. Каждая операция
 * вызываема программно (Принцип 4): это и есть будущие AI-инструменты сервиса.
 *
 * Путь скоупится организацией (паттерн «Сотрудников»), а не chokepoint-заголовком:
 * реестр документов всегда принадлежит конкретной организации, и адрес обязан это
 * показывать — по нему же работают ссылки из уведомлений и хроники.
 */
@ApiTags('documents')
@Controller('workspaces/:workspaceId/documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  // ---- Виды документов (Менеджер+) ----

  @Get('doc-types')
  @ApiOperation({ summary: 'Виды документов организации' })
  async listTypes(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = await this.documents.listTypes(user.sub, workspaceId);
    return { success: true, data };
  }

  @Post('doc-types')
  @ApiOperation({ summary: 'Создать вид документа (Менеджер+)' })
  async createType(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const dto = createDocTypeSchema.parse(body);
    const data = await this.documents.createType(user.sub, workspaceId, dto);
    return { success: true, data };
  }

  @Patch('doc-types/:typeId')
  @ApiOperation({ summary: 'Изменить вид документа (Менеджер+)' })
  async updateType(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('typeId') typeId: string,
    @Body() body: unknown,
  ) {
    const dto = updateDocTypeSchema.parse(body);
    const data = await this.documents.updateType(user.sub, workspaceId, typeId, dto);
    return { success: true, data };
  }

  @Delete('doc-types/:typeId')
  @ApiOperation({ summary: 'Убрать вид в архив (Менеджер+)' })
  async archiveType(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('typeId') typeId: string,
  ) {
    await this.documents.archiveType(user.sub, workspaceId, typeId);
    return { success: true, data: { archived: true } };
  }

  // ---- Шаблоны (Менеджер+) ----

  @Get('templates')
  @ApiOperation({ summary: 'Шаблоны организации (Менеджер+)' })
  async listTemplates(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = await this.documents.listTemplates(user.sub, workspaceId);
    return { success: true, data };
  }

  @Post('templates')
  @ApiOperation({ summary: 'Создать шаблон: бланк + форма подачи (Менеджер+)' })
  async createTemplate(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const dto = createDocTemplateSchema.parse(body);
    const data = await this.documents.createTemplate(user.sub, workspaceId, dto);
    return { success: true, data };
  }

  @Patch('templates/:templateId')
  @ApiOperation({ summary: 'Изменить шаблон (Менеджер+)' })
  async updateTemplate(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
    @Body() body: unknown,
  ) {
    const dto = updateDocTemplateSchema.parse(body);
    const data = await this.documents.updateTemplate(user.sub, workspaceId, templateId, dto);
    return { success: true, data };
  }

  @Post('templates/:templateId/publish')
  @ApiOperation({ summary: 'Опубликовать шаблон — с этого момента по нему можно подавать' })
  async publishTemplate(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
  ) {
    const data = await this.documents.publishTemplate(user.sub, workspaceId, templateId);
    return { success: true, data };
  }

  @Post('templates/:templateId/preview')
  @ApiOperation({ summary: 'PDF-превью блочного шаблона «Пример с данными» (Менеджер+)' })
  async previewTemplate(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
    @Body() body: unknown,
    @Res() res: Response,
  ) {
    // В теле можно прислать НЕСОХРАНЁННЫЕ блоки — превью того, что сейчас на холсте
    const dto = z.object({ builderDoc: builderDocSchema.optional() }).parse(body ?? {});
    const pdf = await this.documents.previewTemplatePdf(user.sub, workspaceId, templateId, dto.builderDoc);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
    res.send(pdf);
  }

  @Get('templates/:templateId/grants')
  @ApiOperation({ summary: 'Кому доступен шаблон (Менеджер+)' })
  async listGrants(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
  ) {
    const data = await this.documents.listGrants(user.sub, workspaceId, templateId);
    return { success: true, data };
  }

  @Post('templates/:templateId/grants')
  @ApiOperation({ summary: 'Выдать шаблон человеку, отделу, должности или филиалу' })
  async addGrant(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
    @Body() body: unknown,
  ) {
    const dto = docTemplateGrantSchema.parse(body);
    await this.documents.addGrant(user.sub, workspaceId, templateId, dto);
    return { success: true, data: { granted: true } };
  }

  @Delete('templates/:templateId/grants/:principalType/:principalId')
  @ApiOperation({ summary: 'Убрать доступность шаблона' })
  async removeGrant(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
    @Param('principalType') principalType: string,
    @Param('principalId') principalId: string,
  ) {
    await this.documents.removeGrant(user.sub, workspaceId, templateId, principalType, principalId);
    return { success: true, data: { revoked: true } };
  }

  // ---- Документы ----
  // ВАЖНО: статические пути объявлены ДО ':documentId' — иначе Nest ищет документ с
  // идентификатором «available-templates» (та же ловушка, что в гостевых ссылках).

  @Get('available-templates')
  @ApiOperation({ summary: 'Что я могу подать («Подать заявление»)' })
  async availableTemplates(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
  ) {
    const data = await this.documents.availableTemplates(user.sub, workspaceId);
    return { success: true, data };
  }

  @Get()
  @ApiOperation({ summary: 'Реестр документов: вид, статус, сотрудник, период' })
  async list(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const dto = listOrgDocumentsSchema.parse(query);
    const data = await this.documents.list(user.sub, workspaceId, dto);
    return { success: true, data };
  }

  @Post()
  @ApiOperation({ summary: 'Создать документ по шаблону' })
  async create(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const dto = createOrgDocumentSchema.parse(body);
    const data = await this.documents.createDocument(user.sub, workspaceId, dto);
    return { success: true, data };
  }

  @Post('free')
  @ApiOperation({ summary: 'Создать свободный документ с нуля (блочный конструктор)' })
  async createFree(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const dto = createFreeOrgDocumentSchema.parse(body);
    const data = await this.documents.createFreeDocument(user.sub, workspaceId, dto);
    return { success: true, data };
  }

  @Post('upload')
  @ApiOperation({ summary: 'Создать документ из готового файла (PDF или .docx)' })
  async createUploaded(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const dto = createUploadedOrgDocumentSchema.parse(body);
    const data = await this.documents.createUploadedDocument(user.sub, workspaceId, dto);
    return { success: true, data };
  }

  @Get(':documentId')
  @ApiOperation({ summary: 'Карточка документа' })
  async get(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    const data = await this.documents.get(user.sub, documentId);
    return { success: true, data };
  }

  @Post(':documentId/preview')
  @ApiOperation({ summary: 'PDF-превью блочного документа (текущие или присланные блоки)' })
  async previewDocument(
    @CurrentUser() user: JwtPayload,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
    @Res() res: Response,
  ) {
    const dto = z.object({ builderDoc: builderDocSchema.optional() }).parse(body ?? {});
    const pdf = await this.documents.previewDocumentPdf(user.sub, documentId, dto.builderDoc);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
    res.send(pdf);
  }

  @Patch(':documentId')
  @ApiOperation({ summary: 'Изменить черновик (после отправки правка закрыта)' })
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
  ) {
    const dto = updateOrgDocumentSchema.parse(body);
    const data = await this.documents.updateDocument(user.sub, documentId, dto);
    return { success: true, data };
  }

  @Post(':documentId/submit')
  @ApiOperation({ summary: 'Отправить на маршрут: правка закрывается, снимается PDF' })
  async submit(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    const data = await this.documents.submit(user.sub, documentId);
    return { success: true, data };
  }

  @Post(':documentId/withdraw')
  @ApiOperation({ summary: 'Вернуть с маршрута в черновик (пока по нему не начали решать)' })
  async withdraw(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    const data = await this.documents.withdraw(user.sub, documentId);
    return { success: true, data };
  }

  @Post(':documentId/cancel')
  @ApiOperation({ summary: 'Отменить документ (автор или Менеджер+)' })
  async cancel(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    const data = await this.documents.cancel(user.sub, documentId);
    return { success: true, data };
  }

  @Post(':documentId/assign-number')
  @ApiOperation({ summary: 'Присвоить номер черновику (внешний контур: номер печатается до отправки)' })
  async assignNumber(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    const data = await this.documents.assignNumber(user.sub, documentId);
    return { success: true, data };
  }

  // ---- Внешний этап (категория «С контрагентами») ----

  @Post(':documentId/send-external')
  @ApiOperation({ summary: 'Отправить контрагенту: заморозка, заявка подписи, гостевая ссылка, SMS' })
  async sendExternal(
    @CurrentUser() user: JwtPayload,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
  ) {
    const dto = sendExternalOrgDocumentSchema.parse(body);
    const data = await this.documents.sendToCounterparty(user.sub, documentId, dto);
    return { success: true, data };
  }

  @Post(':documentId/revoke-external')
  @ApiOperation({ summary: 'Отозвать отправку контрагенту (ссылка гаснет, документ в черновик)' })
  async revokeExternal(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    const data = await this.documents.revokeExternal(user.sub, documentId);
    return { success: true, data };
  }

  @Post(':documentId/return-to-draft')
  @ApiOperation({ summary: 'Вернуть в черновик после отказа контрагента' })
  async returnToDraft(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    const data = await this.documents.returnToDraft(user.sub, documentId);
    return { success: true, data };
  }

  @Post(':documentId/external/sms')
  @ApiOperation({ summary: 'Перепослать SMS со ссылкой контрагенту (кулдаун 60с)' })
  async resendExternalSms(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    await this.documents.resendExternalSms(user.sub, documentId);
    return { success: true, data: { sent: true } };
  }

  @Post(':documentId/pdf')
  @ApiOperation({ summary: 'Заказать PDF-отпечаток текущего содержимого' })
  async pdf(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    // Право смотреть документ = право заказать его отпечаток (тот же предикат).
    await this.documents.get(user.sub, documentId);
    const data = await this.documents.requestPdf(documentId);
    return { success: true, data };
  }

  // ---- КЭДО: вручение (специальный режим — ст. 61 п. 3 / ст. 65 ТК РК) ----

  @Post(':documentId/delivery')
  @ApiOperation({ summary: 'Зафиксировать вручение: лично / отказ актом / заказное письмо (Менеджер+)' })
  async fixDelivery(
    @CurrentUser() user: JwtPayload,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
  ) {
    const dto = docDeliverySchema.parse(body);
    const data = await this.documents.fixDelivery(user.sub, documentId, dto);
    return { success: true, data };
  }

  @Post(':documentId/delivery-mode')
  @ApiOperation({ summary: 'Режим доставки (гибрид): электронно / бумага / оба (Менеджер+)' })
  async setDeliveryMode(
    @CurrentUser() user: JwtPayload,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
  ) {
    const dto = docDeliveryModeSchema.parse(body);
    const data = await this.documents.setDeliveryMode(user.sub, documentId, dto.deliveryMode);
    return { success: true, data };
  }
}
