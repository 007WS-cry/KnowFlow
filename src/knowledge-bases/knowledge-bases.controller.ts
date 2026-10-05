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
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { CreateKnowledgeBaseDto } from './dto/create-knowledge-base.dto';
import { UpdateKnowledgeBaseDto } from './dto/update-knowledge-base.dto';
import { KnowledgeBasesService } from './knowledge-bases.service';

@ApiTags('knowledge-bases')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class KnowledgeBasesController {
  constructor(private readonly knowledgeBases: KnowledgeBasesService) {}

  @Get('workspaces/:workspaceId/knowledge-bases')
  list(@CurrentUser() user: AuthenticatedUser, @Param('workspaceId') workspaceId: string) {
    return this.knowledgeBases.listForWorkspace(user.id, workspaceId);
  }

  @Post('workspaces/:workspaceId/knowledge-bases')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspaceId: string,
    @Body() body: CreateKnowledgeBaseDto,
  ) {
    return this.knowledgeBases.create(user.id, workspaceId, body.name, body.description);
  }

  @Get('knowledge-bases/:knowledgeBaseId')
  get(@CurrentUser() user: AuthenticatedUser, @Param('knowledgeBaseId') id: string) {
    return this.knowledgeBases.getAccessible(user.id, id);
  }

  @Patch('knowledge-bases/:knowledgeBaseId')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('knowledgeBaseId') id: string,
    @Body() body: UpdateKnowledgeBaseDto,
  ) {
    if (body.name === undefined && body.description === undefined) {
      throw new BadRequestException('请至少提供一个需要更新的字段');
    }
    return this.knowledgeBases.update(user.id, id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
    });
  }

  @Delete('knowledge-bases/:knowledgeBaseId')
  delete(@CurrentUser() user: AuthenticatedUser, @Param('knowledgeBaseId') id: string) {
    return this.knowledgeBases.delete(user.id, id);
  }
}
