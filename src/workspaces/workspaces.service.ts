import { Injectable } from '@nestjs/common';
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

  async get(workspaceId: string) {
    return this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  }

  async update(workspaceId: string, name: string) {
    return this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { name: name.trim() },
    });
  }

  async delete(workspaceId: string) {
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
}
