import { Global, Module } from '@nestjs/common';
import { ShareLinksService } from './share-links.service';
import { ShareLinksGuestService } from './share-links-guest.service';
import { ShareLinksTokenService } from './share-links-token.service';
import { ShareLinksRegistry } from './share-links.registry';
import { ShareLinksCron } from './share-links.cron';
import { ShareLinksController } from './share-links.controller';
import { ShareLinksGuestController } from './share-links-guest.controller';

/**
 * Движок гостевых ссылок (core/share-links) — 13-й платформенный: «поделиться наружу»
 * человеку БЕЗ аккаунта. Токен → гостевая страница просмотра и скачивания, срок,
 * отзыв, счётчик открытий, журнал визитов.
 *
 * Один движок на всю экосистему: Диск и документы сегодня, ЭДО, витрина магазина,
 * счета и страницы отзывов — дальше. Новый потребитель = одна регистрация резолвера
 * в ShareLinksRegistry, движок при этом не знает ни одного функционального модуля.
 *
 * @Global — потребители инжектят ShareLinksService (системный отзыв при удалении
 * объекта) и ShareLinksGuestService (проверка пропуска в своих гостевых контроллерах).
 * Внешних зависимостей у движка нет, поэтому «инертного» режима тоже нет: он работает
 * всегда, а SHARE_LINK_SECRET лишь позволяет развести подпись пропусков с JWT_SECRET.
 */
@Global()
@Module({
  controllers: [ShareLinksController, ShareLinksGuestController],
  providers: [
    ShareLinksService,
    ShareLinksGuestService,
    ShareLinksTokenService,
    ShareLinksRegistry,
    ShareLinksCron,
  ],
  exports: [ShareLinksService, ShareLinksGuestService, ShareLinksRegistry],
})
export class ShareLinksModule {}
