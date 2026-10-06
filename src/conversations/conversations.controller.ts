import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import {
  conversationParam,
  knowledgeBaseBody,
  knowledgeBaseParam,
  RequireWorkspacePermission,
} from '../authorization/workspace-permissions';
import { WorkspacePolicyGuard } from '../authorization/workspace-policy.guard';
import { RagService } from '../rag/rag.service';
import { LlmService } from '../llm/llm.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { StreamMessageDto } from './dto/stream-message.dto';
import { ConversationsService } from './conversations.service';

@ApiTags('conversations')
@ApiBearerAuth()
@UseGuards(AuthGuard, WorkspacePolicyGuard)
@Controller()
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly rag: RagService,
    private readonly llm: LlmService,
  ) {}

  @Post('conversations')
  @RequireWorkspacePermission('KNOWLEDGE_BASE_VIEW', knowledgeBaseBody('knowledgeBaseId'))
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateConversationDto) {
    return this.conversations.create(user.id, body.knowledgeBaseId, body.title);
  }

  @Get('knowledge-bases/:knowledgeBaseId/conversations')
  @RequireWorkspacePermission('KNOWLEDGE_BASE_VIEW', knowledgeBaseParam('knowledgeBaseId'))
  list(@CurrentUser() user: AuthenticatedUser, @Param('knowledgeBaseId') knowledgeBaseId: string) {
    return this.conversations.list(user.id, knowledgeBaseId);
  }

  @Get('conversations/:conversationId/messages')
  @RequireWorkspacePermission('KNOWLEDGE_BASE_VIEW', conversationParam('conversationId'))
  messages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('conversationId') conversationId: string,
  ) {
    return this.conversations.messages(user.id, conversationId);
  }

  @Post('conversations/:conversationId/messages/stream')
  @RequireWorkspacePermission('KNOWLEDGE_BASE_VIEW', conversationParam('conversationId'))
  async stream(
    @CurrentUser() user: AuthenticatedUser,
    @Param('conversationId') conversationId: string,
    @Body() body: StreamMessageDto,
    @Req() _request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const context = await this.conversations.context(user.id, conversationId);
    const abortController = new AbortController();
    response.on('close', () => {
      if (!response.writableEnded) abortController.abort();
    });
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    const send = (event: string, data: unknown) => {
      if (!response.writableEnded && !response.destroyed) {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };
    const heartbeat = setInterval(() => {
      if (!response.writableEnded && !response.destroyed) response.write(': keep-alive\n\n');
    }, 15_000);

    try {
      send('start', { conversationId });
      const retrieval = await this.rag.retrieve(
        user.id,
        context.knowledgeBaseId,
        body.question,
        5,
        false,
      );
      send('sources', { sources: retrieval.citations });
      const answerParts: string[] = [];
      if (retrieval.chunks.length === 0) {
        answerParts.push('当前知识库还没有可检索的已处理文档，请先上传文档并等待处理完成。');
        send('delta', { text: answerParts[0] });
      } else {
        await this.llm.streamAnswer(
          body.question,
          retrieval.chunks.map((chunk, index) => ({
            citation: index + 1,
            documentName: chunk.documentName,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
            pageNumber: chunk.pageNumber ?? null,
            headingPath: chunk.headingPath ?? [],
          })),
          context.messages,
          abortController.signal,
          (text) => {
            answerParts.push(text);
            send('delta', { text });
          },
        );
      }
      if (abortController.signal.aborted) return;
      const answer = answerParts.join('');
      const saved = await this.conversations.saveTurn(
        conversationId,
        body.question,
        answer,
        retrieval.citations,
      );
      send('complete', { ...saved, answer, citations: retrieval.citations });
    } catch (error) {
      if (!abortController.signal.aborted) {
        send('error', { message: error instanceof Error ? error.message : '问答处理失败' });
      }
    } finally {
      clearInterval(heartbeat);
      if (!response.writableEnded) response.end();
    }
  }
}
