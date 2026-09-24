import { Module } from '@nestjs/common';
import { CirclesService } from './circles.service';
import { CirclesController } from './circles.controller';

/**
 * CirclesModule — owner-local "folders" over confirmed ContactLinks.
 *
 * Depends on ContactsService (which is @Global) to render members with
 * the unified me/them card (UserCardService, core/visibility).
 */
@Module({
  controllers: [CirclesController],
  providers: [CirclesService],
  exports: [CirclesService],
})
export class CirclesModule {}
