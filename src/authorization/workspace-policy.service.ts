import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceAction } from './workspace-permissions';

export interface WorkspaceAuthorizationContext {
  workspaceId: string;
  role: WorkspaceRole;
}

export interface WorkspacePolicyRequest {
  params: Record<string, string | undefined>;
  body?: Record<string, unknown>;
  workspaceAuthorization?: WorkspaceAuthorizationContext;
}

@Injectable()
export class WorkspacePolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async authorize(
    userId: string,
    action: WorkspaceAction,
    workspaceId: string,
    request: WorkspacePolicyRequest,
  ): Promise<WorkspaceAuthorizationContext> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    });
    if (!workspace) throw new NotFoundException('Workspace 不存在');

    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!membership) throw new NotFoundException('Workspace 不存在');

    const context = { workspaceId, role: membership.role };
    await this.assertAllowed(userId, action, context, request);
    request.workspaceAuthorization = context;
    return context;
  }

  private async assertAllowed(
    userId: string,
    action: WorkspaceAction,
    context: WorkspaceAuthorizationContext,
    request: WorkspacePolicyRequest,
  ): Promise<void> {
    const { role, workspaceId } = context;
    switch (action) {
      case 'WORKSPACE_VIEW':
      case 'KNOWLEDGE_BASE_VIEW':
      case 'DOCUMENT_VIEW':
      case 'DOCUMENT_UPLOAD':
      case 'MEMBER_LIST':
        return;

      case 'WORKSPACE_UPDATE':
      case 'WORKSPACE_DELETE':
        if (role === WorkspaceRole.OWNER) return;
        throw new ForbiddenException('只有 OWNER 可以管理或删除 Workspace');

      case 'KNOWLEDGE_BASE_MANAGE':
        if (role === WorkspaceRole.OWNER || role === WorkspaceRole.ADMIN) return;
        throw new ForbiddenException('只有 ADMIN 或 OWNER 可以管理知识库');

      case 'MEMBER_INVITE': {
        const invitedRole = this.roleFromBody(request, 'role', WorkspaceRole.MEMBER);
        if (invitedRole === WorkspaceRole.OWNER) {
          throw new BadRequestException('不能通过邀请创建 OWNER');
        }
        if (role === WorkspaceRole.OWNER) return;
        if (role === WorkspaceRole.ADMIN && invitedRole === WorkspaceRole.MEMBER) return;
        throw new ForbiddenException('ADMIN 只能邀请 MEMBER，邀请 ADMIN 需要 OWNER');
      }

      case 'INVITATION_LIST':
        if (role === WorkspaceRole.OWNER || role === WorkspaceRole.ADMIN) return;
        throw new ForbiddenException('只有 ADMIN 或 OWNER 可以查看待处理邀请');

      case 'INVITATION_REVOKE':
        return this.assertCanRevokeInvitation(role, workspaceId, request);

      case 'MEMBER_REMOVE':
        return this.assertCanRemoveMember(userId, role, workspaceId, request);

      case 'MEMBER_ROLE_UPDATE':
        return this.assertCanUpdateMemberRole(userId, role, workspaceId, request);

      case 'DOCUMENT_DELETE':
        return this.assertCanDeleteDocuments(userId, role, workspaceId, request);
    }
  }

  private async assertCanRevokeInvitation(
    actorRole: WorkspaceRole,
    workspaceId: string,
    request: WorkspacePolicyRequest,
  ): Promise<void> {
    if (actorRole !== WorkspaceRole.OWNER && actorRole !== WorkspaceRole.ADMIN) {
      throw new ForbiddenException('只有 ADMIN 或 OWNER 可以撤销邀请');
    }
    const invitationId = this.param(request, 'invitationId');
    const invitation = await this.prisma.workspaceInvitation.findFirst({
      where: { id: invitationId, workspaceId },
      select: { id: true, role: true, status: true },
    });
    if (!invitation) throw new NotFoundException('邀请不存在');
    if (invitation.status !== 'PENDING') {
      throw new BadRequestException('只有待处理邀请可以撤销');
    }
    if (actorRole === WorkspaceRole.ADMIN && invitation.role !== WorkspaceRole.MEMBER) {
      throw new ForbiddenException('ADMIN 只能撤销 MEMBER 邀请');
    }
  }

  private async assertCanRemoveMember(
    userId: string,
    actorRole: WorkspaceRole,
    workspaceId: string,
    request: WorkspacePolicyRequest,
  ): Promise<void> {
    if (actorRole !== WorkspaceRole.OWNER && actorRole !== WorkspaceRole.ADMIN) {
      throw new ForbiddenException('只有 ADMIN 或 OWNER 可以移除成员');
    }
    const targetUserId = this.param(request, 'memberUserId');
    if (targetUserId === userId) throw new ForbiddenException('不能通过成员管理移除自己');
    const target = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      select: { role: true },
    });
    if (!target) throw new NotFoundException('Workspace 成员不存在');
    if (target.role === WorkspaceRole.OWNER) {
      throw new ForbiddenException('不能移除 Workspace 的 OWNER');
    }
    if (actorRole === WorkspaceRole.ADMIN && target.role !== WorkspaceRole.MEMBER) {
      throw new ForbiddenException('ADMIN 只能移除 MEMBER');
    }
  }

  private async assertCanUpdateMemberRole(
    userId: string,
    actorRole: WorkspaceRole,
    workspaceId: string,
    request: WorkspacePolicyRequest,
  ): Promise<void> {
    if (actorRole !== WorkspaceRole.OWNER) {
      throw new ForbiddenException('只有 OWNER 可以修改成员角色');
    }
    const targetUserId = this.param(request, 'memberUserId');
    const nextRole = this.roleFromBody(request, 'role');
    if (nextRole === WorkspaceRole.OWNER) {
      throw new BadRequestException('OWNER 转让不通过普通角色修改完成');
    }
    if (targetUserId === userId) throw new ForbiddenException('不能修改自己的角色');
    const target = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      select: { role: true },
    });
    if (!target) throw new NotFoundException('Workspace 成员不存在');
    if (target.role === WorkspaceRole.OWNER) {
      throw new ForbiddenException('不能修改 Workspace OWNER 的角色');
    }
  }

  private async assertCanDeleteDocuments(
    userId: string,
    actorRole: WorkspaceRole,
    workspaceId: string,
    request: WorkspacePolicyRequest,
  ): Promise<void> {
    const knowledgeBaseId = this.param(request, 'knowledgeBaseId');
    const rawIds = request.body?.documentIds;
    if (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== 'string')) {
      throw new BadRequestException('文档 ID 列表无效');
    }
    const ids = [...new Set(rawIds as string[])];
    if (ids.length !== rawIds.length) throw new BadRequestException('文档 ID 不能重复');
    if (ids.length === 0) throw new BadRequestException('请至少选择一个文档');

    const documents = await this.prisma.document.findMany({
      where: {
        id: { in: ids },
        knowledgeBaseId,
        knowledgeBase: { workspaceId },
      },
      select: { id: true, uploadedByUserId: true },
    });
    if (documents.length !== ids.length) {
      throw new NotFoundException('一个或多个文档不存在于该知识库');
    }
    if (
      actorRole === WorkspaceRole.MEMBER &&
      documents.some((document) => document.uploadedByUserId !== userId)
    ) {
      throw new ForbiddenException('MEMBER 只能删除自己上传的文档');
    }
    if (
      actorRole !== WorkspaceRole.MEMBER &&
      actorRole !== WorkspaceRole.ADMIN &&
      actorRole !== WorkspaceRole.OWNER
    ) {
      throw new ForbiddenException('当前角色不能删除文档');
    }
  }

  private roleFromBody(
    request: WorkspacePolicyRequest,
    key: string,
    fallback?: WorkspaceRole,
  ): WorkspaceRole {
    const value = request.body?.[key] ?? fallback;
    if (
      value !== WorkspaceRole.OWNER &&
      value !== WorkspaceRole.ADMIN &&
      value !== WorkspaceRole.MEMBER
    ) {
      throw new BadRequestException(`成员角色无效：${key}`);
    }
    return value;
  }

  private param(request: WorkspacePolicyRequest, key: string): string {
    const value = request.params[key];
    if (!value) throw new BadRequestException(`缺少路由参数：${key}`);
    return value;
  }
}
