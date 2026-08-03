import {
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { ShareLink } from '@prisma/client';
import type { Response } from 'express';
import {
  DRIVE_NODE_REF_TYPE,
  SHARE_LINK_ERROR_CODES,
  SHARE_SESSION_HEADER,
  driveGuestListSchema,
  driveGuestZipSchema,
} from '@superapp/shared';
import { ShareLinksGuestService } from '../../core/share-links/share-links-guest.service';
import { Public } from '../../shared/decorators/public.decorator';
import { DatabaseService } from '../../shared/database/database.service';
import { DriveGuestZipService } from './drive-guest-zip.service';
import { DriveShareLinksProvider } from './drive-share-links.provider';
import { DriveService, type NodeRow } from './drive.service';

/**
 * Диск глазами гостя по ссылке наружу (core/share-links).
 *
 * Аутентификации платформы здесь нет: вход открывает подписанный пропуск в заголовке,
 * а движок ссылок на КАЖДОМ запросе перечитывает строку ссылки — поэтому отзыв
 * срабатывает мгновенно.
 *
 * Несущее правило: скоуп выводится из САМОЙ ССЫЛКИ, а не из параметров запроса. Всё,
 * что не лежит в поддереве её корня, отвечает 404 — не 403: подтверждать существование
 * соседних папок постороннему человеку нельзя.
 */
@ApiTags('Drive')
@Controller('drive/guest')
export class DriveGuestController {
  constructor(
    private readonly db: DatabaseService,
    private readonly drive: DriveService,
    private readonly guest: ShareLinksGuestService,
    private readonly provider: DriveShareLinksProvider,
    private readonly zipper: DriveGuestZipService,
  ) {}

  @Public()
  @Get('nodes')
  @ApiOperation({ summary: 'Содержимое папки внутри гостевой ссылки' })
  async list(
    @Headers(SHARE_SESSION_HEADER) session: string | undefined,
    @Query() query: Record<string, unknown>,
  ) {
    const q = driveGuestListSchema.parse(query);
    const { link, root } = await this.rootOf(session);
    // Ссылка на одиночный файл папок не открывает — листать нечего.
    if (root.kind !== 'folder') throw new NotFoundException('Папка не найдена');

    const parent = q.parentId ? await this.nodeInScope(root, q.parentId) : root;
    if (parent.kind !== 'folder') throw new NotFoundException('Папка не найдена');

    const { rows, nextCursor } = await this.drive.listChildrenOf(parent.id, q);
    return {
      success: true,
      data: await this.provider.guestNodes(rows, link.allowDownload),
      nextCursor,
    };
  }

  /**
   * «Скачать всё» — архив поддерева ссылки (или её подпапки).
   *
   * Уважает настройку владельца «разрешить скачивание»: без неё ZIP был бы обходом
   * ровно того, что настройка обещает.
   */
  @Public()
  // Троттлинг жёстче, чем у остальных гостевых ручек: каждый вызов обходит поддерево и
  // тянет байты всех файлов. Неаутентифицированная и дорогая ручка без своего потолка —
  // это готовый усилитель нагрузки.
  @Throttle({ long: { limit: 5, ttl: 60_000 } })
  @Get('download-zip')
  async zip(@Query() query: Record<string, unknown>, @Res() res: Response) {
    // Пропуск здесь приходит параметром, а не заголовком: скачивание — это навигация
    // браузера, своих заголовков у неё нет. Единственное такое место в движке.
    const q = driveGuestZipSchema.parse(query);
    const { link, root } = await this.rootOf(q.session);
    if (!link.allowDownload) {
      throw new HttpException(
        {
          message: 'Владелец ссылки разрешил только просмотр',
          details: { code: SHARE_LINK_ERROR_CODES.downloadDisabled },
        },
        HttpStatus.FORBIDDEN,
      );
    }
    if (root.kind !== 'folder') throw new NotFoundException('Папка не найдена');

    const target = q.nodeId ? await this.nodeInScope(root, q.nodeId) : root;
    if (target.kind !== 'folder') throw new NotFoundException('Папка не найдена');
    await this.zipper.stream(target, res);
  }

  @Public()
  @Get('nodes/:id')
  @ApiOperation({ summary: 'Один объект внутри ссылки (свежие ссылки на байты)' })
  async node(@Headers(SHARE_SESSION_HEADER) session: string | undefined, @Param('id') id: string) {
    const { link, root } = await this.rootOf(session);
    const node = await this.nodeInScope(root, id);
    const [data] = await this.provider.guestNodes([node], link.allowDownload);
    return { success: true, data };
  }

  // ============================================================
  // Скоуп ссылки
  // ============================================================

  /** Пропуск → живая ссылка → её корневой узел (он же граница видимого поддерева) */
  private async rootOf(session: string | undefined): Promise<{ link: ShareLink; root: NodeRow }> {
    // Личность гостя Диску пока не нужна (просмотр и скачивание безличны) — берём
    // только ссылку. Будущие потребители-действия берут из того же вызова `guest`.
    const { link } = await this.guest.authorizeGuest(session, DRIVE_NODE_REF_TYPE);
    const root = await this.db.driveNode.findUnique({ where: { id: link.refId } });
    // Корень исчез или уехал в корзину — тот же ответ, что даёт resolveGuestView.
    if (!root || root.trashedAt) throw new NotFoundException('Объект больше недоступен');
    return { link, root };
  }

  /**
   * Узел обязан лежать В ПОДДЕРЕВЕ корня ссылки. Проверяется по материализованному
   * массиву предков — тому же, на котором стоит наследование прав внутри платформы.
   * Совпадение пространства проверяется отдельно: id узла угадать нельзя, но полагаться
   * на это в проверке границы — плохая идея.
   */
  private async nodeInScope(root: NodeRow, nodeId: string): Promise<NodeRow> {
    const node = await this.db.driveNode.findUnique({ where: { id: nodeId } });
    const inScope =
      node &&
      !node.trashedAt &&
      node.spaceId === root.spaceId &&
      (node.id === root.id || node.ancestorIds.includes(root.id));
    if (!inScope) throw new NotFoundException('Объект не найден');
    return node;
  }
}
