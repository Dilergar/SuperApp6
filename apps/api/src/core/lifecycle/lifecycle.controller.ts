import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  lifecycleErasureReceiptParamSchema,
  lifecycleHoldCreateSchema,
  lifecycleHoldReleaseSchema,
  lifecycleHoldStatusQuerySchema,
  lifecycleHoldsQuerySchema,
  lifecycleSettingClassParamSchema,
  lifecycleSettingPreviewSchema,
  lifecycleSettingUpdateSchema,
  type CursorPage,
  type LifecycleErasureReceiptDto,
  type LifecycleErasureVerificationDto,
  type LifecycleHoldDto,
  type LifecycleHoldStatusDto,
  type LifecycleSettingPreviewDto,
  type LifecycleSettingsClassDto,
  type LifecycleSettingsDto,
  type LifecycleWorkspaceSummaryDto,
} from '@superapp/shared';
import { NoApiKeys } from '../../shared/decorators/api-keys.decorator';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';
import { LifecycleErasureService } from './lifecycle.erasure.service';
import { LifecycleHoldsService } from './lifecycle.holds.service';
import { LifecycleSettingsService } from './lifecycle.settings.service';

/**
 * HTTP движка жизненного цикла для людей:
 *  - сроки хранения организации (владелец и админ): карточки классов с коридором, предпросмотр
 *    последствий, сохранение (сокращение — через 30 дней), отмена отложенного, сводка страницы;
 *  - заморозки организации (legal hold) — владелец и админ живой организации, тариф
 *    `lifecycle.holds`; ключ API сюда не пускается (заморозка — решение человека, не
 *    интеграции). Хранитель о заморозке не узнаёт;
 *  - квитанция стирания — ПУБЛИЧНАЯ страница по коду: аккаунта к тому времени уже нет, код —
 *    единственный ключ человека к этапам и подписанному сертификату (в квитанции нет ПДн:
 *    псевдоним, даты, счётчики, подпись). Троттлинг против перебора кодов (130 бит — перебор
 *    безнадёжен, но ручка не должна быть бесплатной). Подпись проверяется в браузере по JWKS,
 *    а после ротации ключа — сервером архивно (`/verification`).
 */
@ApiTags('Lifecycle')
@Controller()
export class LifecycleController {
  constructor(
    private readonly holds: LifecycleHoldsService,
    private readonly erasure: LifecycleErasureService,
    private readonly settings: LifecycleSettingsService,
  ) {}

  // ---- Сроки хранения организации ----

  @ApiBearerAuth()
  @NoApiKeys()
  @Get('workspaces/:workspaceId/lifecycle/settings')
  @ApiOperation({ summary: 'Retention of the organization by data class: corridor, presets, pending shortening (owner/admin)' })
  async getSettings(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string): Promise<{ success: true; data: LifecycleSettingsDto }> {
    return { success: true, data: await this.settings.get(user.sub, workspaceId) };
  }

  @ApiBearerAuth()
  @NoApiKeys()
  @Get('workspaces/:workspaceId/lifecycle/summary')
  @ApiOperation({ summary: 'Data page summary: storage, records by class, next automatic deletion, active holds (owner/admin)' })
  async summary(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string): Promise<{ success: true; data: LifecycleWorkspaceSummaryDto }> {
    return { success: true, data: await this.settings.summary(user.sub, workspaceId) };
  }

  @ApiBearerAuth()
  @NoApiKeys()
  @Post('workspaces/:workspaceId/lifecycle/settings/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Consequences of a retention before saving: rows older than it and when deletion starts' })
  async previewSetting(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() body: unknown,
  ): Promise<{ success: true; data: LifecycleSettingPreviewDto }> {
    return { success: true, data: await this.settings.preview(user.sub, workspaceId, lifecycleSettingPreviewSchema.parse(body ?? {})) };
  }

  @ApiBearerAuth()
  @NoApiKeys()
  @Put('workspaces/:workspaceId/lifecycle/settings')
  @ApiOperation({ summary: 'Set the retention of a data class: longer applies now, shorter after 30 days (members are notified)' })
  async updateSetting(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() body: unknown,
  ): Promise<{ success: true; data: LifecycleSettingsClassDto }> {
    return { success: true, data: await this.settings.update(user.sub, workspaceId, lifecycleSettingUpdateSchema.parse(body ?? {})) };
  }

  @ApiBearerAuth()
  @NoApiKeys()
  @Delete('workspaces/:workspaceId/lifecycle/settings/:dataClass/pending')
  @ApiOperation({ summary: 'Cancel a pending shortening before it takes effect' })
  async cancelPending(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param() params: Record<string, string>,
  ): Promise<{ success: true; data: LifecycleSettingsClassDto }> {
    const { dataClass } = lifecycleSettingClassParamSchema.parse({ dataClass: params.dataClass });
    return { success: true, data: await this.settings.cancelPending(user.sub, workspaceId, dataClass) };
  }

  // ---- Заморозки организации ----

  // Статический путь — до `holds/:holdId/...`
  @ApiBearerAuth()
  @NoApiKeys()
  @Get('workspaces/:workspaceId/lifecycle/holds/status')
  @ApiOperation({ summary: 'Is this member or record under a legal hold of the organization (visible to managers and above)' })
  async holdStatus(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: unknown,
  ): Promise<{ success: true; data: LifecycleHoldStatusDto }> {
    return { success: true, data: await this.holds.statusForWorkspace(user.sub, workspaceId, lifecycleHoldStatusQuerySchema.parse(query ?? {})) };
  }

  @ApiBearerAuth()
  @NoApiKeys()
  @Get('workspaces/:workspaceId/lifecycle/holds')
  @ApiOperation({ summary: 'Legal holds of the organization (owner/admin)' })
  async listHolds(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: unknown,
  ): Promise<{ success: true; data: CursorPage<LifecycleHoldDto> }> {
    return { success: true, data: await this.holds.listForWorkspace(user.sub, workspaceId, lifecycleHoldsQuerySchema.parse(query ?? {})) };
  }

  @ApiBearerAuth()
  @NoApiKeys()
  @Post('workspaces/:workspaceId/lifecycle/holds')
  @ApiOperation({ summary: 'Place a legal hold: a member (custodian), a chat or the organization, one record or a data class' })
  async createHold(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() body: unknown,
  ): Promise<{ success: true; data: LifecycleHoldDto }> {
    return { success: true, data: await this.holds.createForWorkspace(user.sub, workspaceId, lifecycleHoldCreateSchema.parse(body ?? {})) };
  }

  @ApiBearerAuth()
  @NoApiKeys()
  @Post('workspaces/:workspaceId/lifecycle/holds/:holdId/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Release a legal hold of the organization: deletion resumes by retention' })
  async releaseHold(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('holdId', ParseUUIDPipe) holdId: string,
    @Body() body: unknown,
  ): Promise<{ success: true; data: LifecycleHoldDto }> {
    const { note } = lifecycleHoldReleaseSchema.parse(body ?? {});
    return { success: true, data: await this.holds.releaseForWorkspace(user.sub, workspaceId, holdId, note) };
  }

  @Public()
  @Get('lifecycle/erasure-receipts/:code')
  @Throttle({ long: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Public erasure receipt by code: stages, dates and the signed certificate (no personal data)' })
  async receipt(@Param() params: unknown): Promise<{ success: true; data: LifecycleErasureReceiptDto }> {
    const { code } = lifecycleErasureReceiptParamSchema.parse(params ?? {});
    return { success: true, data: await this.erasure.receipt(code) };
  }

  @Public()
  @Get('lifecycle/erasure-receipts/:code/verification')
  @Throttle({ long: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Server-side (archival) check of the certificate signature: valid after the signing key was rotated out of the JWKS' })
  async verifyReceipt(@Param() params: unknown): Promise<{ success: true; data: LifecycleErasureVerificationDto }> {
    const { code } = lifecycleErasureReceiptParamSchema.parse(params ?? {});
    return { success: true, data: await this.erasure.verifyReceipt(code) };
  }
}
