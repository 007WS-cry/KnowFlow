import { DocumentStatus } from '@prisma/client';
import { Readable } from 'node:stream';
import { EmbeddingService } from '../embeddings/embedding.service';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../storage/minio.service';
import { DocumentProcessingService } from './document-processing.service';

interface SqlQuery {
  sql: string;
  values: unknown[];
}

function createHarness(content: string) {
  let storedChunkCount = 0;
  const statusUpdates: DocumentStatus[] = [];
  const document = {
    id: 'document-1',
    knowledgeBaseId: 'kb-1',
    originalName: 'notes.txt',
    objectKey: 'workspace-1/kb-1/notes.txt',
    status: DocumentStatus.PENDING,
  };
  const prismaMock = {
    document: {
      findUnique: jest.fn().mockResolvedValue(document),
      updateMany: jest.fn(async ({ data }: { data: { status: DocumentStatus } }) => {
        statusUpdates.push(data.status);
        return { count: 1 };
      }),
    },
    chunk: {
      deleteMany: jest.fn(async () => {
        storedChunkCount = 0;
        return { count: 0 };
      }),
    },
    $executeRaw: jest.fn(async (query: SqlQuery) => {
      storedChunkCount += query.values.length / 6;
      return storedChunkCount;
    }),
  };
  const storageClient = {
    getObject: jest.fn(async () => Readable.from([Buffer.from(content)])),
  };
  const storage = {
    getClient: () => storageClient,
    getBucket: () => 'knowflow-documents',
  };
  const embeddings = new EmbeddingService();
  const service = new DocumentProcessingService(
    prismaMock as unknown as PrismaService,
    storage as unknown as MinioService,
    embeddings,
  );

  return {
    service,
    prismaMock,
    storageClient,
    statusUpdates,
    getStoredChunkCount: () => storedChunkCount,
    addStoredChunks: (count: number) => {
      storedChunkCount += count;
    },
  };
}

describe('DocumentProcessingService', () => {
  it('parses text, chunks it, persists 1536-dimension embeddings, and marks it ready', async () => {
    const content = 'KnowFlow indexes useful team knowledge for retrieval.';
    const harness = createHarness(content);
    await harness.service.process('document-1');

    expect(harness.storageClient.getObject).toHaveBeenCalledWith(
      'knowflow-documents',
      'workspace-1/kb-1/notes.txt',
    );
    expect(harness.prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
    const insert = harness.prismaMock.$executeRaw.mock.calls[0]![0] as SqlQuery;
    expect(insert.sql).toContain('INSERT INTO "Chunk"');
    expect(insert.values).toHaveLength(6);
    expect(insert.values[1]).toBe('document-1');
    expect(insert.values[2]).toBe(0);
    expect(insert.values[3]).toBe(content);
    expect(typeof insert.values[4]).toBe('string');
    expect((insert.values[4] as string).slice(1, -1).split(',')).toHaveLength(1536);
    expect(JSON.parse(insert.values[5] as string)).toEqual({ sourceName: 'notes.txt' });
    expect(harness.getStoredChunkCount()).toBe(1);
    expect(harness.statusUpdates).toEqual([DocumentStatus.PROCESSING, DocumentStatus.READY]);
    expect(harness.prismaMock.document.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'document-1' },
        data: expect.objectContaining({
          status: DocumentStatus.READY,
          processedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('marks empty or unreadable documents failed and leaves no chunks', async () => {
    const empty = createHarness(' \n  ');
    await expect(empty.service.process('document-1')).rejects.toThrow('文档中没有可索引的文本内容');
    expect(empty.statusUpdates.at(-1)).toBe(DocumentStatus.FAILED);
    expect(empty.getStoredChunkCount()).toBe(0);
    expect(empty.prismaMock.$executeRaw).not.toHaveBeenCalled();

    const unreadable = createHarness('irrelevant');
    unreadable.storageClient.getObject.mockRejectedValueOnce(new Error('MinIO read failed'));
    await expect(unreadable.service.process('document-1')).rejects.toThrow('MinIO read failed');
    expect(unreadable.statusUpdates.at(-1)).toBe(DocumentStatus.FAILED);
    expect(unreadable.getStoredChunkCount()).toBe(0);
  });

  it('cleans up chunks and marks the document failed when embedding persistence fails', async () => {
    const harness = createHarness('Persist this embedding.');
    harness.prismaMock.$executeRaw.mockRejectedValueOnce(new Error('pgvector write failed'));

    await expect(harness.service.process('document-1')).rejects.toThrow('pgvector write failed');
    expect(harness.prismaMock.chunk.deleteMany).toHaveBeenCalledTimes(2);
    expect(harness.getStoredChunkCount()).toBe(0);
    expect(harness.statusUpdates.at(-1)).toBe(DocumentStatus.FAILED);
  });

  it('removes already inserted batches when a later worker batch fails', async () => {
    const harness = createHarness('x'.repeat(209_200));
    let insertCalls = 0;
    let chunksBeforeFailure = 0;
    harness.prismaMock.$executeRaw.mockImplementation(async (statement: SqlQuery) => {
      insertCalls += 1;
      const batchSize = statement.values.length / 6;
      if (insertCalls === 2) {
        chunksBeforeFailure = harness.getStoredChunkCount();
        throw new Error('second chunk batch failed');
      }
      harness.addStoredChunks(batchSize);
      return batchSize;
    });

    await expect(harness.service.process('document-1')).rejects.toThrow(
      'second chunk batch failed',
    );
    expect(insertCalls).toBe(2);
    expect(chunksBeforeFailure).toBe(200);
    expect(harness.getStoredChunkCount()).toBe(0);
    expect(harness.statusUpdates.at(-1)).toBe(DocumentStatus.FAILED);
  });

  it('retries idempotently when final status persistence fails after 20 chunks were written', async () => {
    const harness = createHarness('x'.repeat(20_960));
    let failFirstReadyUpdate = true;
    const chunksAtReady = harness.statusUpdates;
    harness.prismaMock.document.updateMany.mockImplementation(
      async ({ data }: { data: { status: DocumentStatus } }) => {
        if (data.status === DocumentStatus.READY) {
          chunksAtReady.push(data.status);
          if (failFirstReadyUpdate) {
            failFirstReadyUpdate = false;
            expect(harness.getStoredChunkCount()).toBe(20);
            throw new Error('ready status write failed');
          }
        } else {
          chunksAtReady.push(data.status);
        }
        return { count: 1 };
      },
    );

    await expect(harness.service.process('document-1')).rejects.toThrow(
      'ready status write failed',
    );
    expect(harness.getStoredChunkCount()).toBe(0);
    expect(harness.statusUpdates.at(-1)).toBe(DocumentStatus.FAILED);

    await harness.service.process('document-1');
    expect(harness.getStoredChunkCount()).toBe(20);
    expect(harness.prismaMock.$executeRaw).toHaveBeenCalledTimes(2);
    expect(chunksAtReady.filter((status) => status === DocumentStatus.READY)).toHaveLength(2);
  });
});
