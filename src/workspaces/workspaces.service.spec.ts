import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../storage/minio.service';
import { QueueService } from '../queue/queue.service';
import { WorkspacesService } from './workspaces.service';

describe('WorkspacesService', () => {
  const workspace = {
    id: 'workspace-1',
    name: 'Team',
    slug: 'team-123456',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const transaction = {
    workspace: { create: jest.fn().mockResolvedValue(workspace) },
    workspaceMember: { create: jest.fn().mockResolvedValue({ role: 'OWNER' }) },
  };
  const prismaMock = {
    $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) => callback(transaction)),
    workspaceMember: { findMany: jest.fn(), findUnique: jest.fn() },
    workspace: { update: jest.fn(), delete: jest.fn() },
    document: { findMany: jest.fn() },
  };
  const removeObject = jest.fn().mockResolvedValue(undefined);
  const cancelDocumentProcessing = jest.fn().mockResolvedValue(undefined);
  const storage = {
    getClient: () => ({ removeObject }),
    getBucket: () => 'knowflow-documents',
  };
  const queue = { cancelDocumentProcessing };
  const service = new WorkspacesService(
    prismaMock as unknown as PrismaService,
    storage as unknown as MinioService,
    queue as unknown as QueueService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.$transaction.mockImplementation((callback: (tx: typeof transaction) => unknown) =>
      callback(transaction),
    );
    prismaMock.workspaceMember.findUnique.mockResolvedValue({ role: 'OWNER', workspace });
    prismaMock.workspace.update.mockResolvedValue({ ...workspace, name: 'Updated' });
    prismaMock.workspace.delete.mockResolvedValue(workspace);
    prismaMock.document.findMany.mockResolvedValue([]);
  });

  it('creates and lists only workspaces joined by the user', async () => {
    await expect(service.create('user-1', ' Team ')).resolves.toMatchObject({ role: 'OWNER' });
    expect(transaction.workspace.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'Team' }),
    });
    expect(transaction.workspaceMember.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user-1', role: 'OWNER' }),
    });

    prismaMock.workspaceMember.findMany.mockResolvedValue([
      { workspace, role: 'OWNER', createdAt: new Date() },
    ]);
    await expect(service.listForUser('user-1')).resolves.toHaveLength(1);
    expect(prismaMock.workspaceMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
  });

  it('gets and updates only an owned workspace', async () => {
    await expect(service.getForUser('user-1', workspace.id)).resolves.toMatchObject({
      id: workspace.id,
      role: 'OWNER',
    });
    await expect(service.update('user-1', workspace.id, ' Updated ')).resolves.toMatchObject({
      name: 'Updated',
      role: 'OWNER',
    });
    expect(prismaMock.workspace.update).toHaveBeenCalledWith({
      where: { id: workspace.id },
      data: { name: 'Updated' },
    });

    prismaMock.workspaceMember.findUnique.mockResolvedValueOnce(null);
    await expect(service.update('other-user', workspace.id, 'No access')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prismaMock.workspace.update).toHaveBeenCalledTimes(1);
  });

  it('allows only the owner to delete and cleans associated objects and jobs', async () => {
    prismaMock.document.findMany.mockResolvedValue([
      { id: 'doc-1', objectKey: 'workspace/kb/doc-1' },
      { id: 'doc-2', objectKey: 'workspace/kb/doc-2' },
    ]);
    await expect(service.delete('user-1', workspace.id)).resolves.toEqual({
      success: true,
      id: workspace.id,
    });
    expect(cancelDocumentProcessing).toHaveBeenCalledTimes(2);
    expect(removeObject).toHaveBeenCalledTimes(2);
    expect(prismaMock.workspace.delete).toHaveBeenCalledWith({ where: { id: workspace.id } });

    prismaMock.workspaceMember.findUnique.mockResolvedValueOnce({ role: 'MEMBER', workspace });
    await expect(service.delete('member-1', workspace.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prismaMock.workspace.delete).toHaveBeenCalledTimes(1);
  });
});
