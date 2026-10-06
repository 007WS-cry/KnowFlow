import { BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../storage/minio.service';
import { QueueService } from '../queue/queue.service';
import { KnowledgeBasesController } from './knowledge-bases.controller';
import { KnowledgeBasesService } from './knowledge-bases.service';

describe('KnowledgeBasesService persistence operations', () => {
  const knowledgeBase = {
    id: 'kb-1',
    workspaceId: 'workspace-1',
    name: 'Handbook',
    description: null,
    _count: { documents: 0 },
  };
  const prismaMock = {
    knowledgeBase: {
      findMany: jest.fn(),
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    document: { findMany: jest.fn() },
  };
  const removeObject = jest.fn().mockResolvedValue(undefined);
  const cancelDocumentProcessing = jest.fn().mockResolvedValue(undefined);
  const service = new KnowledgeBasesService(
    prismaMock as unknown as PrismaService,
    {
      getClient: () => ({ removeObject }),
      getBucket: () => 'knowflow-documents',
    } as unknown as MinioService,
    { cancelDocumentProcessing } as unknown as QueueService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.knowledgeBase.findMany.mockResolvedValue([]);
    prismaMock.knowledgeBase.create.mockResolvedValue(knowledgeBase);
    prismaMock.knowledgeBase.findUnique.mockResolvedValue(knowledgeBase);
    prismaMock.knowledgeBase.update.mockResolvedValue({ ...knowledgeBase, name: 'Updated' });
    prismaMock.knowledgeBase.delete.mockResolvedValue(knowledgeBase);
    prismaMock.document.findMany.mockResolvedValue([]);
  });

  it('lists and creates knowledge bases under a workspace', async () => {
    await expect(service.listForWorkspace('workspace-1')).resolves.toEqual([]);
    expect(prismaMock.knowledgeBase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'workspace-1' } }),
    );
    await expect(service.create('workspace-1', ' Handbook ', ' Notes ')).resolves.toEqual(
      knowledgeBase,
    );
    expect(prismaMock.knowledgeBase.create).toHaveBeenCalledWith({
      data: { workspaceId: 'workspace-1', name: 'Handbook', description: 'Notes' },
      include: { _count: { select: { documents: true } } },
    });
  });

  it('returns not found for a missing knowledge base', async () => {
    prismaMock.knowledgeBase.findUnique.mockResolvedValueOnce(null);
    await expect(service.getById('missing-kb')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates optional fields and translates duplicate names into a conflict', async () => {
    await service.update('kb-1', { description: ' Updated description ' });
    expect(prismaMock.knowledgeBase.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { description: 'Updated description' } }),
    );

    prismaMock.knowledgeBase.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(service.update('kb-1', { name: 'Handbook' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('deletes a knowledge base and its document objects after the policy guard authorizes it', async () => {
    prismaMock.document.findMany.mockResolvedValue([
      { id: 'doc-1', objectKey: 'workspace/kb/doc-1' },
    ]);
    await expect(service.delete('kb-1')).resolves.toEqual({
      success: true,
      id: 'kb-1',
    });
    expect(cancelDocumentProcessing).toHaveBeenCalledWith('doc-1');
    expect(removeObject).toHaveBeenCalledWith('knowflow-documents', 'workspace/kb/doc-1');
    expect(prismaMock.knowledgeBase.delete).toHaveBeenCalledWith({ where: { id: 'kb-1' } });
  });

  it('rejects an empty knowledge base update request', () => {
    const controller = new KnowledgeBasesController(service);
    expect(() => controller.update('kb-1', {})).toThrow(BadRequestException);
  });
});
