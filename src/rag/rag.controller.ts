import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { AskQuestionDto } from './dto/ask-question.dto';
import { QueryByKnowledgeBaseDto } from './dto/query-by-knowledge-base.dto';
import { RagService } from './rag.service';

@ApiTags('rag')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class RagController {
  constructor(private readonly rag: RagService) {}

  @Post('query')
  askByKnowledgeBase(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: QueryByKnowledgeBaseDto,
  ) {
    return this.rag.ask(user.id, body.knowledgeBaseId, body.question, body.topK, body.debug);
  }

  @Post('knowledge-bases/:knowledgeBaseId/query')
  ask(
    @CurrentUser() user: AuthenticatedUser,
    @Param('knowledgeBaseId') knowledgeBaseId: string,
    @Body() body: AskQuestionDto,
  ) {
    return this.rag.ask(user.id, knowledgeBaseId, body.question, body.topK, body.debug);
  }
}
