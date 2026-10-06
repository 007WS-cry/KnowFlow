import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RetrievalCitation } from '../rag/rag.service';

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  create(userId: string, knowledgeBaseId: string, title: string) {
    return this.prisma.conversation.create({
      data: { userId, knowledgeBaseId, title: title.trim().slice(0, 120) },
      select: { id: true, knowledgeBaseId: true, title: true, createdAt: true, updatedAt: true },
    });
  }

  list(userId: string, knowledgeBaseId: string) {
    return this.prisma.conversation.findMany({
      where: { userId, knowledgeBaseId },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, knowledgeBaseId: true, title: true, createdAt: true, updatedAt: true },
    });
  }

  async messages(userId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (!conversation) throw new NotFoundException('对话不存在');
    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true, citations: true, createdAt: true },
    });
  }

  async context(userId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      select: {
        id: true,
        knowledgeBaseId: true,
        knowledgeBase: { select: { workspaceId: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: { role: true, content: true },
        },
      },
    });
    if (!conversation) throw new NotFoundException('对话不存在');
    return { ...conversation, messages: conversation.messages.reverse() };
  }

  async saveTurn(
    conversationId: string,
    question: string,
    answer: string,
    citations: RetrievalCitation[],
  ) {
    return this.prisma.$transaction(async (tx) => {
      const userMessage = await tx.message.create({
        data: { conversationId, role: 'USER', content: question },
      });
      const assistantMessage = await tx.message.create({
        data: {
          conversationId,
          role: 'ASSISTANT',
          content: answer,
          citations: citations as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });
      return { userMessageId: userMessage.id, assistantMessageId: assistantMessage.id };
    });
  }
}
