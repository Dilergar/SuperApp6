import { Module } from '@nestjs/common';
import { RolesModule } from '../../core/roles/roles.module';
import { DriveAccessService } from './drive-access.service';
import { DriveController } from './drive.controller';
import { DriveCron } from './drive.cron';
import { DriveJobs } from './drive.jobs';
import { DrivePhotosService } from './drive-photos.service';
import { DriveQuickActionsProvider } from './drive-quick-actions.provider';
import { DriveRichCardsProvider } from './drive-rich-cards.provider';
import { DriveRoutingRegistry } from './drive-routing.registry';
import { DriveSearchService } from './drive-search.service';
import { DriveShareLinksProvider } from './drive-share-links.provider';
import { DriveGuestController } from './drive-guest.controller';
import { DriveService } from './drive.service';
import { DriveShareService } from './drive-share.service';
import { DriveTreeService } from './drive-tree.service';
import { DriveVersionsService } from './drive-versions.service';

/**
 * OmniDrive («Диск») — B2C и B2B в одном сервисе.
 *
 * Files / Access / Jobs / Chatter / Notifications / Contacts объявлены @Global, поэтому
 * явно импортируется только RolesModule (роли организации нужны для прав на её диске).
 * Байты, квоты, варианты и антивирус остаются за core/files — Диск даёт имена, дерево,
 * корзину и версии.
 *
 * DriveRoutingRegistry экспортируется наружу: мессенджер и задачи регистрируют в нём,
 * куда складывать свои файлы (направление импорта перевёрнуто, как у слоёв календаря).
 */
@Module({
  imports: [RolesModule],
  controllers: [DriveController, DriveGuestController],
  providers: [
    DriveShareLinksProvider,
    DriveService,
    DriveAccessService,
    DriveTreeService,
    DriveShareService,
    DriveVersionsService,
    DriveRoutingRegistry,
    DriveSearchService,
    DrivePhotosService,
    DriveRichCardsProvider,
    DriveQuickActionsProvider,
    DriveJobs,
    DriveCron,
  ],
  exports: [DriveService, DriveAccessService, DriveRoutingRegistry],
})
export class DriveModule {}
