import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../storage/minio.service';
import { QueueService } from '../queue/queue.service';
import { KnowledgeBasesService } from '../knowledge-bases/knowledge-bases.service';
import { UploadedFile } from './uploaded-file';
import { DocumentsService } from './documents.service';

describe('DocumentsService upload pipeline', () => {
  const file = (originalname = 'notes.txt', content = 'KnowFlow notes'): UploadedFile => {
    const buffer = Buffer.from(content);
    return { originalname, size: buffer.length, buffer };
  };

  const document = {
    id: 'document-1',
    knowledgeBaseId: 'kb-1',
    uploadedByUserId: 'user-1',
    originalName: 'notes.txt',
    mimeType: 'text/plain',
    objectKey: 'workspace-1/kb-1/object/notes.txt',
    sizeBytes: BigInt(Buffer.byteLength('KnowFlow notes')),
    status: 'PENDING',
    errorMessage: null,
    processedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const events: string[] = [];
  const transaction = {
    document: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push('database');
        return { ...document, ...data };
      }),
    },
    knowledgeBase: { update: jest.fn().mockResolvedValue({}) },
  };
  const prismaMock = {
    $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) => callback(transaction)),
    document: { update: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  };
  const storageClient = {
    putObject: jest.fn(
      async (
        _bucket: string,
        _objectKey: string,
        _buffer: Buffer,
        _size: number,
        _metadata: Record<string, string>,
      ) => {
        events.push('minio');
        return { etag: 'etag' };
      },
    ),
    removeObject: jest.fn().mockResolvedValue(undefined),
  };
  const storage = {
    getClient: () => storageClient,
    getBucket: () => 'knowflow-documents',
  };
  const config = { get: jest.fn((_key: string, fallback: string) => fallback) };
  const queue = {
    enqueueDocumentProcessing: jest.fn(async () => {
      events.push('queue');
      return 'job-document-1';
    }),
  };
  const knowledgeBases = {
    getById: jest.fn().mockResolvedValue({ id: 'kb-1', workspaceId: 'workspace-1' }),
  };
  const service = new DocumentsService(
    prismaMock as unknown as PrismaService,
    config as unknown as ConfigService,
    storage as unknown as MinioService,
    queue as unknown as QueueService,
    knowledgeBases as unknown as KnowledgeBasesService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    events.length = 0;
    prismaMock.$transaction.mockImplementation((callback: (tx: typeof transaction) => unknown) =>
      callback(transaction),
    );
    transaction.document.create.mockImplementation(async ({ data }) => {
      events.push('database');
      return { ...document, ...data };
    });
    storageClient.putObject.mockImplementation(async () => {
      events.push('minio');
      return { etag: 'etag' };
    });
    queue.enqueueDocumentProcessing.mockImplementation(async () => {
      events.push('queue');
      return 'job-document-1';
    });
    knowledgeBases.getById.mockResolvedValue({ id: 'kb-1', workspaceId: 'workspace-1' });
  });

  it('stores a supported file, creates its DB record, then enqueues processing', async () => {
    const payload = file();
    const result = await service.upload('user-1', 'kb-1', payload);

    expect(events).toEqual(['minio', 'database', 'queue']);
    expect(storageClient.putObject).toHaveBeenCalledWith(
      'knowflow-documents',
      expect.stringMatching(/^workspace-1\/kb-1\//),
      payload.buffer,
      payload.size,
      { 'Content-Type': 'text/plain' },
    );
    const createdRecord = transaction.document.create.mock.calls[0]![0].data;
    expect(createdRecord).toEqual(
      expect.objectContaining({
        knowledgeBaseId: 'kb-1',
        uploadedByUserId: 'user-1',
        originalName: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: BigInt(payload.size),
      }),
    );
    expect(createdRecord.objectKey).toBe(storageClient.putObject.mock.calls[0]![1]);
    expect(queue.enqueueDocumentProcessing).toHaveBeenCalledWith('document-1');
    expect(result).toMatchObject({ id: 'document-1', status: 'PENDING', jobId: 'job-document-1' });
    expect(result.sizeBytes).toBe(payload.size);
  });

  it('rejects unsupported and oversized files before writing to MinIO', async () => {
    await expect(service.upload('user-1', 'kb-1', file('script.exe'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.upload('user-1', 'kb-1', {
        originalname: 'large.txt',
        size: 10 * 1024 * 1024 + 1,
        buffer: Buffer.alloc(1),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(storageClient.putObject).not.toHaveBeenCalled();
    expect(transaction.document.create).not.toHaveBeenCalled();
    expect(queue.enqueueDocumentProcessing).not.toHaveBeenCalled();
  });

  it('returns repaired Chinese filenames for documents uploaded before the UTF-8 fix', async () => {
    const filename = '研发部门信息安全与代码管理规范.md';
    const mojibake = Buffer.from(filename, 'utf8').toString('latin1');
    prismaMock.document.findMany.mockResolvedValueOnce([
      {
        id: 'document-legacy',
        originalName: mojibake,
        mimeType: 'text/markdown',
        sizeBytes: BigInt(42),
        status: 'READY',
        errorMessage: null,
        processedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const result = await service.list('kb-1');

    expect(result[0]).toMatchObject({
      id: 'document-legacy',
      originalName: filename,
      sizeBytes: 42,
    });
  });

  it('does not create a DB record or queue job when MinIO write fails', async () => {
    storageClient.putObject.mockRejectedValueOnce(new Error('MinIO unavailable'));
    await expect(service.upload('user-1', 'kb-1', file())).rejects.toThrow('MinIO unavailable');
    expect(transaction.document.create).not.toHaveBeenCalled();
    expect(queue.enqueueDocumentProcessing).not.toHaveBeenCalled();
  });

  it('removes the uploaded object if creating the DB record fails', async () => {
    prismaMock.$transaction.mockImplementationOnce(async () => {
      throw new Error('database unavailable');
    });
    await expect(service.upload('user-1', 'kb-1', file())).rejects.toThrow('database unavailable');
    expect(storageClient.putObject).toHaveBeenCalledTimes(1);
    expect(storageClient.removeObject).toHaveBeenCalledWith(
      'knowflow-documents',
      storageClient.putObject.mock.calls[0]![1],
    );
    expect(queue.enqueueDocumentProcessing).not.toHaveBeenCalled();
  });
});
