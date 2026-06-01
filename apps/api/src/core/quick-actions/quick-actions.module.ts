import { Global, Module } from '@nestjs/common';
import { QuickActionRegistry } from './quick-actions.registry';
import { QuickActionsService } from './quick-actions.service';
import { QuickActionsController } from './quick-actions.controller';

/**
 * Chat quick-actions registry (core/quick-actions). @Global so any feature service can inject
 * QuickActionRegistry to register its actions (the ＋-menu / message-menu buttons) without
 * importing this module — same pattern as core/access, core/rich-cards, core/search. NOT in
 * the chokepoint. DatabaseService + AccessService are @Global.
 */
@Global()
@Module({
  controllers: [QuickActionsController],
  providers: [QuickActionRegistry, QuickActionsService],
  exports: [QuickActionRegistry, QuickActionsService],
})
export class QuickActionsModule {}
