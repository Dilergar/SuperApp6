import { Module, Global } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service';
import { WorkspacesController } from './workspaces.controller';

/**
 * WorkspacesModule — B2B organizations + membership.
 *
 * @Global so AuthService can call activatePendingWorkspaceInvitationsForNewUser on
 * registration (mirrors ContactsModule). Role/permission state lives in UserRole via
 * the globally-available RolesService; this module owns workspaces, members & invitations.
 */
@Global()
@Module({
  controllers: [WorkspacesController],
  providers: [WorkspacesService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
