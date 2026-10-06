import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../storage/minio.service';
import { QueueService } from '../queue/queue.service';

@Injectable()
export class KnowledgeBasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MinioService,
    private readonly queue: QueueService,
  ) {}

  async listForWorkspace(workspaceId: string) {
    return this.prisma.knowledgeBase.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { documents: true } } },
    });
  }

  async create(workspaceId: string, name: string, description?: string) {
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

  async getById(knowledgeBaseId: string) {
    const knowledgeBase = await this.prisma.knowledgeBase.findUnique({
      where: { id: knowledgeBaseId },
      include: { _count: { select: { documents: true } } },
    });
    if (!knowledgeBase) throw new NotFoundException('知识库不存在');
    return knowledgeBase;
  }

  async update(knowledgeBaseId: string, input: { name?: string; description?: string | null }) {
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

  async delete(knowledgeBaseId: string) {
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
