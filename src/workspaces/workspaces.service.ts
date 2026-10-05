import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../storage/minio.service';
import { QueueService } from '../queue/queue.service';

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MinioService,
    private readonly queue: QueueService,
  ) {}

  async listForUser(userId: string) {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map(({ workspace, role, createdAt }) => ({
      ...workspace,
      role,
      joinedAt: createdAt,
    }));
  }

  async create(userId: string, name: string) {
    const baseSlug = name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const slug = `${baseSlug || 'workspace'}-${randomBytes(3).toString('hex')}`;

    return this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({ data: { name: name.trim(), slug } });
      await tx.workspaceMember.create({
        data: { workspaceId: workspace.id, userId, role: 'OWNER' },
      });
      return { ...workspace, role: 'OWNER' as const };
    });
  }

  async getForUser(userId: string, workspaceId: string) {
    const membership = await this.getMembership(userId, workspaceId);
    return { ...membership.workspace, role: membership.role };
  }

  async update(userId: string, workspaceId: string, name: string) {
    await this.assertOwner(userId, workspaceId);
    const workspace = await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { name: name.trim() },
    });
    return { ...workspace, role: 'OWNER' as const };
  }

  async delete(userId: string, workspaceId: string) {
    await this.assertOwner(userId, workspaceId);
    const documents = await this.prisma.document.findMany({
      where: { knowledgeBase: { workspaceId } },
      select: { id: true, objectKey: true },
    });

    await Promise.all(documents.map(({ id }) => this.queue.cancelDocumentProcessing(id)));
    await Promise.all(
      documents.map(({ objectKey }) =>
        this.storage.getClient().removeObject(this.storage.getBucket(), objectKey),
      ),
    );
    await this.prisma.workspace.delete({ where: { id: workspaceId } });
    return { success: true as const, id: workspaceId };
  }

  async assertMember(userId: string, workspaceId: string) {
    return (await this.getMembership(userId, workspaceId)).workspace;
  }

  async assertOwner(userId: string, workspaceId: string) {
    const membership = await this.getMembership(userId, workspaceId);
    if (membership.role !== 'OWNER') {
      throw new ForbiddenException('只有 Workspace 所有者可以执行此操作');
    }
    return membership.workspace;
  }

  private async getMembership(userId: string, workspaceId: string) {
    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      include: { workspace: true },
    });

    if (!membership) throw new NotFoundException('Workspace 不存在');
    return membership;
  }
}
