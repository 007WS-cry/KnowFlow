import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { WorkspacesService } from './workspaces.service';

@ApiTags('workspaces')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.workspacesService.listForUser(user.id);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateWorkspaceDto) {
    return this.workspacesService.create(user.id, body.name);
  }

  @Get(':workspaceId')
  get(@CurrentUser() user: AuthenticatedUser, @Param('workspaceId') workspaceId: string) {
    return this.workspacesService.getForUser(user.id, workspaceId);
  }

  @Patch(':workspaceId')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspaceId: string,
    @Body() body: UpdateWorkspaceDto,
  ) {
    return this.workspacesService.update(user.id, workspaceId, body.name);
  }

  @Delete(':workspaceId')
  delete(@CurrentUser() user: AuthenticatedUser, @Param('workspaceId') workspaceId: string) {
    return this.workspacesService.delete(user.id, workspaceId);
  }
}
