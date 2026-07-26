import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import { Public } from '../../shared/decorators/public.decorator';
import { sendStorageStream } from '../files/files-http.util';
import { DocsService, WopiLockConflict, WopiTimestampConflict } from './docs.service';
import type { WopiRawBody } from './wopi-raw-body.middleware';

/** Заголовки COOL; принимаем и легаси-алиасы X-LOOL-* (старые сборки и форки) */
function coolHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const cool = headers[`x-cool-wopi-${name}`];
  const lool = headers[`x-lool-wopi-${name}`];
  const value = (cool ?? lool) as string | string[] | undefined;
  return Array.isArray(value) ? value[0] : value;
}

function isTrue(value: string | undefined): boolean {
  return String(value ?? '').toLowerCase() === 'true';
}

/**
 * WOPI-хост: серверная сторона протокола, по которому внешний редактор (Collabora)
 * читает и сохраняет документ. @Public — запросы приходят от КОНТЕЙНЕРА редактора без
 * платформенного JWT; аутентификация = свой подписанный access_token (DocsTokenService).
 * @SkipThrottle — у контейнера один IP на всех пользователей: троттлер отрезал бы
 * редактор целиком, стоило бы паре человек одновременно печатать.
 *
 * ВАЖНО (риск 5): токен приходит в query — эти запросы НЕЛЬЗЯ логировать со строкой
 * запроса. Ни один лог ниже не печатает req.url/originalUrl.
 */
@Public()
@SkipThrottle()
@ApiExcludeController()
@Controller('wopi/files')
export class WopiController {
  constructor(private readonly docs: DocsService) {}

  // ---------- GetFile: байты документа ----------
  // Объявлен ДО ':id' намеренно (дисциплина роутинга движка файлов).

  @Get(':id/contents')
  async getFile(
    @Param('id') id: string,
    @Query('access_token') token: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const ctx = await this.docs.authorizeWopi(id, token);
    const { result, mime, name, version } = await this.docs.openContent(ctx);
    // Совпадает с CheckFileInfo.Version — этого требует протокол
    res.setHeader('X-WOPI-ItemVersion', version);
    sendStorageStream(res, result, false, {
      mime,
      disposition: `attachment; filename="${encodeURIComponent(name)}"`,
      cacheControl: 'no-store',
    });
  }

  // ---------- PutFile: сохранение правок ----------

  @Post(':id/contents')
  async putFile(
    @Param('id') id: string,
    @Query('access_token') token: string | undefined,
    @Headers() headers: Record<string, string>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const body = (req as Request & { wopiBody?: WopiRawBody }).wopiBody;
    try {
      const ctx = await this.docs.authorizeWopi(id, token);
      if (!body?.path) throw new BadRequestException('Пустое тело запроса');

      const saved = await this.docs.putFile(ctx, {
        bodyPath: body.path,
        lock: headers['x-wopi-lock'],
        clientTimestamp: coolHeader(headers, 'timestamp') ?? null,
        // Подсказки клиента (только подсказки — вехи режутся на Unlock):
        // IsExitSave = «сохранение при выходе», сокращает простой блокировки.
        isExitSave: isTrue(coolHeader(headers, 'isexitsave')),
      });
      res.setHeader('X-WOPI-ItemVersion', saved.version);
      res.status(200).json({ LastModifiedTime: saved.lastModifiedTime });
    } catch (err) {
      if (err instanceof WopiLockConflict) {
        res.setHeader('X-WOPI-Lock', err.currentLock);
        res.status(409).json({ Lock: err.currentLock });
        return;
      }
      if (err instanceof WopiTimestampConflict) {
        // Документ изменили мимо редактора — клиент покажет «файл изменён» и
        // предложит сохранить как копию. Код 1010 — часть контракта COOL.
        res.status(409).json({ COOLStatusCode: 1010 });
        return;
      }
      throw err;
    } finally {
      // Временное тело либо уже переехало в хранилище (unlink → ENOENT, глушим),
      // либо осталось после отказа на ранней проверке — в обоих случаях чистим.
      if (body?.path) await fs.promises.unlink(body.path).catch(() => undefined);
    }
  }

  // ---------- CheckFileInfo ----------

  @Get(':id')
  async checkFileInfo(
    @Param('id') id: string,
    @Query('access_token') token: string | undefined,
  ): Promise<Record<string, unknown>> {
    const ctx = await this.docs.authorizeWopi(id, token);
    return this.docs.checkFileInfo(ctx);
  }

  // ---------- Семейство блокировок ----------

  @Post(':id')
  @HttpCode(200)
  async lockOperation(
    @Param('id') id: string,
    @Query('access_token') token: string | undefined,
    @Headers() headers: Record<string, string>,
    @Res() res: Response,
  ): Promise<void> {
    const override = String(headers['x-wopi-override'] ?? '').toUpperCase();
    const lock = headers['x-wopi-lock'];
    const oldLock = headers['x-wopi-oldlock'];

    let ctx;
    try {
      ctx = await this.docs.authorizeWopi(id, token);
    } catch (err) {
      // Протухший токен на продлении/снятии блокировки: отвечаем 401 ОДИН раз и сами
      // закрываем сессию. 403 здесь загоняет COOL в бесконечный цикл ретраев
      // (CollaboraOnline/online#5870), а брошенная блокировка держала бы документ
      // «занятым» ещё полчаса. Закрываем только по совпадающей строке блокировки —
      // иначе любой посторонний с мусорным токеном сбивал бы чужую правку.
      if (err instanceof UnauthorizedException && (override === 'REFRESH_LOCK' || override === 'UNLOCK')) {
        await this.docs.closeStaleSession(id, lock);
      }
      throw err;
    }

    try {
      switch (override) {
        case 'GET_LOCK':
          res.setHeader('X-WOPI-Lock', await this.docs.getLock(id));
          res.status(200).end();
          return;
        case 'LOCK':
          // LOCK с X-WOPI-OldLock — это UnlockAndRelock одним запросом
          if (oldLock) await this.docs.unlockAndRelock(ctx, oldLock, lock ?? '');
          else await this.docs.lock(ctx, lock ?? '');
          res.status(200).end();
          return;
        case 'REFRESH_LOCK':
          await this.docs.lock(ctx, lock ?? '');
          res.status(200).end();
          return;
        case 'UNLOCK':
          await this.docs.unlock(ctx, lock ?? '');
          res.status(200).end();
          return;
        case 'PUT_RELATIVE':
        case 'RENAME_FILE':
        case 'DELETE':
          // Осознанно не реализуем: «Сохранить как»/переименование из редактора нет
          // (UserCanNotWriteRelative: true), документ живёт в своём месте.
          res.status(501).end();
          return;
        case 'PUT_USER_INFO':
          res.status(200).end();
          return;
        default:
          res.status(400).end();
          return;
      }
    } catch (err) {
      if (err instanceof WopiLockConflict) {
        res.setHeader('X-WOPI-Lock', err.currentLock);
        res.status(409).json({ Lock: err.currentLock });
        return;
      }
      throw err;
    }
  }
}
