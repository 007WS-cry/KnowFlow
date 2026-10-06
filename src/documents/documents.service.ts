import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DocumentProcessingStage, DocumentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../storage/minio.service';
import { QueueService } from '../queue/queue.service';
import { KnowledgeBasesService } from '../knowledge-bases/knowledge-bases.service';
import { repairFilenameEncoding } from './filename-encoding';

const DEFAULT_PART_SIZE_BYTES = 16 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.pdf', '.docx']);

@Injectable()
export class DocumentsService implements OnModuleInit, OnModuleDestroy {
  private cleanupTimer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly storage: MinioService,
    private readonly queue: QueueService,
    private readonly knowledgeBases: KnowledgeBasesService,
  ) {}

  onModuleInit(): void {
    this.cleanupTimer = setInterval(
      () => {
        void this.cleanupExpiredUploads().catch(() => undefined);
      },
      15 * 60 * 1000,
    );
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

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
        processingStage: true,
        progress: true,
        retryCount: true,
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

  async createUploadTask(
    userId: string,
    knowledgeBaseId: string,
    input: {
      originalName: string;
      sizeBytes: number;
    },
  ) {
    const maxBytes = Number(this.config.get('MAX_UPLOAD_BYTES', 200 * 1024 * 1024));
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 1 ||
      input.sizeBytes > maxBytes
    ) {
      throw new BadRequestException(
        `文件大小必须在 1 字节至 ${Math.floor(maxBytes / 1024 / 1024)} MB 之间`,
      );
    }
    const originalName = this.safeFilename(input.originalName);
    const extension = originalName.slice(originalName.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new BadRequestException('仅支持 TXT、Markdown、PDF 和 DOCX 文件');
    }
    const knowledgeBase = await this.knowledgeBases.getById(knowledgeBaseId);
    const mimeType = this.mimeTypeFor(extension);
    const objectKey = `${knowledgeBase.workspaceId}/${knowledgeBase.id}/${randomUUID()}/${originalName}`;
    const threshold = Number(this.config.get('UPLOAD_MULTIPART_THRESHOLD_BYTES', 32 * 1024 * 1024));
    const partSizeBytes = Number(
      this.config.get('UPLOAD_PART_SIZE_BYTES', DEFAULT_PART_SIZE_BYTES),
    );
    const multipart = input.sizeBytes > threshold;
    let multipartUploadId: string | null = null;
    let createdDocumentId: string | undefined;
    try {
      if (multipart) multipartUploadId = await this.storage.initiateMultipart(objectKey, mimeType);
      const document = await this.prisma.document.create({
        data: {
          knowledgeBaseId,
          uploadedByUserId: userId,
          originalName,
          mimeType,
          objectKey,
          sizeBytes: BigInt(input.sizeBytes),
          status: DocumentStatus.PENDING,
          processingStage: DocumentProcessingStage.UPLOAD,
          progress: 0,
          multipartUploadId,
          uploadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
      createdDocumentId = document.id;
      const expiresSeconds = Number(this.config.get('UPLOAD_URL_EXPIRY_SECONDS', 3600));
      return {
        document: this.toApiDocument(document),
        uploadMode: multipart ? 'multipart' : 'single',
        ...(multipart
          ? { partSizeBytes, partCount: Math.ceil(input.sizeBytes / partSizeBytes) }
          : { uploadUrl: await this.storage.signSingleUpload(objectKey, expiresSeconds) }),
      };
    } catch (error) {
      if (createdDocumentId) {
        await this.prisma.document
          .delete({ where: { id: createdDocumentId } })
          .catch(() => undefined);
        await this.storage
          .getClient()
          .removeObject(this.storage.getBucket(), objectKey)
          .catch(() => undefined);
      }
      if (multipartUploadId) {
        await this.storage.abortMultipart(objectKey, multipartUploadId).catch(() => undefined);
      }
      throw error;
    }
  }

  async getPartUploadUrl(documentId: string, partNumber: number) {
    const document = await this.getUploadDocument(documentId);
    const partSize = Number(this.config.get('UPLOAD_PART_SIZE_BYTES', DEFAULT_PART_SIZE_BYTES));
    const partCount = Math.ceil(Number(document.sizeBytes) / partSize);
    if (
      !document.multipartUploadId ||
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > partCount
    ) {
      throw new BadRequestException('分片序号无效');
    }
    return {
      partNumber,
      uploadUrl: await this.storage.signMultipartPart(
        document.objectKey,
        document.multipartUploadId,
        partNumber,
      ),
    };
  }

  async completeUpload(documentId: string) {
    const document = await this.getUploadDocument(documentId);
    const multipart = Boolean(document.multipartUploadId);
    if (multipart) {
      const partSize = Number(this.config.get('UPLOAD_PART_SIZE_BYTES', DEFAULT_PART_SIZE_BYTES));
      const expectedCount = Math.ceil(Number(document.sizeBytes) / partSize);
      const storedParts = await this.storage.listMultipartParts(
        document.objectKey,
        document.multipartUploadId!,
      );
      const partBytes = storedParts.reduce((sum, part) => sum + part.size, 0);
      if (
        storedParts.length !== expectedCount ||
        storedParts.some((part, index) => part.part !== index + 1 || !part.etag) ||
        partBytes !== Number(document.sizeBytes) ||
        storedParts.slice(0, -1).some((part) => part.size < 5 * 1024 * 1024)
      ) {
        throw new BadRequestException('上传分片不完整、顺序无效或文件大小不匹配');
      }
      await this.storage.completeMultipart(
        document.objectKey,
        document.multipartUploadId!,
        storedParts.map(({ part, etag }) => ({ part, etag })),
      );
    }

    try {
      const stat = await this.storage
        .getClient()
        .statObject(this.storage.getBucket(), document.objectKey);
      if (stat.size !== Number(document.sizeBytes)) {
        throw new BadRequestException('MinIO 文件大小与上传任务不一致');
      }
      await this.validateStoredSignature(document.originalName, document.objectKey);
    } catch (error) {
      await this.storage
        .getClient()
        .removeObject(this.storage.getBucket(), document.objectKey)
        .catch(() => undefined);
      const message = error instanceof Error ? error.message : '上传文件校验失败';
      await this.prisma.document.update({
        where: { id: documentId },
        data: { status: DocumentStatus.FAILED, errorMessage: message.slice(0, 500) },
      });
      throw error;
    }

    const queued = await this.prisma.document.update({
      where: { id: documentId },
      data: {
        processingStage: DocumentProcessingStage.QUEUED,
        progress: 2,
        multipartUploadId: null,
      },
    });
    try {
      const jobId = await this.queue.enqueueDocumentProcessing(queued.id, queued.retryCount);
      return { ...this.toApiDocument(queued), jobId };
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 500) : '队列暂不可用';
      const failed = await this.prisma.document.update({
        where: { id: documentId },
        data: { status: DocumentStatus.FAILED, errorMessage: reason },
      });
      return { ...this.toApiDocument(failed), jobId: null };
    }
  }

  async retry(documentId: string, reindex = false) {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new NotFoundException('文档不存在');
    if (
      document.status === DocumentStatus.CANCELLED ||
      document.processingStage === DocumentProcessingStage.UPLOAD
    ) {
      throw new ConflictException('上传尚未完成或任务已取消，不能重试索引');
    }
    if (
      document.status !== DocumentStatus.FAILED &&
      !(reindex && document.status === DocumentStatus.READY)
    ) {
      throw new ConflictException(
        reindex ? '只有已就绪或失败的文档可以重新索引' : '只有失败的任务可以重试',
      );
    }
    const updated = await this.prisma.document.update({
      where: { id: documentId },
      data: {
        status: DocumentStatus.PENDING,
        processingStage: DocumentProcessingStage.QUEUED,
        progress: 2,
        errorMessage: null,
        cancelRequested: false,
        retryCount: { increment: 1 },
      },
    });
    try {
      const jobId = await this.queue.enqueueDocumentProcessing(updated.id, updated.retryCount);
      return { ...this.toApiDocument(updated), jobId };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : '队列暂不可用';
      await this.prisma.document.update({
        where: { id: updated.id },
        data: { status: DocumentStatus.FAILED, errorMessage: message },
      });
      throw error;
    }
  }

  async cancel(documentId: string) {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new NotFoundException('文档不存在');
    if (
      document.status === DocumentStatus.READY ||
      document.status === DocumentStatus.FAILED ||
      document.status === DocumentStatus.CANCELLED
    ) {
      throw new ConflictException('当前文档没有可取消的任务');
    }
    if (document.processingStage === DocumentProcessingStage.UPLOAD) {
      if (document.multipartUploadId) {
        await this.storage
          .abortMultipart(document.objectKey, document.multipartUploadId)
          .catch(() => undefined);
      }
      await this.storage
        .getClient()
        .removeObject(this.storage.getBucket(), document.objectKey)
        .catch(() => undefined);
      const cancelled = await this.prisma.document.update({
        where: { id: documentId },
        data: {
          status: DocumentStatus.CANCELLED,
          processingStage: DocumentProcessingStage.COMPLETE,
          progress: 100,
          multipartUploadId: null,
        },
      });
      return { documentId, cancellationRequested: false, status: cancelled.status };
    }
    const stopped = await this.queue.cancelDocumentProcessing(documentId);
    const updated = await this.prisma.document.update({
      where: { id: documentId },
      data: stopped
        ? {
            status: DocumentStatus.CANCELLED,
            processingStage: DocumentProcessingStage.COMPLETE,
            progress: 100,
          }
        : { cancelRequested: true },
    });
    return { documentId, cancellationRequested: !stopped, status: updated.status };
  }

  private async getUploadDocument(documentId: string) {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new NotFoundException('上传任务不存在');
    if (
      document.status !== DocumentStatus.PENDING ||
      document.processingStage !== DocumentProcessingStage.UPLOAD
    ) {
      throw new ConflictException('上传任务已结束');
    }
    if (document.uploadExpiresAt && document.uploadExpiresAt <= new Date()) {
      await this.expireUpload(document);
      throw new ConflictException('上传任务已过期，请重新上传文件');
    }
    return document;
  }

  private async cleanupExpiredUploads(): Promise<void> {
    const expired = await this.prisma.document.findMany({
      where: {
        status: DocumentStatus.PENDING,
        processingStage: DocumentProcessingStage.UPLOAD,
        uploadExpiresAt: { lte: new Date() },
      },
    });
    await Promise.all(expired.map((document) => this.expireUpload(document)));
  }

  private async expireUpload(document: {
    id: string;
    objectKey: string;
    multipartUploadId: string | null;
  }): Promise<void> {
    if (document.multipartUploadId) {
      await this.storage
        .abortMultipart(document.objectKey, document.multipartUploadId)
        .catch(() => undefined);
    }
    await this.storage
      .getClient()
      .removeObject(this.storage.getBucket(), document.objectKey)
      .catch(() => undefined);
    await this.prisma.document.updateMany({
      where: { id: document.id, processingStage: DocumentProcessingStage.UPLOAD },
      data: {
        status: DocumentStatus.CANCELLED,
        processingStage: DocumentProcessingStage.COMPLETE,
        progress: 100,
        multipartUploadId: null,
        errorMessage: '上传任务超过 24 小时未完成，已自动清理',
      },
    });
  }

  private async validateStoredSignature(filename: string, objectKey: string): Promise<void> {
    const extension = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    if (extension !== '.pdf' && extension !== '.docx') return;
    const stream = await this.storage
      .getClient()
      .getPartialObject(this.storage.getBucket(), objectKey, 0, 5);
    const buffers: Buffer[] = [];
    for await (const part of stream) buffers.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
    const prefix = Buffer.concat(buffers);
    if (extension === '.pdf' && prefix.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new BadRequestException('PDF 文件内容无效');
    }
    if (extension === '.docx' && prefix.subarray(0, 2).toString('ascii') !== 'PK') {
      throw new BadRequestException('DOCX 文件内容无效');
    }
  }

  async deleteMany(knowledgeBaseId: string, documentIds: string[]) {
    const documents = await this.prisma.document.findMany({
      where: { knowledgeBaseId, id: { in: documentIds } },
      select: { id: true, objectKey: true, multipartUploadId: true },
    });
    if (documents.length !== new Set(documentIds).size) {
      throw new NotFoundException('一个或多个文档不存在于该知识库');
    }

    await Promise.all(
      documents.map(async ({ id, objectKey, multipartUploadId }) => {
        await this.queue.cancelDocumentProcessing(id);
        if (multipartUploadId)
          await this.storage.abortMultipart(objectKey, multipartUploadId).catch(() => undefined);
      }),
    );
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
        data: { updatedAt: new Date(), indexVersion: { increment: 1 } },
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
        processingStage: true,
        progress: true,
        retryCount: true,
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
