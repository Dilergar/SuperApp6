import { Module, Global } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspaceJournalController } from './journal.controller';
import { StaffModule } from '../staff/staff.module';

/**
 * WorkspacesModule — B2B organizations + membership.
 *
 * @Global so AuthService can call activatePendingWorkspaceInvitationsForNewUser on
 * registration (mirrors ContactsModule). Role/permission state lives in UserRole via
 * the globally-available RolesService; this module owns workspaces, members & invitations.
 * StaffModule даёт назначения должностей (ростер, каскад увольнения, найм с должностью).
 */
@Global()
@Module({
  imports: [StaffModule],
  controllers: [WorkspacesController, WorkspaceJournalController],
  // Строковый токен для нод «Процессов» (ctx.deps.getService), как 'MessengerService'.
  providers: [WorkspacesService, { provide: 'WorkspacesService', useExisting: WorkspacesService }],
  exports: [WorkspacesService, 'WorkspacesService'],
})
export class WorkspacesModule {}
