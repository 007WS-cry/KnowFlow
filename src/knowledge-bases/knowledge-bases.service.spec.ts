import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../storage/minio.service';
import { QueueService } from '../queue/queue.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { KnowledgeBasesController } from './knowledge-bases.controller';
import { KnowledgeBasesService } from './knowledge-bases.service';

describe('KnowledgeBasesService', () => {
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
  const workspacesMock = { assertMember: jest.fn().mockResolvedValue({ id: 'workspace-1' }) };
  const removeObject = jest.fn().mockResolvedValue(undefined);
  const cancelDocumentProcessing = jest.fn().mockResolvedValue(undefined);
  const service = new KnowledgeBasesService(
    prismaMock as unknown as PrismaService,
    workspacesMock as unknown as WorkspacesService,
    {
      getClient: () => ({ removeObject }),
      getBucket: () => 'knowflow-documents',
    } as unknown as MinioService,
    { cancelDocumentProcessing } as unknown as QueueService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    workspacesMock.assertMember.mockResolvedValue({ id: 'workspace-1' });
    prismaMock.knowledgeBase.findMany.mockResolvedValue([]);
    prismaMock.knowledgeBase.create.mockResolvedValue(knowledgeBase);
    prismaMock.knowledgeBase.findUnique.mockResolvedValue(knowledgeBase);
    prismaMock.knowledgeBase.update.mockResolvedValue({ ...knowledgeBase, name: 'Updated' });
    prismaMock.knowledgeBase.delete.mockResolvedValue(knowledgeBase);
    prismaMock.document.findMany.mockResolvedValue([]);
  });

  it('lists an empty knowledge base collection and creates under a member workspace', async () => {
    await expect(service.listForWorkspace('user-1', 'workspace-1')).resolves.toEqual([]);
    expect(prismaMock.knowledgeBase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'workspace-1' } }),
    );
    await expect(service.create('user-1', 'workspace-1', ' Handbook ', ' Notes ')).resolves.toEqual(
      knowledgeBase,
    );
    expect(prismaMock.knowledgeBase.create).toHaveBeenCalledWith({
      data: { workspaceId: 'workspace-1', name: 'Handbook', description: 'Notes' },
      include: { _count: { select: { documents: true } } },
    });
  });

  it('returns not found for an inaccessible knowledge base and prevents mutation', async () => {
    prismaMock.knowledgeBase.findUnique.mockResolvedValueOnce(knowledgeBase);
    workspacesMock.assertMember.mockRejectedValueOnce(new NotFoundException());
    await expect(service.update('other-user', 'kb-1', { name: 'Stolen' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prismaMock.knowledgeBase.update).not.toHaveBeenCalled();

    prismaMock.knowledgeBase.findUnique.mockResolvedValueOnce(null);
    await expect(service.getAccessible('user-1', 'missing-kb')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('updates optional fields and translates duplicate names into a conflict', async () => {
    await service.update('user-1', 'kb-1', { description: ' Updated description ' });
    expect(prismaMock.knowledgeBase.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { description: 'Updated description' } }),
    );

    prismaMock.knowledgeBase.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(service.update('user-1', 'kb-1', { name: 'Handbook' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('deletes a knowledge base and its document objects only after access is confirmed', async () => {
    prismaMock.document.findMany.mockResolvedValue([
      { id: 'doc-1', objectKey: 'workspace/kb/doc-1' },
    ]);
    await expect(service.delete('user-1', 'kb-1')).resolves.toEqual({
      success: true,
      id: 'kb-1',
    });
    expect(cancelDocumentProcessing).toHaveBeenCalledWith('doc-1');
    expect(removeObject).toHaveBeenCalledWith('knowflow-documents', 'workspace/kb/doc-1');
    expect(prismaMock.knowledgeBase.delete).toHaveBeenCalledWith({ where: { id: 'kb-1' } });

    prismaMock.knowledgeBase.findUnique.mockResolvedValueOnce(knowledgeBase);
    workspacesMock.assertMember.mockRejectedValueOnce(new NotFoundException());
    await expect(service.delete('other-user', 'kb-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prismaMock.knowledgeBase.delete).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty knowledge base update request', () => {
    const controller = new KnowledgeBasesController(service);
    expect(() =>
      controller.update({ id: 'user-1', email: 'user@example.com', name: null }, 'kb-1', {}),
    ).toThrow(BadRequestException);
  });
});
