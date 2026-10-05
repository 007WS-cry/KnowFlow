import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EmbeddingService } from '../embeddings/embedding.service';
import { LlmService } from '../llm/llm.service';
import { PrismaService } from '../prisma/prisma.service';
import { KnowledgeBasesService } from '../knowledge-bases/knowledge-bases.service';
import { RagService } from './rag.service';

describe('RagService workspace isolation', () => {
  const accessibleKnowledgeBase = {
    id: 'kb-1',
    workspaceId: 'workspace-1',
  };
  const prismaMock = { $queryRaw: jest.fn().mockResolvedValue([]) };
  const embeddingsMock = {
    embed: jest.fn().mockResolvedValue([0.25, 0.75]),
    toPgVector: jest.fn().mockReturnValue('[0.25,0.75]'),
  };
  const knowledgeBasesMock = {
    getAccessible: jest.fn().mockResolvedValue(accessibleKnowledgeBase),
  };
  const llmMock = { generateAnswer: jest.fn().mockResolvedValue('Paris is the capital. [1]') };
  const service = new RagService(
    prismaMock as unknown as PrismaService,
    embeddingsMock as unknown as EmbeddingService,
    knowledgeBasesMock as unknown as KnowledgeBasesService,
    llmMock as unknown as LlmService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.$queryRaw.mockResolvedValue([]);
    embeddingsMock.embed.mockResolvedValue([0.25, 0.75]);
    embeddingsMock.toPgVector.mockReturnValue('[0.25,0.75]');
    knowledgeBasesMock.getAccessible.mockResolvedValue(accessibleKnowledgeBase);
    llmMock.generateAnswer.mockResolvedValue('Paris is the capital. [1]');
  });

  it('scopes retrieval to the requested knowledge base and its workspace membership', async () => {
    const result = await service.ask('user-1', 'kb-1', 'What is in the handbook?');
    expect(result.chunks).toEqual([]);
    expect(knowledgeBasesMock.getAccessible).toHaveBeenCalledWith('user-1', 'kb-1');
    const query = prismaMock.$queryRaw.mock.calls[0]![0] as { sql: string; values: unknown[] };
    expect(query.sql).toContain('"KnowledgeBase"');
    expect(query.sql).toContain('"WorkspaceMember"');
    expect(query.values).toEqual(expect.arrayContaining(['kb-1', 'workspace-1', 'user-1']));
  });

  it('does not execute vector retrieval for an inaccessible workspace knowledge base', async () => {
    knowledgeBasesMock.getAccessible.mockRejectedValueOnce(new NotFoundException());
    await expect(service.ask('user-2', 'other-kb', 'question')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('rejects questions that produce an empty embedding', async () => {
    embeddingsMock.embed.mockResolvedValueOnce([0, 0]);
    await expect(service.ask('user-1', 'kb-1', '   ')).rejects.toBeInstanceOf(BadRequestException);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('sends only the top-k retrieved chunks to the LLM and returns source references', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      {
        id: 'chunk-1',
        documentId: 'doc-1',
        documentName: 'paris.md',
        chunkIndex: 0,
        content: '巴黎是法国首都。',
        score: 0.92,
      },
    ]);

    const result = await service.ask('user-1', 'kb-1', '法国的首都是什么？', 3);
    expect(llmMock.generateAnswer).toHaveBeenCalledWith('法国的首都是什么？', [
      {
        citation: 1,
        documentName: 'paris.md',
        chunkIndex: 0,
        content: '巴黎是法国首都。',
      },
    ]);
    expect(result).toMatchObject({
      knowledgeBaseId: 'kb-1',
      answerMode: 'llm',
      answer: 'Paris is the capital. [1]',
      sources: [{ documentId: 'doc-1', documentName: 'paris.md', citation: 1 }],
    });
  });

  it('repairs legacy mojibake filenames in retrieved chunks and citations', async () => {
    const filename = '员工差旅与费用报销管理制度.md';
    prismaMock.$queryRaw.mockResolvedValueOnce([
      {
        id: 'chunk-legacy',
        documentId: 'doc-legacy',
        documentName: Buffer.from(filename, 'utf8').toString('latin1'),
        chunkIndex: 0,
        content: '差旅报销制度内容。',
        score: 0.9,
      },
    ]);

    const result = await service.ask('user-1', 'kb-1', '报销制度是什么？');

    expect(result.chunks[0]?.documentName).toBe(filename);
    expect(result.sources[0]?.documentName).toBe(filename);
    expect(llmMock.generateAnswer).toHaveBeenCalledWith('报销制度是什么？', [
      expect.objectContaining({ documentName: filename }),
    ]);
  });
});
