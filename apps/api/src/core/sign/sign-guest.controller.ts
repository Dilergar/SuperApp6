import { Controller, ForbiddenException, Get, NotFoundException, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { SIGN_REQUEST_REF_TYPE } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { Public } from '../../shared/decorators/public.decorator';
import { ShareLinksGuestService } from '../share-links/share-links-guest.service';
import { FilesService } from '../files/files.service';
import { SignProtocolService } from './sign-protocol.service';
import { sendBinary } from './sign.controller';
import type { SignActor } from './sign.service';

/**
 * Выгрузки ВНЕШНЕГО подписанта: свой экземпляр подписанного документа.
 *
 * Ст. 62 ЦК: подписанный документ обязан жить вне системы — и у второй стороны
 * тоже. Гость скачивает штампованную копию и экспортный пакет ПО СВОЕЙ ссылке
 * (пропуск гостевой сессии), аккаунт ему для этого не нужен.
 *
 * Пропуск едет ПАРАМЕТРОМ, а не заголовком (прецедент ZIP-выгрузки Диска):
 * у навигации браузера своих заголовков нет, а пропуск по правам строго слабее
 * адреса /s/<токен>, который у гостя и так в адресной строке.
 *
 * `allowDownload` ссылки здесь НЕ действует намеренно: копия ПОДПИСАНТА — его
 * законный экземпляр, а не «просмотр без скачивания».
 *
 * Правило гостевых ручек: НИКОГДА не 401 (веб-клиент уводит на /login) — только
 * 403/404/410 с машинным кодом.
 */
@ApiTags('Sign')
@Controller('sign/guest')
export class SignGuestController {
  constructor(
    private readonly guest: ShareLinksGuestService,
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    private readonly protocol: SignProtocolService,
  ) {}

  @Public()
  @Get('package')
  // Неаутентифицированная и дорогая ручка (ZIP собирается на лету) — свой потолок
  @Throttle({ long: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: '[Гость] Скачать штампованную копию или экспортный пакет' })
  async download(
    @Query('session') session: string,
    @Query('kind') kind: string,
    @Req() req: Request,
  ): Promise<void> {
    // Пропуск подтверждает живую ссылку и личность; отзыв ссылки гасит его сразу.
    const access = await this.guest.authorizeGuest(session, SIGN_REQUEST_REF_TYPE);
    const request = await this.db.signRequest.findUnique({ where: { id: access.link.refId } });
    if (!request) throw new NotFoundException('Заявка на подпись не найдена');
    if (request.status !== 'completed') {
      throw new ForbiddenException('Выгрузка доступна после завершения подписания');
    }

    if (kind === 'zip') {
      if (!access.guest) throw new ForbiddenException('Подтвердите номер телефона');
      const actor: SignActor = {
        type: 'guest',
        guestId: access.guest.id,
        name: access.guest.name,
        phone: access.guest.phone,
      };
      const { buffer, fileName } = await this.protocol.buildExport(actor, request.id);
      sendBinary(req, buffer, fileName, 'application/zip');
      return;
    }

    // По умолчанию — штампованная копия (kind=stamped)
    if (!request.stampedFileId) {
      // Джоб штампа ещё собирает копию — гостевая страница поллит stamped.ready
      throw new NotFoundException('Итоговый документ ещё готовится — попробуйте через минуту');
    }
    // БУФЕРОМ, а не pipe: без @Res() Nest завершает ответ, как только обработчик
    // вернулся, — асинхронный pipe обрывался на 200 с пустым телом. Штамп —
    // мегабайты, буфер здесь честнее гонки со стримом (прецедент sendBinary).
    const { result, mime, name } = await this.files.openRawStream(request.stampedFileId, null);
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk as Buffer));
    sendBinary(req, Buffer.concat(chunks), name, mime);
  }
}
