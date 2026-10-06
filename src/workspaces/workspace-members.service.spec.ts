import { ForbiddenException } from '@nestjs/common';
import { WorkspaceInvitationStatus, WorkspaceRole } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceMembersService } from './workspace-members.service';

describe('WorkspaceMembersService', () => {
  const tx = {
    $queryRaw: jest.fn(),
    user: { findUnique: jest.fn() },
    workspaceMember: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    workspaceInvitation: { upsert: jest.fn(), updateMany: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((callback: (transaction: typeof tx) => unknown) => callback(tx)),
    workspaceInvitation: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    workspaceMember: { updateMany: jest.fn(), deleteMany: jest.fn() },
  };
  const service = new WorkspaceMembersService(prisma as unknown as PrismaService);
  const invitation = {
    id: 'invitation-1',
    email: 'member@example.test',
    role: WorkspaceRole.MEMBER,
    workspaceId: 'workspace-1',
    status: WorkspaceInvitationStatus.PENDING,
    expiresAt: new Date(Date.now() + 60_000),
    workspace: { id: 'workspace-1', name: 'Team' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((callback: (transaction: typeof tx) => unknown) =>
      callback(tx),
    );
    tx.$queryRaw.mockResolvedValue([]);
    tx.user.findUnique.mockResolvedValue(null);
    tx.workspaceMember.findUnique.mockResolvedValue(null);
    tx.workspaceInvitation.upsert.mockResolvedValue({});
    tx.workspaceInvitation.updateMany.mockResolvedValue({ count: 1 });
    tx.workspaceMember.create.mockResolvedValue({});
  });

  it('creates a seven-day email-bound invitation and stores only its token hash', async () => {
    const before = Date.now();
    const result = await service.invite(
      'workspace-1',
      'owner-1',
      'Member@Example.Test',
      WorkspaceRole.ADMIN,
    );

    expect(result.email).toBe('member@example.test');
    expect(result.role).toBe(WorkspaceRole.ADMIN);
    expect(result.invitationToken).toHaveLength(43);
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 7 * 24 * 60 * 60 * 1000);
    const upsert = tx.workspaceInvitation.upsert.mock.calls[0]![0];
    expect(upsert.create).toEqual(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        email: 'member@example.test',
        role: WorkspaceRole.ADMIN,
        invitedByUserId: 'owner-1',
        status: WorkspaceInvitationStatus.PENDING,
        tokenHash: createHash('sha256').update(result.invitationToken).digest('hex'),
      }),
    );
    expect(upsert.create.tokenHash).not.toBe(result.invitationToken);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('rejects acceptance from an email other than the invited email', async () => {
    prisma.workspaceInvitation.findUnique.mockResolvedValue(invitation);
    await expect(
      service.acceptInvitation('user-1', 'wrong@example.test', 'valid-token'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepts a matching invitation once and creates the requested membership role', async () => {
    prisma.workspaceInvitation.findUnique.mockResolvedValue(invitation);
    const result = await service.acceptInvitation('user-1', 'MEMBER@example.test', 'valid-token');

    expect(result).toEqual({ workspace: invitation.workspace, role: WorkspaceRole.MEMBER });
    expect(tx.workspaceInvitation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'invitation-1',
          tokenHash: createHash('sha256').update('valid-token').digest('hex'),
          status: WorkspaceInvitationStatus.PENDING,
        }),
      }),
    );
    expect(tx.workspaceMember.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        role: WorkspaceRole.MEMBER,
      },
    });
  });

  it('does not return invitation token hashes in the pending-invitation listing', async () => {
    prisma.workspaceInvitation.findMany.mockResolvedValue([
      { ...invitation, tokenHash: 'secret-hash', invitedBy: null },
    ]);
    const result = await service.listInvitations('workspace-1');
    expect(result[0]).not.toHaveProperty('tokenHash');
    expect(prisma.workspaceInvitation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: 'workspace-1',
          status: WorkspaceInvitationStatus.PENDING,
        }),
      }),
    );
  });
});
