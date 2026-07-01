import { Global, Module } from '@nestjs/common';
import { RichCardRegistry } from './rich-cards.registry';
import { RichCardsService } from './rich-cards.service';
import { RichCardsController } from './rich-cards.controller';

/**
 * Reusable rich-card registry + dispatcher (core/rich-cards). @Global so any feature
 * service can inject RichCardRegistry to register its renderers/actions (Part 3F) without
 * importing this module. DatabaseService + AccessService are @Global; MessengerService
 * (for sharing into a chat) is resolved lazily via ModuleRef → no core→feature cycle.
 */
@Global()
@Module({
  controllers: [RichCardsController],
  providers: [
    RichCardRegistry,
    RichCardsService,
    // Строковый токен для нод «Процессов» (ctx.deps.getService), как 'MessengerService'/'ShopService'.
    { provide: 'RichCardsService', useExisting: RichCardsService },
  ],
  exports: [RichCardRegistry, RichCardsService, 'RichCardsService'],
})
export class RichCardsModule {}
