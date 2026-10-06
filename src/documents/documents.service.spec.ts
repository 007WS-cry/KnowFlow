import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../storage/minio.service';
import { QueueService } from '../queue/queue.service';
import { KnowledgeBasesService } from '../knowledge-bases/knowledge-bases.service';
import { DocumentsService } from './documents.service';

describe('DocumentsService direct-to-MinIO upload workflow', () => {
  const now = new Date();
  const document = {
    id: 'document-1',
    knowledgeBaseId: 'kb-1',
    uploadedByUserId: 'user-1',
    originalName: 'notes.md',
    mimeType: 'text/markdown',
    objectKey: 'workspace-1/kb-1/object/notes.md',
    sizeBytes: BigInt(5),
    status: 'PENDING',
    processingStage: 'UPLOAD',
    progress: 0,
    retryCount: 0,
    multipartUploadId: 'multipart-1',
    errorMessage: null,
    processedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const config = {
    get: jest.fn((key: string, fallback: unknown) => fallback),
  };
  const prismaMock = {
    document: {
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...document,
        ...data,
      })),
      findUnique: jest.fn().mockResolvedValue(document),
      findMany: jest.fn(),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...document,
        ...data,
      })),
    },
    $transaction: jest.fn(),
  };
  const storageClient = {
    statObject: jest.fn().mockResolvedValue({ size: 5 }),
    getPartialObject: jest.fn().mockResolvedValue(
      (async function* () {
        yield Buffer.from('test');
      })(),
    ),
    removeObject: jest.fn().mockResolvedValue(undefined),
  };
  const storage = {
    getClient: () => storageClient,
    getBucket: () => 'knowflow-documents',
    signSingleUpload: jest.fn().mockResolvedValue('https://minio.test/signed-put'),
    initiateMultipart: jest.fn().mockResolvedValue('multipart-1'),
    signMultipartPart: jest.fn().mockResolvedValue('https://minio.test/signed-part'),
    completeMultipart: jest.fn().mockResolvedValue({ etag: 'done' }),
    listMultipartParts: jest.fn().mockResolvedValue([]),
    abortMultipart: jest.fn().mockResolvedValue(undefined),
  };
  const queue = { enqueueDocumentProcessing: jest.fn().mockResolvedValue('job-1') };
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
    config.get.mockImplementation((_key: string, fallback: unknown) => fallback);
    prismaMock.document.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...document,
        ...data,
      }),
    );
    prismaMock.document.findUnique.mockResolvedValue(document);
    prismaMock.document.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({ ...document, ...data }),
    );
    storageClient.statObject.mockResolvedValue({ size: 5 });
    storage.signSingleUpload.mockResolvedValue('https://minio.test/signed-put');
    storage.initiateMultipart.mockResolvedValue('multipart-1');
    queue.enqueueDocumentProcessing.mockResolvedValue('job-1');
    knowledgeBases.getById.mockResolvedValue({ id: 'kb-1', workspaceId: 'workspace-1' });
  });

  it('creates a small-file upload task and returns a signed URL without passing bytes through the API', async () => {
    const result = await service.createUploadTask('user-1', 'kb-1', {
      originalName: 'notes.md',
      sizeBytes: 5,
    });
    expect(storage.signSingleUpload).toHaveBeenCalledWith(
      expect.stringMatching(/^workspace-1\/kb-1\//),
      3600,
    );
    expect(storageClient).not.toHaveProperty('putObject');
    expect(result).toMatchObject({
      uploadMode: 'single',
      uploadUrl: 'https://minio.test/signed-put',
      document: { id: 'document-1', status: 'PENDING', processingStage: 'UPLOAD', sizeBytes: 5 },
    });
  });

  it('uses Multipart Upload for large files and signs requested parts', async () => {
    const result = await service.createUploadTask('user-1', 'kb-1', {
      originalName: 'large.txt',
      sizeBytes: 40 * 1024 * 1024,
    });
    expect(result).toMatchObject({
      uploadMode: 'multipart',
      partSizeBytes: 16 * 1024 * 1024,
      partCount: 3,
    });
    prismaMock.document.findUnique.mockResolvedValueOnce({
      ...document,
      sizeBytes: BigInt(40 * 1024 * 1024),
    });
    await expect(service.getPartUploadUrl('document-1', 2)).resolves.toEqual({
      partNumber: 2,
      uploadUrl: 'https://minio.test/signed-part',
    });
    expect(storage.signMultipartPart).toHaveBeenCalledWith(document.objectKey, 'multipart-1', 2);
  });

  it('completes all declared parts, verifies MinIO size, and enqueues the worker', async () => {
    prismaMock.document.findUnique.mockResolvedValueOnce({
      ...document,
      sizeBytes: BigInt(5),
      multipartUploadId: null,
    });
    storageClient.statObject.mockResolvedValueOnce({ size: 5 });
    const result = await service.completeUpload('document-1');
    expect(prismaMock.document.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'document-1' },
        data: expect.objectContaining({ processingStage: 'QUEUED', progress: 2 }),
      }),
    );
    expect(queue.enqueueDocumentProcessing).toHaveBeenCalledWith('document-1', 0);
    expect(result).toMatchObject({ jobId: 'job-1' });
  });

  it('rejects unsupported and oversized files before creating a task', async () => {
    await expect(
      service.createUploadTask('user-1', 'kb-1', { originalName: 'script.exe', sizeBytes: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    config.get.mockImplementation((key: string, fallback: unknown) =>
      key === 'MAX_UPLOAD_BYTES' ? 20 : fallback,
    );
    await expect(
      service.createUploadTask('user-1', 'kb-1', { originalName: 'large.txt', sizeBytes: 21 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prismaMock.document.create).not.toHaveBeenCalled();
  });

  it('rejects a Multipart Upload without all server-confirmed parts', async () => {
    prismaMock.document.findUnique.mockResolvedValueOnce({
      ...document,
      sizeBytes: BigInt(40 * 1024 * 1024),
      multipartUploadId: 'multipart-1',
    });
    storage.listMultipartParts.mockResolvedValueOnce([
      { part: 1, etag: 'etag-1', size: 16 * 1024 * 1024 },
    ]);
    await expect(service.completeUpload('document-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.completeMultipart).not.toHaveBeenCalled();
  });

  it('rejects completing an upload task more than once', async () => {
    prismaMock.document.findUnique.mockResolvedValueOnce({
      ...document,
      processingStage: 'QUEUED',
    });
    await expect(service.completeUpload('document-1')).rejects.toBeInstanceOf(ConflictException);
  });
});
