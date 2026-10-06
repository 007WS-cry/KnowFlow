import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, WorkspaceInvitationStatus, WorkspaceRole } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class WorkspaceMembersService {
  constructor(private readonly prisma: PrismaService) {}

  async listMembers(workspaceId: string) {
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      include: { user: { select: { id: true, email: true, name: true } } },
    });
    return members.map(({ user, role, createdAt }) => ({
      userId: user.id,
      email: user.email,
      name: user.name,
      role,
      joinedAt: createdAt,
    }));
  }

  async listInvitations(workspaceId: string) {
    await this.prisma.workspaceInvitation.updateMany({
      where: {
        workspaceId,
        status: WorkspaceInvitationStatus.PENDING,
        expiresAt: { lte: new Date() },
      },
      data: { status: WorkspaceInvitationStatus.EXPIRED },
    });
    const invitations = await this.prisma.workspaceInvitation.findMany({
      where: { workspaceId, status: WorkspaceInvitationStatus.PENDING },
      orderBy: { createdAt: 'desc' },
      include: { invitedBy: { select: { name: true, email: true } } },
    });
    return invitations.map(({ tokenHash: _tokenHash, ...invitation }) => invitation);
  }

  async invite(
    workspaceId: string,
    invitedByUserId: string,
    emailInput: string,
    role: Extract<WorkspaceRole, 'ADMIN' | 'MEMBER'>,
  ) {
    const email = emailInput.trim().toLowerCase();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITATION_LIFETIME_MS);

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "Workspace" WHERE "id" = ${workspaceId} FOR UPDATE`,
        );
        const user = await tx.user.findUnique({ where: { email }, select: { id: true } });
        if (user) {
          const membership = await tx.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId, userId: user.id } },
            select: { id: true },
          });
          if (membership) throw new ConflictException('该用户已经是 Workspace 成员');
        }

        await tx.workspaceInvitation.upsert({
          where: { workspaceId_email: { workspaceId, email } },
          create: {
            workspaceId,
            email,
            role,
            tokenHash,
            invitedByUserId,
            expiresAt,
            status: WorkspaceInvitationStatus.PENDING,
          },
          update: {
            role,
            tokenHash,
            invitedByUserId,
            expiresAt,
            status: WorkspaceInvitationStatus.PENDING,
            acceptedAt: null,
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('无法创建重复邀请');
      }
      throw error;
    }

    return {
      email,
      role,
      invitationToken: token,
      expiresAt,
    };
  }

  async revokeInvitation(workspaceId: string, invitationId: string) {
    const result = await this.prisma.workspaceInvitation.updateMany({
      where: {
        id: invitationId,
        workspaceId,
        status: WorkspaceInvitationStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      data: { status: WorkspaceInvitationStatus.REVOKED },
    });
    if (result.count !== 1) throw new ConflictException('邀请已失效或已被处理');
    return { success: true as const, id: invitationId };
  }

  async acceptInvitation(userId: string, userEmail: string, token: string) {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const invitation = await this.prisma.workspaceInvitation.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        email: true,
        role: true,
        workspaceId: true,
        status: true,
        expiresAt: true,
        workspace: { select: { id: true, name: true } },
      },
    });
    if (!invitation) throw new NotFoundException('邀请链接无效');
    if (invitation.email.toLowerCase() !== userEmail.trim().toLowerCase()) {
      throw new ForbiddenException('当前登录账号的邮箱与邀请邮箱不匹配');
    }
    if (invitation.status !== WorkspaceInvitationStatus.PENDING) {
      throw new ConflictException('邀请已接受、撤销或失效');
    }
    if (invitation.expiresAt <= new Date()) {
      await this.prisma.workspaceInvitation.updateMany({
        where: { id: invitation.id, status: WorkspaceInvitationStatus.PENDING },
        data: { status: WorkspaceInvitationStatus.EXPIRED },
      });
      throw new ConflictException('邀请已过期');
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.workspaceInvitation.updateMany({
          where: {
            id: invitation.id,
            tokenHash,
            status: WorkspaceInvitationStatus.PENDING,
            expiresAt: { gt: new Date() },
          },
          data: {
            status: WorkspaceInvitationStatus.ACCEPTED,
            acceptedAt: new Date(),
          },
        });
        if (claimed.count !== 1) throw new ConflictException('邀请已被处理或已过期');
        await tx.workspaceMember.create({
          data: {
            workspaceId: invitation.workspaceId,
            userId,
            role: invitation.role,
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('你已经是该 Workspace 成员');
      }
      throw error;
    }

    return {
      workspace: invitation.workspace,
      role: invitation.role,
    };
  }

  async removeMember(workspaceId: string, userId: string) {
    const removed = await this.prisma.workspaceMember.deleteMany({
      where: { workspaceId, userId, role: { not: WorkspaceRole.OWNER } },
    });
    if (removed.count !== 1) throw new NotFoundException('Workspace 成员不存在');
    return { success: true as const, userId };
  }

  async updateMemberRole(
    workspaceId: string,
    userId: string,
    role: Extract<WorkspaceRole, 'ADMIN' | 'MEMBER'>,
  ) {
    const updated = await this.prisma.workspaceMember.updateMany({
      where: { workspaceId, userId, role: { not: WorkspaceRole.OWNER } },
      data: { role },
    });
    if (updated.count !== 1) throw new NotFoundException('Workspace 成员不存在');
    const membership = await this.prisma.workspaceMember.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId, userId } },
      include: { user: { select: { id: true, email: true, name: true } } },
    });
    return {
      userId: membership.user.id,
      email: membership.user.email,
      name: membership.user.name,
      role: membership.role,
      joinedAt: membership.createdAt,
    };
  }
}
