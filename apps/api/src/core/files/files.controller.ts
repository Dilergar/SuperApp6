import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { diskStorage } from 'multer';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  completeFileSchema,
  createPartsSchema,
  downloadQuerySchema,
  FILE_LIMITS,
  initFileSchema,
} from '@superapp/shared';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';
import { FilesService } from './files.service';
import { FilesUrlService } from './files-url.service';
import { FilesContentLengthGuard } from './files-content-length.guard';
import { serveStream } from './files-http.util';

/** Temp-каталог multer'а — на том же томе, что и local-хранилище (rename дёшев) */
function uploadTmpDir(): string {
  const root = path.resolve(process.cwd(), process.env.FILES_LOCAL_ROOT ?? './storage');
  const dir = path.join(root, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Files Engine — тонкий контроллер (Zod → сервис, AI-ready по Принципу 4).
 * Порядок роутов важен: `usage` и `raw/:id` объявлены ДО `:id`-роутов.
 */
@ApiTags('Files')
@ApiBearerAuth()
@Controller('files')
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly urls: FilesUrlService,
  ) {}

  @Post()
  @Throttle({ long: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Начать загрузку (Slack v2: init → байты → complete). Возвращает транспорт api|multipart' })
  async init(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = initFileSchema.parse(body);
    const data = await this.files.init(user.sub, dto);
    return { success: true, data };
  }

  @Get('usage')
  @ApiOperation({ summary: 'Занятое место и лимит хранилища текущего пользователя' })
  async usage(@CurrentUser() user: JwtPayload) {
    const data = await this.files.getUsage(user.sub);
    return { success: true, data };
  }

  /**
   * Приватная раздача для local-драйвера: токен-без-JWT ссылка с HMAC-подписью
   * (query-параметры; path не подписываем — его переписывает алиас /api↔/api/v1).
   */
  @Public()
  @SkipThrottle()
  @Get('raw/:id')
  @ApiOperation({ summary: 'Отдача байтов по HMAC-подписанной ссылке (выдаёт GET /files/:id/download)' })
  async raw(
    @Param('id') id: string,
    @Query('variant') variant: string | undefined,
    @Query('exp') exp: string | undefined,
    @Query('sig') sig: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const variantKind = variant || null;
    if (!sig || !exp || !this.urls.verify(id, variantKind, Number(exp), sig)) {
      throw new ForbiddenException('Ссылка недействительна или истекла');
    }
    await serveStream(req, res, async (range) => {
      const { result, mime, name } = await this.files.openRawStream(id, variantKind, range);
      return {
        result,
        headers: { mime, disposition: this.files.contentDisposition(mime, name), cacheControl: 'private, max-age=0' },
      };
    });
  }

  @Put(':id/content')
  @UseGuards(FilesContentLengthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          try {
            cb(null, uploadTmpDir());
          } catch (err) {
            cb(err as Error, '');
          }
        },
        filename: (_req, _file, cb) => cb(null, `up-${Date.now()}-${randomUUID()}`),
      }),
      limits: { fileSize: FILE_LIMITS.hardMaxSize, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Загрузить байты одним запросом (транспорт api, ≤25 МБ на s3 / ≤200 МБ на local)' })
  async putContent(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Нет файла: ожидается multipart/form-data с полем "file"');
    const data = await this.files.putContent(user.sub, id, { path: file.path, size: file.size });
    return { success: true, data };
  }

  @Post(':id/parts')
  @ApiOperation({ summary: 'Presigned-ссылки на части multipart-загрузки (файлы >25 МБ, s3-драйвер)' })
  async createParts(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { partNumbers } = createPartsSchema.parse(body);
    const data = await this.files.createParts(user.sub, id, partNumbers);
    return { success: true, data };
  }

  @Post(':id/complete')
  @Throttle({ long: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: 'Завершить загрузку: верификация, квота, события, медиа-конвейер' })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const dto = completeFileSchema.parse(body ?? {});
    const data = await this.files.complete(user.sub, id, dto);
    return { success: true, data };
  }

  @Post(':id/abort')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отменить незавершённую загрузку' })
  async abort(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.files.abort(user.sub, id);
    return { success: true, data: { ok: true } };
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Ссылка на скачивание: presigned GET (s3) или HMAC-ссылка (local); ?variant=thumb|medium|poster' })
  async download(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    const { variant } = downloadQuerySchema.parse(query);
    const data = await this.files.getDownloadUrl(user.sub, id, variant);
    return { success: true, data };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Метаданные файла (с вариантами); доступ — владелец/загрузивший/по привязкам' })
  async meta(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.files.getMeta(user.sub, id);
    return { success: true, data };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Удалить файл (soft-delete; физически — кроном после ретеншна)' })
  async remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.files.softDelete(user.sub, id);
    return { success: true, data: { ok: true } };
  }
}
