import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationsService } from './conversations.service';

describe('ConversationsService', () => {
  const prisma = {
    conversation: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    message: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const service = new ConversationsService(prisma as unknown as PrismaService);

  beforeEach(() => jest.clearAllMocks());

  it('scopes conversation lists and messages to the signed-in user', async () => {
    prisma.conversation.findMany.mockResolvedValue([]);
    await service.list('user-1', 'kb-1');
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', knowledgeBaseId: 'kb-1' },
      }),
    );

    prisma.conversation.findFirst.mockResolvedValueOnce(null);
    await expect(service.messages('user-2', 'conversation-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it('returns recent history in chronological order for continuation', async () => {
    prisma.conversation.findFirst.mockResolvedValueOnce({
      id: 'conversation-1',
      knowledgeBaseId: 'kb-1',
      knowledgeBase: { workspaceId: 'workspace-1' },
      messages: [
        { role: 'ASSISTANT', content: 'Older answer' },
        { role: 'USER', content: 'Older question' },
      ],
    });
    await expect(service.context('user-1', 'conversation-1')).resolves.toMatchObject({
      messages: [
        { role: 'USER', content: 'Older question' },
        { role: 'ASSISTANT', content: 'Older answer' },
      ],
    });
  });

  it('persists a completed user/assistant turn and its citations in one transaction', async () => {
    const tx = {
      message: {
        create: jest
          .fn()
          .mockResolvedValueOnce({ id: 'user-message' })
          .mockResolvedValueOnce({ id: 'assistant-message' }),
      },
      conversation: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementationOnce(async (callback: (value: typeof tx) => unknown) =>
      callback(tx),
    );
    const citations = [
      {
        citation: 1,
        documentId: 'doc-1',
        documentName: 'handbook.md',
        chunkIndex: 2,
        score: 0.9,
        pageNumber: 12,
        headingPath: ['Employee handbook', 'Leave'],
      },
    ];
    await expect(
      service.saveTurn('conversation-1', 'Question', 'Answer [1]', citations),
    ).resolves.toEqual({
      userMessageId: 'user-message',
      assistantMessageId: 'assistant-message',
    });
    expect(tx.message.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ role: 'ASSISTANT', content: 'Answer [1]', citations }),
      }),
    );
  });
});
