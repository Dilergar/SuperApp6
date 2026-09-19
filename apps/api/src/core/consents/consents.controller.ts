import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  CONSENT_ERROR_CODES,
  consentAcceptSchema,
  consentDocumentQuerySchema,
  consentRevokeSchema,
  consentTransfersQuerySchema,
  isConsentBundleKey,
  isConsentDocumentKey,
  type ConsentAcceptResultDto,
  type ConsentBundleDto,
  type ConsentDocumentDto,
  type ConsentHistoryItemDto,
  type ConsentPendingDto,
  type ConsentReceiptDto,
  type ConsentStateItemDto,
  type ConsentVersionRefDto,
  type CursorPage,
  type PdTransferDto,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';
import { SkipConsentGate } from '../../shared/decorators/skip-consent-gate.decorator';
import { forbidden, notFound } from '../../shared/errors/api-error';
import { I18nService } from '../../shared/i18n/i18n.service';
import { ConsentsActionsService } from './consents.actions.service';
import { ConsentsDocumentsService } from './consents.documents.service';
import { ConsentsService } from './consents.service';

/** IP клиента — ТОЛЬКО `req.ip` (TRUST_PROXY): заголовки X-Forwarded-For руками не читаются. */
const clientIp = (req: Request): string | null => req.ip ?? null;
const userAgent = (req: Request): string | null => {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua : null;
};

/**
 * Согласия человека и витрина документов платформы. Чтения документов и пакетов — @Public:
 * регистрация, сайт и любой клиент рисуют одинаково, архив версий открыт всем. Остальное —
 * под аутентификацией и ВНЕ шлюза согласий (`@SkipConsentGate`): блокирующий экран обязан
 * уметь показать, принять и отозвать. Бот согласий не даёт — ему эти маршруты закрыты.
 * Статика объявлена ДО параметров.
 */
@ApiTags('Consents')
@Controller('consents')
export class ConsentsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly consents: ConsentsService,
    private readonly documents: ConsentsDocumentsService,
    private readonly actions: ConsentsActionsService,
    private readonly i18n: I18nService,
  ) {}

  private person(user: JwtPayload): string {
    if (user.kind === 'bot') throw forbidden('consents.personOnly');
    return user.sub;
  }

  @Public()
  @Get('bundles/:key')
  @ApiOperation({ summary: 'Consent bundle: current versions of the mandatory and optional documents' })
  async bundle(@Param('key') key: string): Promise<{ success: true; data: ConsentBundleDto }> {
    if (!isConsentBundleKey(key)) throw notFound(CONSENT_ERROR_CODES.notFound);
    return { success: true, data: await this.documents.bundle(key) };
  }

  @Public()
  @Get('versions/:versionId')
  @ApiOperation({ summary: 'A document version by id (what the acceptance screens show)' })
  async byVersionId(@Param('versionId', ParseUUIDPipe) versionId: string, @Query() query: unknown): Promise<{ success: true; data: ConsentDocumentDto }> {
    const { locale } = consentDocumentQuerySchema.parse(query ?? {});
    return { success: true, data: await this.documents.getDocumentByVersionId(versionId, locale ?? this.i18n.locale) };
  }

  @Public()
  @Get('documents/:key/versions')
  @ApiOperation({ summary: 'Archive of the published versions of a document' })
  async archive(@Param('key') key: string): Promise<{ success: true; data: ConsentVersionRefDto[] }> {
    if (!isConsentDocumentKey(key)) throw notFound(CONSENT_ERROR_CODES.notFound);
    return { success: true, data: await this.documents.listArchive(key) };
  }

  @Public()
  @Get('documents/:key/v/:version')
  @ApiOperation({ summary: 'A specific version of a document from the archive' })
  async documentVersion(@Param('key') key: string, @Param('version', ParseIntPipe) version: number, @Query() query: unknown): Promise<{ success: true; data: ConsentDocumentDto }> {
    if (!isConsentDocumentKey(key)) throw notFound(CONSENT_ERROR_CODES.notFound);
    const { locale } = consentDocumentQuerySchema.parse(query ?? {});
    return { success: true, data: await this.documents.getDocument(key, locale ?? this.i18n.locale, version) };
  }

  @Public()
  @Get('documents/:key')
  @ApiOperation({ summary: 'The current version of a document in the requested language' })
  async document(@Param('key') key: string, @Query() query: unknown): Promise<{ success: true; data: ConsentDocumentDto }> {
    if (!isConsentDocumentKey(key)) throw notFound(CONSENT_ERROR_CODES.notFound);
    const { locale } = consentDocumentQuerySchema.parse(query ?? {});
    return { success: true, data: await this.documents.getDocument(key, locale ?? this.i18n.locale) };
  }

  @ApiBearerAuth()
  @SkipConsentGate()
  @Get('pending')
  @ApiOperation({ summary: 'What awaits acceptance: blocking, upcoming, and the organizations of the caller' })
  async pending(@CurrentUser() user: JwtPayload): Promise<{ success: true; data: ConsentPendingDto }> {
    return { success: true, data: await this.consents.pendingFor(this.person(user)) };
  }

  @ApiBearerAuth()
  @SkipConsentGate()
  @Get('state')
  @ApiOperation({ summary: 'State of every consent kind of the caller (the "My data" section)' })
  async state(@CurrentUser() user: JwtPayload): Promise<{ success: true; data: ConsentStateItemDto[] }> {
    return { success: true, data: await this.consents.stateFor(this.person(user)) };
  }

  @ApiBearerAuth()
  @SkipConsentGate()
  @Get('history')
  @ApiOperation({ summary: 'Acceptance and revocation history of the caller' })
  async history(@CurrentUser() user: JwtPayload): Promise<{ success: true; data: ConsentHistoryItemDto[] }> {
    return { success: true, data: await this.consents.historyFor(this.person(user)) };
  }

  @ApiBearerAuth()
  @SkipConsentGate()
  @Get('my-data/transfers')
  @ApiOperation({ summary: 'To whom the personal data of the caller was transferred (the PD action register)' })
  async transfers(@CurrentUser() user: JwtPayload, @Query() query: unknown): Promise<{ success: true; data: CursorPage<PdTransferDto> }> {
    const q = consentTransfersQuerySchema.parse(query ?? {});
    return { success: true, data: await this.actions.transfersOf(this.person(user), q) };
  }

  @ApiBearerAuth()
  @SkipConsentGate()
  @Get('receipt/:id')
  @ApiOperation({ summary: 'Personal consent sheet: the eight requisites of the PD law art. 8 p. 4' })
  async receipt(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<{ success: true; data: ConsentReceiptDto }> {
    return { success: true, data: await this.consents.receipt(this.person(user), id) };
  }

  @ApiBearerAuth()
  @SkipConsentGate()
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept document versions (for oneself, or for an organization as its owner)' })
  async accept(@CurrentUser() user: JwtPayload, @Body() body: unknown, @Req() req: Request): Promise<{ success: true; data: ConsentAcceptResultDto }> {
    const userId = this.person(user);
    const dto = consentAcceptSchema.parse(body ?? {});
    let subject: { type: 'user' | 'workspace'; id: string } = { type: 'user', id: userId };
    if (dto.workspaceId) {
      // От имени организации принимает только её владелец; посторонний не узнаёт, есть ли такая организация
      const ws = await this.db.workspace.findUnique({ where: { id: dto.workspaceId }, select: { ownerId: true, archivedAt: true } });
      if (!ws || ws.archivedAt) throw notFound('workspace.notFound');
      if (ws.ownerId !== userId) throw forbidden('consents.ownerOnly');
      subject = { type: 'workspace', id: dto.workspaceId };
    }
    const out = await this.db.$transaction((tx) =>
      this.consents.accept(tx, {
        subject,
        actorUserId: userId,
        actorRole: subject.type === 'workspace' ? 'org_owner' : 'self',
        actorBasis: subject.type === 'workspace' ? 'workspace_owner' : null,
        versionIds: dto.versionIds,
        locale: dto.locale,
        channel: dto.channel,
        bundleKey: dto.bundleKey ?? null,
        evidence: { ip: clientIp(req), userAgent: userAgent(req) },
      }),
    );
    await out.afterCommit();
    return { success: true, data: { accepted: out.accepted } };
  }

  @ApiBearerAuth()
  @SkipConsentGate()
  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a revocable consent (or opt out of an opt-out kind). Revoking the PD consent is account deletion' })
  async revoke(@CurrentUser() user: JwtPayload, @Body() body: unknown, @Req() req: Request): Promise<{ success: true; data: { revoked: number } }> {
    const userId = this.person(user);
    const dto = consentRevokeSchema.parse(body ?? {});
    const out = await this.db.$transaction((tx) =>
      this.consents.revoke(tx, {
        subject: { type: 'user', id: userId },
        documentKey: dto.documentKey,
        actorUserId: userId,
        reason: 'user_revoked',
        locale: this.i18n.locale,
        evidence: { ip: clientIp(req), userAgent: userAgent(req) },
      }),
    );
    await out.afterCommit();
    return { success: true, data: { revoked: out.revoked } };
  }
}
