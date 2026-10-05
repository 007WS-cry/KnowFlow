import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../storage/minio.service';
import { QueueService } from '../queue/queue.service';
import { WorkspacesService } from '../workspaces/workspaces.service';

@Injectable()
export class KnowledgeBasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
    private readonly storage: MinioService,
    private readonly queue: QueueService,
  ) {}

  async listForWorkspace(userId: string, workspaceId: string) {
    await this.workspaces.assertMember(userId, workspaceId);
    return this.prisma.knowledgeBase.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { documents: true } } },
    });
  }

  async create(userId: string, workspaceId: string, name: string, description?: string) {
    await this.workspaces.assertMember(userId, workspaceId);
    try {
      return await this.prisma.knowledgeBase.create({
        data: { workspaceId, name: name.trim(), description: description?.trim() || null },
        include: { _count: { select: { documents: true } } },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('该 Workspace 中已存在同名知识库');
      }
      throw error;
    }
  }

  async getAccessible(userId: string, knowledgeBaseId: string) {
    const knowledgeBase = await this.prisma.knowledgeBase.findUnique({
      where: { id: knowledgeBaseId },
      include: { _count: { select: { documents: true } } },
    });
    if (!knowledgeBase) throw new NotFoundException('知识库不存在');
    await this.workspaces.assertMember(userId, knowledgeBase.workspaceId);
    return knowledgeBase;
  }

  async update(
    userId: string,
    knowledgeBaseId: string,
    input: { name?: string; description?: string | null },
  ) {
    await this.getAccessible(userId, knowledgeBaseId);
    try {
      return await this.prisma.knowledgeBase.update({
        where: { id: knowledgeBaseId },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined
            ? { description: input.description?.trim() || null }
            : {}),
        },
        include: { _count: { select: { documents: true } } },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('该 Workspace 中已存在同名知识库');
      }
      throw error;
    }
  }

  async delete(userId: string, knowledgeBaseId: string) {
    await this.getAccessible(userId, knowledgeBaseId);
    const documents = await this.prisma.document.findMany({
      where: { knowledgeBaseId },
      select: { id: true, objectKey: true },
    });
    await Promise.all(documents.map(({ id }) => this.queue.cancelDocumentProcessing(id)));
    await Promise.all(
      documents.map(({ objectKey }) =>
        this.storage.getClient().removeObject(this.storage.getBucket(), objectKey),
      ),
    );
    await this.prisma.knowledgeBase.delete({ where: { id: knowledgeBaseId } });
    return { success: true as const, id: knowledgeBaseId };
  }
}
