import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { AcceptWorkspaceInvitationDto } from './dto/accept-workspace-invitation.dto';
import { WorkspaceMembersService } from './workspace-members.service';

@ApiTags('workspace-invitations')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('invitations')
export class WorkspaceInvitationsController {
  constructor(private readonly workspaceMembers: WorkspaceMembersService) {}

  @Post('accept')
  accept(@CurrentUser() user: AuthenticatedUser, @Body() body: AcceptWorkspaceInvitationDto) {
    return this.workspaceMembers.acceptInvitation(user.id, user.email, body.token);
  }
}
