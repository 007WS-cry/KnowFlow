import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EmbeddingService } from '../embeddings/embedding.service';
import { LlmService } from '../llm/llm.service';
import { PrismaService } from '../prisma/prisma.service';
import { KnowledgeBasesService } from '../knowledge-bases/knowledge-bases.service';
import { RerankerService } from '../reranker/reranker.service';
import { ConfigService } from '@nestjs/config';
import { buildSearchTerms, fuseRankedCandidates, RagService } from './rag.service';

describe('RagService hybrid retrieval', () => {
  const accessibleKnowledgeBase = { id: 'kb-1', workspaceId: 'workspace-1', indexVersion: 4 };
  const vectorRows = [
    {
      id: 'chunk-1',
      documentId: 'doc-1',
      documentName: 'paris.md',
      chunkIndex: 0,
      content: '巴黎是法国首都。',
      score: 0.92,
    },
  ];
  const keywordRows = [
    {
      id: 'chunk-1',
      documentId: 'doc-1',
      documentName: 'paris.md',
      chunkIndex: 0,
      content: '巴黎是法国首都。',
      score: 0.8,
    },
  ];
  const prismaMock = {
    $queryRaw: jest.fn((query: { sql: string }) => {
      if (query.sql.includes('IS DISTINCT FROM')) return Promise.resolve([{ count: 0 }]);
      if (query.sql.includes('<=>')) return Promise.resolve(vectorRows);
      return Promise.resolve(keywordRows);
    }),
  };
  const profile = { provider: 'test', model: 'test-embedding', version: 'test-v1', dimension: 2 };
  const embeddingsMock = {
    embedQuery: jest.fn().mockResolvedValue([0.25, 0.75]),
    toPgVector: jest.fn().mockReturnValue('[0.25,0.75]'),
    getProfile: jest.fn().mockReturnValue(profile),
  };
  const knowledgeBasesMock = {
    getById: jest.fn().mockResolvedValue(accessibleKnowledgeBase),
  };
  const llmMock = { generateAnswer: jest.fn().mockResolvedValue('Paris is the capital. [1]') };
  const rerankerMock = {
    rerank: jest.fn(async (_question: string, documents: Array<{ id: string }>) =>
      documents.map((_, index) => ({ index, score: documents.length - index })),
    ),
  };
  const configMock = {
    get: jest.fn((_name: string, defaultValue: unknown) => defaultValue),
  };
  const cacheMock = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const service = new RagService(
    prismaMock as unknown as PrismaService,
    embeddingsMock as unknown as EmbeddingService,
    knowledgeBasesMock as unknown as KnowledgeBasesService,
    llmMock as unknown as LlmService,
    rerankerMock as unknown as RerankerService,
    configMock as unknown as ConfigService,
    cacheMock as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.$queryRaw.mockImplementation((query: { sql: string }) => {
      if (query.sql.includes('IS DISTINCT FROM')) return Promise.resolve([{ count: 0 }]);
      if (query.sql.includes('<=>')) return Promise.resolve(vectorRows);
      return Promise.resolve(keywordRows);
    });
    embeddingsMock.embedQuery.mockResolvedValue([0.25, 0.75]);
    embeddingsMock.toPgVector.mockReturnValue('[0.25,0.75]');
    embeddingsMock.getProfile.mockReturnValue(profile);
    knowledgeBasesMock.getById.mockResolvedValue(accessibleKnowledgeBase);
    cacheMock.get.mockResolvedValue(null);
    llmMock.generateAnswer.mockResolvedValue('Paris is the capital. [1]');
    rerankerMock.rerank.mockImplementation(async (_question, documents) =>
      documents.map((_, index) => ({ index, score: documents.length - index })),
    );
  });

  it('scopes both recall channels to the requested knowledge base and workspace membership', async () => {
    const result = await service.ask('user-1', 'kb-1', 'What is in the handbook?');
    expect(result.chunks).toHaveLength(1);
    expect(knowledgeBasesMock.getById).toHaveBeenCalledWith('kb-1');
    const retrievalQueries = prismaMock.$queryRaw.mock.calls
      .map(([query]) => query as { sql: string; values: unknown[] })
      .filter(({ sql }) => sql.includes('"KnowledgeBase"'));
    expect(retrievalQueries).toHaveLength(2);
    for (const query of retrievalQueries) {
      expect(query.sql).toContain('"WorkspaceMember"');
      expect(query.values).toEqual(expect.arrayContaining(['kb-1', 'workspace-1', 'user-1']));
    }
    expect(retrievalQueries.some(({ sql }) => sql.includes('to_tsvector'))).toBe(true);
    expect(retrievalQueries.some(({ sql }) => sql.includes('<=>'))).toBe(true);
  });

  it('does not execute retrieval for a missing knowledge base', async () => {
    knowledgeBasesMock.getById.mockRejectedValueOnce(new NotFoundException());
    await expect(service.ask('user-2', 'other-kb', 'question')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('rejects questions that produce an empty embedding', async () => {
    embeddingsMock.embedQuery.mockResolvedValueOnce([0, 0]);
    await expect(service.ask('user-1', 'kb-1', '   ')).rejects.toBeInstanceOf(BadRequestException);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses to mix vectors when the configured model differs from the indexed profile', async () => {
    prismaMock.$queryRaw.mockImplementationOnce(() => Promise.resolve([{ count: 1 }]));
    await expect(service.ask('user-1', 'kb-1', 'question')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(rerankerMock.rerank).not.toHaveBeenCalled();
  });

  it('sends only reranked top-k chunks to the LLM and returns score diagnostics on request', async () => {
    const result = await service.ask('user-1', 'kb-1', '法国的首都是什么？', 1, true);
    expect(rerankerMock.rerank).toHaveBeenCalledWith('法国的首都是什么？', [
      { id: 'chunk-1', content: '巴黎是法国首都。' },
    ]);
    expect(llmMock.generateAnswer).toHaveBeenCalledWith('法国的首都是什么？', [
      {
        citation: 1,
        documentName: 'paris.md',
        chunkIndex: 0,
        content: '巴黎是法国首都。',
        pageNumber: null,
        headingPath: [],
      },
    ]);
    expect(result).toMatchObject({
      knowledgeBaseId: 'kb-1',
      answerMode: 'llm',
      answer: 'Paris is the capital. [1]',
      sources: [{ documentId: 'doc-1', documentName: 'paris.md', citation: 1 }],
      retrievalDebug: {
        vectorCandidateCount: 1,
        keywordCandidateCount: 1,
        candidates: [
          {
            id: 'chunk-1',
            vectorRank: 1,
            vectorScore: 0.92,
            keywordRank: 1,
            keywordScore: 0.8,
            fusionScore: expect.any(Number),
            rerankScore: 1,
          },
        ],
      },
    });
    expect((result.chunks as Array<{ vectorRank?: number }>)[0]?.vectorRank).toBe(1);
  });

  it('repairs legacy mojibake filenames in retrieved chunks and citations', async () => {
    const filename = '员工差旅与费用报销管理制度.md';
    const corrupted = Buffer.from(filename, 'utf8').toString('latin1');
    prismaMock.$queryRaw.mockImplementation((query: { sql: string }) => {
      if (query.sql.includes('IS DISTINCT FROM')) return Promise.resolve([{ count: 0 }]);
      const row = {
        id: 'chunk-legacy',
        documentId: 'doc-legacy',
        documentName: corrupted,
        chunkIndex: 0,
        content: '差旅报销制度内容。',
        score: 0.9,
      };
      return Promise.resolve([row]);
    });

    const result = await service.ask('user-1', 'kb-1', '报销制度是什么？');
    expect((result.chunks as Array<{ documentName: string }>)[0]?.documentName).toBe(filename);
    expect((result.sources as Array<{ documentName: string }>)[0]?.documentName).toBe(filename);
    expect(llmMock.generateAnswer).toHaveBeenCalledWith('报销制度是什么？', [
      expect.objectContaining({ documentName: filename }),
    ]);
  });

  it('uses a retrieval cache key that changes with the index version', async () => {
    await service.retrieve('user-1', 'kb-1', 'question');
    const firstKey = cacheMock.get.mock.calls[0]![0];
    knowledgeBasesMock.getById.mockResolvedValueOnce({
      ...accessibleKnowledgeBase,
      indexVersion: 5,
    });
    await service.retrieve('user-1', 'kb-1', 'question');
    const secondKey = cacheMock.get.mock.calls[1]![0];
    expect(firstKey).not.toBe(secondKey);
  });
});

describe('Reciprocal Rank Fusion', () => {
  it('promotes candidates that appear in both recall lists and preserves one-channel candidates', () => {
    const vector = [
      {
        id: 'both',
        documentId: 'd1',
        documentName: 'a.md',
        chunkIndex: 0,
        content: 'both',
        score: 0.9,
        vectorRank: 1,
      },
      {
        id: 'vector-only',
        documentId: 'd1',
        documentName: 'a.md',
        chunkIndex: 1,
        content: 'vector',
        score: 0.8,
        vectorRank: 2,
      },
    ];
    const keyword = [
      {
        id: 'both',
        documentId: 'd1',
        documentName: 'a.md',
        chunkIndex: 0,
        content: 'both',
        score: 0.7,
        keywordRank: 1,
      },
      {
        id: 'keyword-only',
        documentId: 'd2',
        documentName: 'b.md',
        chunkIndex: 0,
        content: 'keyword',
        score: 0.6,
        keywordRank: 3,
      },
    ];
    const result = fuseRankedCandidates(vector, keyword);
    expect(result.map(({ id }) => id)).toEqual(['both', 'vector-only', 'keyword-only']);
    expect(result[0]!.fusionScore).toBeGreaterThan(result[1]!.fusionScore);
    expect(result[2]!.vectorRank).toBeUndefined();
  });
});

describe('PostgreSQL lexical search terms', () => {
  it('extracts overlapping CJK bigrams and trigrams alongside Latin terms', () => {
    const terms = buildSearchTerms('上海住宿标准 OpenAI API');
    expect(terms).toEqual(expect.arrayContaining(['上海', '住宿', '上海住', 'openai', 'api']));
  });
});
