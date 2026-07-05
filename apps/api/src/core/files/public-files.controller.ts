import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { FILE_LIMITS } from '@superapp/shared';
import { Public } from '../../shared/decorators/public.decorator';
import { FilesService } from './files.service';
import { serveStream } from './files-http.util';

/**
 * Публичный класс файлов (аватарки/лого/фото товаров): вечная ссылка с неугадываемым
 * токеном (модель Discord/GitHub), Cache-Control immutable — браузер и будущий CDN
 * кэшируют навсегда. Публичен только байт-контент по прямой ссылке; доступ к СПИСКАМ
 * (кто видит карточку/витрину) по-прежнему гейтится core/access.
 */
@ApiTags('Files')
@Controller('public-files')
export class PublicFilesController {
  constructor(private readonly files: FilesService) {}

  @Public()
  @SkipThrottle()
  @Get(':token')
  @ApiOperation({ summary: 'Публичный файл по вечному токену; ?variant=thumb|medium|poster' })
  async serve(
    @Param('token') token: string,
    @Query('variant') variant: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const resolved = await this.files.resolvePublic(token, variant || null);

    if (resolved.mode === 'redirect') {
      res.setHeader('Cache-Control', resolved.cacheControl);
      res.redirect(302, resolved.url);
      return;
    }

    await serveStream(req, res, async (range) => {
      const result = await this.files.openKeyStream(resolved.key, range);
      return {
        result,
        headers: {
          mime: resolved.mime,
          disposition: this.files.contentDisposition(resolved.mime, resolved.name),
          cacheControl: `public, max-age=${FILE_LIMITS.publicCacheMaxAgeSec}, immutable`,
        },
      };
    });
  }
}
