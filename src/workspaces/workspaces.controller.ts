import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { RequireWorkspacePermission, workspaceParam } from '../authorization/workspace-permissions';
import { WorkspacePolicyGuard } from '../authorization/workspace-policy.guard';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { InviteWorkspaceMemberDto } from './dto/invite-workspace-member.dto';
import { UpdateWorkspaceMemberDto } from './dto/update-workspace-member.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { WorkspaceMembersService } from './workspace-members.service';
import { WorkspacesService } from './workspaces.service';

@ApiTags('workspaces')
@ApiBearerAuth()
@UseGuards(AuthGuard, WorkspacePolicyGuard)
@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly workspacesService: WorkspacesService,
    private readonly workspaceMembers: WorkspaceMembersService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.workspacesService.listForUser(user.id);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateWorkspaceDto) {
    return this.workspacesService.create(user.id, body.name);
  }

  @Get(':workspaceId')
  @RequireWorkspacePermission('WORKSPACE_VIEW', workspaceParam('workspaceId'))
  get(@Param('workspaceId') workspaceId: string) {
    return this.workspacesService.get(workspaceId);
  }

  @Patch(':workspaceId')
  @RequireWorkspacePermission('WORKSPACE_UPDATE', workspaceParam('workspaceId'))
  update(@Param('workspaceId') workspaceId: string, @Body() body: UpdateWorkspaceDto) {
    return this.workspacesService.update(workspaceId, body.name);
  }

  @Delete(':workspaceId')
  @RequireWorkspacePermission('WORKSPACE_DELETE', workspaceParam('workspaceId'))
  delete(@Param('workspaceId') workspaceId: string) {
    return this.workspacesService.delete(workspaceId);
  }

  @Get(':workspaceId/members')
  @RequireWorkspacePermission('MEMBER_LIST', workspaceParam('workspaceId'))
  listMembers(@Param('workspaceId') workspaceId: string) {
    return this.workspaceMembers.listMembers(workspaceId);
  }

  @Get(':workspaceId/invitations')
  @RequireWorkspacePermission('INVITATION_LIST', workspaceParam('workspaceId'))
  listInvitations(@Param('workspaceId') workspaceId: string) {
    return this.workspaceMembers.listInvitations(workspaceId);
  }

  @Post(':workspaceId/invitations')
  @RequireWorkspacePermission('MEMBER_INVITE', workspaceParam('workspaceId'))
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspaceId: string,
    @Body() body: InviteWorkspaceMemberDto,
  ) {
    return this.workspaceMembers.invite(workspaceId, user.id, body.email, body.role);
  }

  @Delete(':workspaceId/invitations/:invitationId')
  @RequireWorkspacePermission('INVITATION_REVOKE', workspaceParam('workspaceId'))
  revokeInvitation(
    @Param('workspaceId') workspaceId: string,
    @Param('invitationId') invitationId: string,
  ) {
    return this.workspaceMembers.revokeInvitation(workspaceId, invitationId);
  }

  @Delete(':workspaceId/members/:memberUserId')
  @RequireWorkspacePermission('MEMBER_REMOVE', workspaceParam('workspaceId'))
  removeMember(
    @Param('workspaceId') workspaceId: string,
    @Param('memberUserId') memberUserId: string,
  ) {
    return this.workspaceMembers.removeMember(workspaceId, memberUserId);
  }

  @Patch(':workspaceId/members/:memberUserId')
  @RequireWorkspacePermission('MEMBER_ROLE_UPDATE', workspaceParam('workspaceId'))
  updateMemberRole(
    @Param('workspaceId') workspaceId: string,
    @Param('memberUserId') memberUserId: string,
    @Body() body: UpdateWorkspaceMemberDto,
  ) {
    return this.workspaceMembers.updateMemberRole(workspaceId, memberUserId, body.role);
  }
}
