import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { WorkspaceInvitationsController } from './workspace-invitations.controller';
import { WorkspaceMembersService } from './workspace-members.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  imports: [AuthModule, AuthorizationModule, QueueModule, StorageModule],
  controllers: [WorkspacesController, WorkspaceInvitationsController],
  providers: [WorkspacesService, WorkspaceMembersService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
