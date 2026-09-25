import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  lifecycleExportPartParamSchema,
  lifecycleExportRawQuerySchema,
  lifecycleExportsQuerySchema,
  type CursorPage,
  type LifecycleExportDto,
  type LifecycleExportLinkDto,
} from '@superapp/shared';
import { NoApiKeys } from '../../shared/decorators/api-keys.decorator';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';
import { serveStream } from '../files/files-http.util';
import { LifecycleExportService } from './lifecycle.export.service';

/**
 * Выгрузки данных целиком (core/lifecycle Э6):
 *  - человек — архив своих данных (право субъекта, от тарифа не зависит);
 *  - владелец организации — архив организации (фича тарифа, суточная квота байтов);
 *  - заказ и каждая ссылка на скачивание — под окном SMS-подтверждения `data_export`,
 *    не чаще раза в сутки на субъекта, не больше 5 выдач на часть, ссылка живёт 5 минут;
 *  - ключ API сюда не пускается: выгрузка целиком — решение человека, не интеграции;
 *  - байты по ссылке (local-драйвер) — без входа, подпись Ed25519 аудитории `lifecycle` в query.
 */
@ApiTags('Lifecycle')
@Controller()
export class LifecycleExportController {
  constructor(private readonly exports: LifecycleExportService) {}

  // ---- Человек ----

  @ApiBearerAuth()
  @NoApiKeys()
  @Post('lifecycle/exports')
  @Throttle({ long: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Order an archive of all my data (SMS step-up window data_export; once a day)' })
  async requestMine(@CurrentUser() user: JwtPayload): Promise<{ success: true; data: LifecycleExportDto }> {
    return { success: true, data: await this.exports.requestForUser(user.sub) };
  }

  @ApiBearerAuth()
  @NoApiKeys()
  @Get('lifecycle/exports')
  @ApiOperation({ summary: 'My data archives: build progress, readiness, downloads left' })
  async listMine(@CurrentUser() user: JwtPayload, @Query() query: unknown): Promise<{ success: true; data: CursorPage<LifecycleExportDto> }> {
    return { success: true, data: await this.exports.listForUser(user.sub, lifecycleExportsQuerySchema.parse(query ?? {})) };
  }

  @ApiBearerAuth()
  @NoApiKeys()
  @Post('lifecycle/exports/:id/parts/:part/link')
  @HttpCode(HttpStatus.OK)
  @Throttle({ long: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'A 5-minute download link for one part of a ready archive (requester only; at most 5 per part)' })
  async link(@CurrentUser() user: JwtPayload, @Param() params: unknown): Promise<{ success: true; data: LifecycleExportLinkDto }> {
    const { id, part } = lifecycleExportPartParamSchema.parse(params ?? {});
    return { success: true, data: await this.exports.link(user.sub, id, part) };
  }

  @Public()
  @SkipThrottle()
  @Get('lifecycle/exports/:id/parts/:part/raw')
  @ApiOperation({ summary: 'The bytes of an archive part over a signed 5-minute link (local storage driver)' })
  async raw(@Param() params: unknown, @Query() query: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    const { id, part } = lifecycleExportPartParamSchema.parse(params ?? {});
    const q = lifecycleExportRawQuerySchema.parse(query ?? {});
    await serveStream(req, res, async (range) => {
      const { result, fileName } = await this.exports.rawPart(id, part, q.exp, q.k, q.sig, range ?? undefined);
      return {
        result,
        headers: { mime: 'application/zip', disposition: `attachment; filename="${fileName}"`, cacheControl: 'private, no-store' },
      };
    });
  }

  // ---- Организация ----

  @ApiBearerAuth()
  @NoApiKeys()
  @Post('workspaces/:workspaceId/lifecycle/exports')
  @Throttle({ long: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Order an archive of the organization data (owner only; plan feature lifecycle.export, daily byte quota)' })
  async requestWorkspace(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string): Promise<{ success: true; data: LifecycleExportDto }> {
    return { success: true, data: await this.exports.requestForWorkspace(user.sub, workspaceId) };
  }

  @ApiBearerAuth()
  @NoApiKeys()
  @Get('workspaces/:workspaceId/lifecycle/exports')
  @ApiOperation({ summary: 'Archives of the organization data (owner and admins see them; the requester downloads)' })
  async listWorkspace(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: unknown,
  ): Promise<{ success: true; data: CursorPage<LifecycleExportDto> }> {
    return { success: true, data: await this.exports.listForWorkspace(user.sub, workspaceId, lifecycleExportsQuerySchema.parse(query ?? {})) };
  }
}
