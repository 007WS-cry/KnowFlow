import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedRequest } from '../auth/auth.types';
import {
  WorkspacePermissionMetadata,
  WORKSPACE_PERMISSION_METADATA,
} from './workspace-permissions';
import { WorkspacePolicyRequest, WorkspacePolicyService } from './workspace-policy.service';

interface PolicyHttpRequest extends AuthenticatedRequest, WorkspacePolicyRequest {
  params: Record<string, string | undefined>;
  body?: Record<string, unknown>;
}

@Injectable()
export class WorkspacePolicyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly policy: WorkspacePolicyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<WorkspacePermissionMetadata>(
      WORKSPACE_PERMISSION_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!requirement) return true;

    const request = context.switchToHttp().getRequest<PolicyHttpRequest>();
    if (!request.user) return false;
    const workspaceId = await this.resolveWorkspaceId(requirement, request);
    await this.policy.authorize(request.user.id, requirement.action, workspaceId, request);
    return true;
  }

  private async resolveWorkspaceId(
    requirement: WorkspacePermissionMetadata,
    request: PolicyHttpRequest,
  ): Promise<string> {
    const { resource } = requirement;
    const value =
      resource.source === 'param' ? request.params[resource.key] : request.body?.[resource.key];
    if (typeof value !== 'string' || !value) {
      throw new BadRequestException(`缺少 Workspace 授权资源：${resource.key}`);
    }
    if (resource.type === 'workspace') return value;

    if (resource.type === 'knowledgeBase') {
      const knowledgeBase = await this.prisma.knowledgeBase.findUnique({
        where: { id: value },
        select: { workspaceId: true },
      });
      if (!knowledgeBase) throw new NotFoundException('知识库不存在');
      return knowledgeBase.workspaceId;
    }

    const document = await this.prisma.document.findUnique({
      where: { id: value },
      select: { knowledgeBase: { select: { workspaceId: true } } },
    });
    if (!document) throw new NotFoundException('文档不存在');
    return document.knowledgeBase.workspaceId;
  }
}
