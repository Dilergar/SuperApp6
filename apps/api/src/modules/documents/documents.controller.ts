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
import { Idempotent, SkipIdempotency } from '../../shared/decorators/idempotency.decorator';
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
  @ApiOperation({ summary: 'The document types of the organization' })
  async listTypes(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = await this.documents.listTypes(user.sub, workspaceId);
    return { success: true, data };
  }

  @Post('doc-types')
  @ApiOperation({ summary: 'Create a document type (Manager and above)' })
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
  @ApiOperation({ summary: 'Update a document type (Manager and above)' })
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
  @ApiOperation({ summary: 'Move a document type to the archive (Manager and above)' })
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
  @ApiOperation({ summary: 'The templates of the organization (Manager and above)' })
  async listTemplates(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    const data = await this.documents.listTemplates(user.sub, workspaceId);
    return { success: true, data };
  }

  @Post('templates')
  @ApiOperation({ summary: 'Create a template: the form file plus the submission form (Manager and above)' })
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
  @ApiOperation({ summary: 'Update a template (Manager and above)' })
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
  @ApiOperation({ summary: 'Publish a template — from this moment it accepts submissions' })
  async publishTemplate(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
  ) {
    const data = await this.documents.publishTemplate(user.sub, workspaceId, templateId);
    return { success: true, data };
  }

  @Post('templates/:templateId/preview')
  @ApiOperation({ summary: 'A PDF preview of a block template with sample data (Manager and above)' })
  // Предпросмотр отдаёт БАЙТЫ PDF и ничего не меняет — повтор безопасен по определению
  @SkipIdempotency('raw_response')
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
  @ApiOperation({ summary: 'Who the template is granted to (Manager and above)' })
  async listGrants(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
  ) {
    const data = await this.documents.listGrants(user.sub, workspaceId, templateId);
    return { success: true, data };
  }

  @Post('templates/:templateId/grants')
  @ApiOperation({ summary: 'Grant a template to a person, a department, a position or a site' })
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
  @ApiOperation({ summary: 'Withdraw a grant of a template' })
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
  @ApiOperation({ summary: 'What I can submit («Submit an application»)' })
  async availableTemplates(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
  ) {
    const data = await this.documents.availableTemplates(user.sub, workspaceId);
    return { success: true, data };
  }

  @Get()
  @ApiOperation({ summary: 'The registry of documents: type, status, employee, period' })
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
  @ApiOperation({ summary: 'Create a document from a template' })
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
  @ApiOperation({ summary: 'Create a free document from scratch (the block builder)' })
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
  @ApiOperation({ summary: 'Create a document from a ready file (PDF or .docx)' })
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
  @ApiOperation({ summary: 'The card of a document' })
  async get(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    const data = await this.documents.get(user.sub, documentId);
    return { success: true, data };
  }

  @Post(':documentId/preview')
  @ApiOperation({ summary: 'A PDF preview of a block document (the current or the sent blocks)' })
  // Тот же предпросмотр: байты PDF, состояние не меняется
  @SkipIdempotency('raw_response')
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
  @ApiOperation({ summary: 'Update a draft (after it is sent the editing is closed)' })
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
  @ApiOperation({ summary: 'Send along the route: the editing closes, a PDF is taken' })
  async submit(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    const data = await this.documents.submit(user.sub, documentId);
    return { success: true, data };
  }

  @Post(':documentId/withdraw')
  @ApiOperation({ summary: 'Return from the route to a draft (while nobody has decided yet)' })
  async withdraw(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    const data = await this.documents.withdraw(user.sub, documentId);
    return { success: true, data };
  }

  @Post(':documentId/cancel')
  @ApiOperation({ summary: 'Cancel a document (the author or a Manager and above)' })
  async cancel(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    const data = await this.documents.cancel(user.sub, documentId);
    return { success: true, data };
  }

  // Номер реестра НЕ переиспользуется: повтор сжигает следующее значение счётчика,
  // и в нумерации остаётся дыра, которую не закрыть.
  @Idempotent({ required: true })
  @Post(':documentId/assign-number')
  @ApiOperation({ summary: 'Assign a number to a draft (the external circuit: the number is printed before sending)' })
  async assignNumber(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    const data = await this.documents.assignNumber(user.sub, documentId);
    return { success: true, data };
  }

  // ---- Внешний этап (категория «С контрагентами») ----

  // Отправка во внешний ЭДО необратима: документ уходит контрагенту
  @Idempotent({ required: true })
  @Post(':documentId/send-external')
  @ApiOperation({ summary: 'Send to a counterparty: freezing, a signing request, a guest link, an SMS' })
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
  @ApiOperation({ summary: 'Withdraw the sending to a counterparty (the link goes dark, the document goes back to a draft)' })
  async revokeExternal(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    const data = await this.documents.revokeExternal(user.sub, documentId);
    return { success: true, data };
  }

  @Post(':documentId/return-to-draft')
  @ApiOperation({ summary: 'Return to a draft after the refusal of a counterparty' })
  async returnToDraft(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    const data = await this.documents.returnToDraft(user.sub, documentId);
    return { success: true, data };
  }

  // SMS уходит НАРУЖУ (и стоит денег): повтор — второе сообщение контрагенту.
  @Idempotent({ required: true })
  @Post(':documentId/external/sms')
  @ApiOperation({ summary: 'Resend the SMS with the link to the counterparty (a 60 s cooldown)' })
  async resendExternalSms(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    await this.documents.resendExternalSms(user.sub, documentId);
    return { success: true, data: { sent: true } };
  }

  @Post(':documentId/pdf')
  @ApiOperation({ summary: 'Request a PDF imprint of the current content' })
  async pdf(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    // Право смотреть документ = право заказать его отпечаток (тот же предикат).
    await this.documents.get(user.sub, documentId);
    const data = await this.documents.requestPdf(documentId);
    return { success: true, data };
  }

  // ---- КЭДО: вручение (специальный режим — ст. 61 п. 3 / ст. 65 ТК РК) ----

  @Post(':documentId/delivery')
  @ApiOperation({ summary: 'Record the hand-over: in person / a refusal act / a registered letter (Manager and above)' })
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
  @ApiOperation({ summary: 'The delivery mode (hybrid): electronic / paper / both (Manager and above)' })
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
