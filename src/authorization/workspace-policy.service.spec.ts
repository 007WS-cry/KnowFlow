import { ForbiddenException } from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspacePolicyService } from './workspace-policy.service';

describe('WorkspacePolicyService role matrix', () => {
  const prisma = {
    workspace: { findUnique: jest.fn() },
    workspaceMember: { findUnique: jest.fn() },
    workspaceInvitation: { findFirst: jest.fn() },
    document: { findMany: jest.fn(), findUnique: jest.fn() },
  };
  const policy = new WorkspacePolicyService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.workspace.findUnique.mockResolvedValue({ id: 'workspace-1' });
    prisma.workspaceMember.findUnique.mockResolvedValue({ role: WorkspaceRole.MEMBER });
    prisma.workspaceInvitation.findFirst.mockResolvedValue({
      id: 'invite-1',
      role: WorkspaceRole.MEMBER,
      status: 'PENDING',
    });
    prisma.document.findMany.mockResolvedValue([{ id: 'doc-1', uploadedByUserId: 'user-1' }]);
    prisma.document.findUnique.mockResolvedValue({ uploadedByUserId: 'user-1' });
  });

  async function authorize(
    role: WorkspaceRole,
    action: Parameters<WorkspacePolicyService['authorize']>[1],
    userId = 'user-1',
    params: Record<string, string> = {},
    body: Record<string, unknown> = {},
  ) {
    prisma.workspaceMember.findUnique.mockResolvedValueOnce({ role });
    return policy.authorize(userId, action, 'workspace-1', { params, body });
  }

  it.each([
    ['MEMBER', 'WORKSPACE_VIEW', {}],
    ['MEMBER', 'KNOWLEDGE_BASE_VIEW', {}],
    ['MEMBER', 'DOCUMENT_VIEW', {}],
    ['MEMBER', 'DOCUMENT_UPLOAD', {}],
    ['MEMBER', 'DOCUMENT_PROCESS', { documentId: 'doc-1' }],
    ['ADMIN', 'KNOWLEDGE_BASE_MANAGE', {}],
    ['OWNER', 'KNOWLEDGE_BASE_MANAGE', {}],
    ['OWNER', 'WORKSPACE_UPDATE', {}],
    ['OWNER', 'WORKSPACE_DELETE', {}],
  ] as const)('allows %s to perform %s', async (role, action, params) => {
    await expect(authorize(WorkspaceRole[role], action, 'user-1', params)).resolves.toMatchObject({
      workspaceId: 'workspace-1',
      role: WorkspaceRole[role],
    });
  });

  it.each([
    ['MEMBER', 'KNOWLEDGE_BASE_MANAGE'],
    ['MEMBER', 'WORKSPACE_UPDATE'],
    ['MEMBER', 'MEMBER_INVITE'],
    ['ADMIN', 'WORKSPACE_DELETE'],
    ['ADMIN', 'MEMBER_ROLE_UPDATE'],
  ] as const)('denies %s from performing %s', async (role, action) => {
    await expect(
      authorize(
        WorkspaceRole[role],
        action,
        'user-1',
        { memberUserId: 'user-2' },
        { role: 'MEMBER' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows ADMIN to invite MEMBER but prevents promoting through the invite endpoint', async () => {
    await expect(
      authorize(WorkspaceRole.ADMIN, 'MEMBER_INVITE', 'user-1', {}, { role: 'MEMBER' }),
    ).resolves.toMatchObject({ role: WorkspaceRole.ADMIN });
    await expect(
      authorize(WorkspaceRole.ADMIN, 'MEMBER_INVITE', 'user-1', {}, { role: 'ADMIN' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      authorize(WorkspaceRole.OWNER, 'MEMBER_INVITE', 'user-1', {}, { role: 'ADMIN' }),
    ).resolves.toMatchObject({ role: WorkspaceRole.OWNER });
  });

  it('allows OWNER to change member roles and ADMIN to remove MEMBER', async () => {
    await expect(
      authorize(
        WorkspaceRole.OWNER,
        'MEMBER_ROLE_UPDATE',
        'owner-1',
        { memberUserId: 'member-1' },
        { role: 'ADMIN' },
      ),
    ).resolves.toMatchObject({ role: WorkspaceRole.OWNER });
    await expect(
      authorize(WorkspaceRole.ADMIN, 'MEMBER_REMOVE', 'admin-1', { memberUserId: 'member-1' }),
    ).resolves.toMatchObject({ role: WorkspaceRole.ADMIN });
  });

  it('allows MEMBER to delete own documents but rejects any document uploaded by someone else', async () => {
    await expect(
      authorize(
        WorkspaceRole.MEMBER,
        'DOCUMENT_DELETE',
        'user-1',
        { knowledgeBaseId: 'kb-1' },
        { documentIds: ['doc-1'] },
      ),
    ).resolves.toMatchObject({ role: WorkspaceRole.MEMBER });

    prisma.document.findMany.mockResolvedValueOnce([
      { id: 'doc-1', uploadedByUserId: 'someone-else' },
    ]);
    await expect(
      authorize(
        WorkspaceRole.MEMBER,
        'DOCUMENT_DELETE',
        'user-1',
        { knowledgeBaseId: 'kb-1' },
        { documentIds: ['doc-1'] },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('prevents ADMIN from removing OWNER or another ADMIN, and from changing membership roles', async () => {
    prisma.workspaceMember.findUnique
      .mockResolvedValueOnce({ role: WorkspaceRole.ADMIN })
      .mockResolvedValueOnce({ role: WorkspaceRole.OWNER });
    await expect(
      policy.authorize('admin-1', 'MEMBER_REMOVE', 'workspace-1', {
        params: { memberUserId: 'owner-1' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    prisma.workspaceMember.findUnique
      .mockResolvedValueOnce({ role: WorkspaceRole.ADMIN })
      .mockResolvedValueOnce({ role: WorkspaceRole.ADMIN });
    await expect(
      policy.authorize('admin-1', 'MEMBER_REMOVE', 'workspace-1', {
        params: { memberUserId: 'other-admin' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workspaceMember.findUnique).toHaveBeenCalledTimes(4);
  });
});
