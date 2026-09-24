import { Module, Global } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service';
import { WorkspacesController } from './workspaces.controller';
import { LegalEntitiesService } from './legal-entities.service';
import { LegalEntitiesController } from './legal-entities.controller';
import { WorkspaceJournalController } from './journal.controller';
import { WorkspaceShareLinksController } from './share-links.controller';
import { WorkspacesCron } from './workspaces.cron';
import { WorkspacesTemplateFieldsProvider } from './workspaces-template-fields.provider';
import { StaffModule } from '../staff/staff.module';
import { WalletModule } from '../wallet/wallet.module';
import { WorkspacesNotificationRefsProvider } from './workspaces-notification-refs.provider';
import { WorkspacesEntitlementsProvider } from './workspaces-entitlements.provider';
import { WorkspacesLifecycleProvider } from './workspaces.lifecycle.provider';
import { WorkspacesVisibilityProvider } from './workspaces-visibility.provider';

/**
 * WorkspacesModule — B2B organizations + membership.
 *
 * @Global so AuthService can call activatePendingWorkspaceInvitationsForNewUser on
 * registration (mirrors ContactsModule). Role/permission state lives in UserRole via
 * the globally-available RolesService; this module owns workspaces, members & invitations.
 * StaffModule даёт назначения должностей (ростер, каскад увольнения, найм с должностью).
 * WalletModule даёт PaymentCardsService — основная карта сотрудника в реквизитном
 * блоке ростера (последние четыре; кто видит — правила видимости `staff.member`).
 */
@Global()
@Module({
  imports: [StaffModule, WalletModule],
  controllers: [
    WorkspacesController,
    LegalEntitiesController,
    WorkspaceJournalController,
    WorkspaceShareLinksController,
  ],
  // Строковый токен для нод «Процессов» (ctx.deps.getService), как 'MessengerService'.
  providers: [
    // Движок уведомлений: резолвер объекта (право видеть батчем + deep link) — фича → движок
    WorkspacesNotificationRefsProvider,
    // Движки тарифов и кабинета: провайдеры расхода мест, push снимка членам, поиск/панели организации
    WorkspacesEntitlementsProvider,
    WorkspacesService,
    LegalEntitiesService,
    WorkspacesCron,
    WorkspacesTemplateFieldsProvider,
    // Движок сроков: ретеншн архива (workspaces.purge) и последний шаг каскада (workspaces.row)
    WorkspacesLifecycleProvider,
    // Движок видимости: тип `workspace.card` (анкета и реквизиты организации; раскрытие IBAN)
    WorkspacesVisibilityProvider,
    { provide: 'WorkspacesService', useExisting: WorkspacesService },
  ],
  exports: [WorkspacesService, LegalEntitiesService, 'WorkspacesService'],
})
export class WorkspacesModule {}
