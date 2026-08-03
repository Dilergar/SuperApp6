import { Module, Global } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspaceJournalController } from './journal.controller';
import { WorkspaceShareLinksController } from './share-links.controller';
import { WorkspacesCron } from './workspaces.cron';
import { WorkspacesTemplateFieldsProvider } from './workspaces-template-fields.provider';
import { StaffModule } from '../staff/staff.module';
import { WalletModule } from '../wallet/wallet.module';

/**
 * WorkspacesModule — B2B organizations + membership.
 *
 * @Global so AuthService can call activatePendingWorkspaceInvitationsForNewUser on
 * registration (mirrors ContactsModule). Role/permission state lives in UserRole via
 * the globally-available RolesService; this module owns workspaces, members & invitations.
 * StaffModule даёт назначения должностей (ростер, каскад увольнения, найм с должностью).
 * WalletModule даёт PaymentCardsService — основная карта сотрудника в реквизитном
 * блоке ростера (второй уровень «Видимости в Компаниях», manager+).
 */
@Global()
@Module({
  imports: [StaffModule, WalletModule],
  controllers: [WorkspacesController, WorkspaceJournalController, WorkspaceShareLinksController],
  // Строковый токен для нод «Процессов» (ctx.deps.getService), как 'MessengerService'.
  providers: [
    WorkspacesService,
    WorkspacesCron,
    WorkspacesTemplateFieldsProvider,
    { provide: 'WorkspacesService', useExisting: WorkspacesService },
  ],
  exports: [WorkspacesService, 'WorkspacesService'],
})
export class WorkspacesModule {}
