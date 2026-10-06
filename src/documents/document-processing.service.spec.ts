import { DocumentProcessingStage, DocumentStatus } from '@prisma/client';
import { Readable } from 'node:stream';
import { EmbeddingService } from '../embeddings/embedding.service';
import { EmbeddingIndexService } from '../embeddings/embedding-index.service';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../storage/minio.service';
import { DocumentProcessingService } from './document-processing.service';

interface SqlQuery {
  sql: string;
  values: unknown[];
}

function createHarness(
  content: string,
  options: { filename?: string; activeIndexVersion?: number; cancelOnCheck?: boolean } = {},
) {
  const stageUpdates: DocumentProcessingStage[] = [];
  const statusUpdates: DocumentStatus[] = [];
  const document = {
    id: 'document-1',
    knowledgeBaseId: 'kb-1',
    originalName: options.filename ?? 'notes.txt',
    objectKey: 'workspace-1/kb-1/notes.txt',
    status: DocumentStatus.PENDING,
    processingStage: DocumentProcessingStage.QUEUED,
    activeIndexVersion: options.activeIndexVersion ?? 0,
    cancelRequested: false,
  };
  let findCount = 0;
  const recordUpdate = (data: Record<string, unknown>) => {
    if (data.status) statusUpdates.push(data.status as DocumentStatus);
    if (data.processingStage) stageUpdates.push(data.processingStage as DocumentProcessingStage);
  };
  const prismaMock = {
    document: {
      findUnique: jest.fn(async () => {
        findCount += 1;
        return {
          ...document,
          cancelRequested: options.cancelOnCheck && findCount > 1,
        };
      }),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        recordUpdate(data);
        return { count: 1 };
      }),
    },
    chunk: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
      callback({
        document: {
          updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
            recordUpdate(data);
            return { count: options.cancelOnCheck ? 0 : 1 };
          }),
        },
        knowledgeBase: { update: jest.fn().mockResolvedValue({}) },
      }),
    ),
  };
  const storageClient = {
    getObject: jest.fn(async () => Readable.from([Buffer.from(content)])),
  };
  const storage = { getClient: () => storageClient, getBucket: () => 'knowflow-documents' };
  const embeddingIndex = { ensureHnswIndex: jest.fn().mockResolvedValue(undefined) };
  const embeddings = {
    embedDocuments: jest.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
    toPgVector: jest.fn((vector: number[]) => `[${vector.join(',')}]`),
    getProfile: jest.fn((dimension: number) => ({
      provider: 'test',
      model: 'test-model',
      version: 'test-v1',
      dimension,
    })),
  };
  const service = new DocumentProcessingService(
    prismaMock as unknown as PrismaService,
    storage as unknown as MinioService,
    embeddings as unknown as EmbeddingService,
    embeddingIndex as unknown as EmbeddingIndexService,
  );
  return { service, prismaMock, storageClient, embeddingIndex, stageUpdates, statusUpdates };
}

describe('DocumentProcessingService staged structured indexing', () => {
  it('persists structured Markdown metadata and activates a new index version', async () => {
    const content = '# 员工手册\n\n## 请假制度\n\n员工每年可以申请年假。';
    const harness = createHarness(content, { filename: 'handbook.md', activeIndexVersion: 2 });
    await harness.service.process('document-1');

    expect(harness.storageClient.getObject).toHaveBeenCalledWith(
      'knowflow-documents',
      'workspace-1/kb-1/notes.txt',
    );
    expect(harness.embeddingIndex.ensureHnswIndex).toHaveBeenCalledWith(3);
    const insert = harness.prismaMock.$executeRaw.mock.calls[0]![0] as SqlQuery;
    expect(insert.sql).toContain('"documentIndexVersion"');
    expect(insert.values[1]).toBe('document-1');
    expect(insert.values[2]).toBe(3);
    expect(insert.values[4]).toContain('员工每年');
    expect(JSON.parse(insert.values[10] as string)).toMatchObject({
      sourceName: 'handbook.md',
      headingPath: ['员工手册', '请假制度'],
      paragraphStart: 1,
    });
    expect(harness.statusUpdates).toEqual([DocumentStatus.PROCESSING, DocumentStatus.READY]);
    expect(harness.stageUpdates).toEqual([
      DocumentProcessingStage.PARSING,
      DocumentProcessingStage.CHUNKING,
      DocumentProcessingStage.EMBEDDING,
      DocumentProcessingStage.EMBEDDING,
      DocumentProcessingStage.INDEXING,
      DocumentProcessingStage.COMPLETE,
    ]);
  });

  it('records failure reason and leaves the active index untouched', async () => {
    const harness = createHarness('   ');
    await expect(harness.service.process('document-1')).rejects.toThrow(
      '文档中没有可索引的文本内容',
    );
    expect(harness.statusUpdates.at(-1)).toBe(DocumentStatus.FAILED);
    expect(harness.prismaMock.document.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: DocumentStatus.FAILED,
          errorMessage: expect.any(String),
        }),
      }),
    );
    expect(harness.prismaMock.$executeRaw).not.toHaveBeenCalled();
  });

  it('removes the staging version when vector persistence fails so retry can start cleanly', async () => {
    const harness = createHarness('Persist this embedding.');
    harness.prismaMock.$executeRaw.mockRejectedValueOnce(new Error('pgvector write failed'));
    await expect(harness.service.process('document-1')).rejects.toThrow('pgvector write failed');
    expect(harness.prismaMock.chunk.deleteMany).toHaveBeenCalledWith({
      where: { documentId: 'document-1', documentIndexVersion: 1 },
    });
    expect(harness.statusUpdates.at(-1)).toBe(DocumentStatus.FAILED);
  });

  it('stops between processing stages when cancellation is requested', async () => {
    const harness = createHarness('This task will be cancelled.', { cancelOnCheck: true });
    await harness.service.process('document-1');
    expect(harness.statusUpdates.at(-1)).toBe(DocumentStatus.CANCELLED);
    expect(harness.prismaMock.$executeRaw).not.toHaveBeenCalled();
  });
});
