import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Document as DocumentModel, DocumentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../storage/minio.service';
import { QueueService } from '../queue/queue.service';
import { KnowledgeBasesService } from '../knowledge-bases/knowledge-bases.service';
import { UploadedFile } from './uploaded-file';
import { repairFilenameEncoding } from './filename-encoding';

const MAX_MULTIPART_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.pdf', '.docx']);

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly storage: MinioService,
    private readonly queue: QueueService,
    private readonly knowledgeBases: KnowledgeBasesService,
  ) {}

  async list(knowledgeBaseId: string) {
    const documents = await this.prisma.document.findMany({
      where: { knowledgeBaseId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        uploadedByUserId: true,
        uploadedByUser: { select: { name: true, email: true } },
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        status: true,
        errorMessage: true,
        processedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return documents.map((document) => ({
      ...document,
      originalName: repairFilenameEncoding(document.originalName),
      sizeBytes: Number(document.sizeBytes),
    }));
  }

  async upload(userId: string, knowledgeBaseId: string, file?: UploadedFile) {
    if (!file?.buffer) throw new BadRequestException('请上传文件');

    const maxBytes = Math.min(
      Number(this.config.get<string>('MAX_UPLOAD_BYTES', String(MAX_MULTIPART_BYTES))),
      MAX_MULTIPART_BYTES,
    );
    if (file.size > maxBytes) {
      throw new BadRequestException(`文件不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MB`);
    }

    const originalName = this.safeFilename(file.originalname);
    const extension = originalName.slice(originalName.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new BadRequestException('仅支持 TXT、Markdown、PDF 和 DOCX 文件');
    }
    this.validateFileSignature(extension, file.buffer);

    const knowledgeBase = await this.knowledgeBases.getById(knowledgeBaseId);
    const mimeType = this.mimeTypeFor(extension);
    const objectKey = `${knowledgeBase.workspaceId}/${knowledgeBase.id}/${randomUUID()}/${originalName}`;

    await this.storage
      .getClient()
      .putObject(this.storage.getBucket(), objectKey, file.buffer, file.size, {
        'Content-Type': mimeType,
      });

    let document: DocumentModel;
    try {
      document = await this.prisma.$transaction(async (tx) => {
        const created = await tx.document.create({
          data: {
            knowledgeBaseId,
            uploadedByUserId: userId,
            originalName,
            mimeType,
            objectKey,
            sizeBytes: BigInt(file.size),
          },
        });
        await tx.knowledgeBase.update({
          where: { id: knowledgeBaseId },
          data: { updatedAt: new Date() },
        });
        return created;
      });
    } catch (error) {
      await this.storage
        .getClient()
        .removeObject(this.storage.getBucket(), objectKey)
        .catch(() => undefined);
      throw error;
    }

    let jobId: string | null = null;
    try {
      jobId = await this.queue.enqueueDocumentProcessing(document.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 500) : '队列暂不可用';
      document = await this.prisma.document.update({
        where: { id: document.id },
        data: { status: DocumentStatus.FAILED, errorMessage: reason },
      });
    }

    return {
      ...this.toApiDocument(document),
      jobId,
    };
  }

  async deleteMany(knowledgeBaseId: string, documentIds: string[]) {
    const documents = await this.prisma.document.findMany({
      where: { knowledgeBaseId, id: { in: documentIds } },
      select: { id: true, objectKey: true },
    });
    if (documents.length !== new Set(documentIds).size) {
      throw new NotFoundException('一个或多个文档不存在于该知识库');
    }

    await Promise.all(documents.map(({ id }) => this.queue.cancelDocumentProcessing(id)));
    await Promise.all(
      documents.map(({ objectKey }) =>
        this.storage.getClient().removeObject(this.storage.getBucket(), objectKey),
      ),
    );
    const result = await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.document.deleteMany({
        where: { knowledgeBaseId, id: { in: documentIds } },
      });
      await tx.knowledgeBase.update({
        where: { id: knowledgeBaseId },
        data: { updatedAt: new Date() },
      });
      return deleted;
    });

    return { deletedCount: result.count, deletedIds: documentIds };
  }

  async getStatus(documentId: string) {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        uploadedByUserId: true,
        uploadedByUser: { select: { name: true, email: true } },
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        status: true,
        errorMessage: true,
        processedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!document) throw new NotFoundException('文档不存在');
    return {
      ...document,
      originalName: repairFilenameEncoding(document.originalName),
      sizeBytes: Number(document.sizeBytes),
    };
  }

  private safeFilename(input: string): string {
    const leaf = input.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
    const safe = Array.from(leaf)
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code >= 0x20 && code !== 0x7f;
      })
      .join('')
      .slice(0, 240);
    if (!safe || safe === '.' || safe === '..') throw new BadRequestException('文件名无效');
    return safe;
  }

  private validateFileSignature(extension: string, buffer: Buffer): void {
    if (extension === '.pdf' && !buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new BadRequestException('PDF 文件内容无效');
    }
    if (extension === '.docx' && buffer.subarray(0, 2).toString('ascii') !== 'PK') {
      throw new BadRequestException('DOCX 文件内容无效');
    }
  }

  private mimeTypeFor(extension: string): string {
    if (extension === '.pdf') return 'application/pdf';
    if (extension === '.docx') {
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    return extension === '.txt' ? 'text/plain' : 'text/markdown';
  }

  private toApiDocument<T extends { sizeBytes: bigint }>(document: T) {
    return { ...document, sizeBytes: Number(document.sizeBytes) };
  }
}
