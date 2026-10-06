import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import {
  knowledgeBaseParam,
  RequireWorkspacePermission,
  workspaceParam,
} from '../authorization/workspace-permissions';
import { WorkspacePolicyGuard } from '../authorization/workspace-policy.guard';
import { CreateKnowledgeBaseDto } from './dto/create-knowledge-base.dto';
import { UpdateKnowledgeBaseDto } from './dto/update-knowledge-base.dto';
import { KnowledgeBasesService } from './knowledge-bases.service';

@ApiTags('knowledge-bases')
@ApiBearerAuth()
@UseGuards(AuthGuard, WorkspacePolicyGuard)
@Controller()
export class KnowledgeBasesController {
  constructor(private readonly knowledgeBases: KnowledgeBasesService) {}

  @Get('workspaces/:workspaceId/knowledge-bases')
  @RequireWorkspacePermission('KNOWLEDGE_BASE_VIEW', workspaceParam('workspaceId'))
  list(@Param('workspaceId') workspaceId: string) {
    return this.knowledgeBases.listForWorkspace(workspaceId);
  }

  @Post('workspaces/:workspaceId/knowledge-bases')
  @RequireWorkspacePermission('KNOWLEDGE_BASE_MANAGE', workspaceParam('workspaceId'))
  create(@Param('workspaceId') workspaceId: string, @Body() body: CreateKnowledgeBaseDto) {
    return this.knowledgeBases.create(workspaceId, body.name, body.description);
  }

  @Get('knowledge-bases/:knowledgeBaseId')
  @RequireWorkspacePermission('KNOWLEDGE_BASE_VIEW', knowledgeBaseParam('knowledgeBaseId'))
  get(@Param('knowledgeBaseId') id: string) {
    return this.knowledgeBases.getById(id);
  }

  @Patch('knowledge-bases/:knowledgeBaseId')
  @RequireWorkspacePermission('KNOWLEDGE_BASE_MANAGE', knowledgeBaseParam('knowledgeBaseId'))
  update(@Param('knowledgeBaseId') id: string, @Body() body: UpdateKnowledgeBaseDto) {
    if (body.name === undefined && body.description === undefined) {
      throw new BadRequestException('请至少提供一个需要更新的字段');
    }
    return this.knowledgeBases.update(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
    });
  }

  @Delete('knowledge-bases/:knowledgeBaseId')
  @RequireWorkspacePermission('KNOWLEDGE_BASE_MANAGE', knowledgeBaseParam('knowledgeBaseId'))
  delete(@Param('knowledgeBaseId') id: string) {
    return this.knowledgeBases.delete(id);
  }
}
