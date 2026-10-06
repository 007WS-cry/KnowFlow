import { Injectable, Logger } from '@nestjs/common';
import { DocumentStatus, Prisma } from '@prisma/client';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../storage/minio.service';
import { EmbeddingService } from '../embeddings/embedding.service';
import { EmbeddingIndexService } from '../embeddings/embedding-index.service';

const CHUNK_SIZE = 1_200;
const CHUNK_OVERLAP = 160;
const INSERT_BATCH_SIZE = 200;

@Injectable()
export class DocumentProcessingService {
  private readonly logger = new Logger(DocumentProcessingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MinioService,
    private readonly embeddings: EmbeddingService,
    private readonly embeddingIndex: EmbeddingIndexService,
  ) {}

  async process(documentId: string): Promise<void> {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) return;

    const claimed = await this.prisma.document.updateMany({
      where: { id: documentId },
      data: { status: DocumentStatus.PROCESSING, errorMessage: null, processedAt: null },
    });
    if (claimed.count === 0) return;

    try {
      await this.prisma.chunk.deleteMany({ where: { documentId } });
      const fileBuffer = await this.readObject(document.objectKey);
      const text = await this.extractText(document.originalName, fileBuffer);
      const chunks = this.splitText(text);
      if (chunks.length === 0) throw new Error('文档中没有可索引的文本内容');

      await this.insertChunks(documentId, document.originalName, chunks);
      await this.prisma.document.updateMany({
        where: { id: documentId },
        data: { status: DocumentStatus.READY, errorMessage: null, processedAt: new Date() },
      });
      this.logger.log(`Indexed document ${documentId} into ${chunks.length} chunks`);
    } catch (error) {
      await this.prisma.chunk.deleteMany({ where: { documentId } }).catch(() => undefined);
      const errorMessage = error instanceof Error ? error.message.slice(0, 500) : '文档处理失败';
      await this.prisma.document.updateMany({
        where: { id: documentId },
        data: { status: DocumentStatus.FAILED, errorMessage },
      });
      throw error;
    }
  }

  private async readObject(objectKey: string): Promise<Buffer> {
    const stream = await this.storage.getClient().getObject(this.storage.getBucket(), objectKey);
    const buffers: Buffer[] = [];
    for await (const chunk of stream as Readable) {
      buffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(buffers);
  }

  private async extractText(filename: string, buffer: Buffer): Promise<string> {
    const extension = filename.toLowerCase().split('.').pop();

    if (extension === 'txt' || extension === 'md' || extension === 'markdown') {
      return buffer.toString('utf8');
    }

    if (extension === 'docx') {
      return (await mammoth.extractRawText({ buffer })).value;
    }

    if (extension === 'pdf') {
      const parser = new PDFParse({ data: buffer });
      try {
        return (await parser.getText()).text;
      } finally {
        await parser.destroy();
      }
    }

    throw new Error('暂不支持该文件类型');
  }

  private splitText(input: string): string[] {
    // PostgreSQL TEXT cannot store U+0000.
    const text = input.replaceAll('\u0000', '').replace(/\r\n?/g, '\n').trim();
    if (!text) return [];

    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + CHUNK_SIZE, text.length);
      if (end < text.length) {
        const searchStart = start + Math.floor(CHUNK_SIZE * 0.65);
        const boundary = text.slice(searchStart, end).search(/[\n。！？.!?；;]\s*/g);
        if (boundary >= 0) end = searchStart + boundary + 1;
      }

      const chunk = text.slice(start, end).trim();
      if (chunk) chunks.push(chunk);
      if (end >= text.length) break;
      start = Math.max(start + 1, end - CHUNK_OVERLAP);
    }
    return chunks;
  }

  private async insertChunks(
    documentId: string,
    filename: string,
    chunks: string[],
  ): Promise<void> {
    for (let offset = 0; offset < chunks.length; offset += INSERT_BATCH_SIZE) {
      const batch = chunks.slice(offset, offset + INSERT_BATCH_SIZE);
      const vectors = await this.embeddings.embedDocuments(batch);
      await this.embeddingIndex.ensureHnswIndex(vectors[0]!.length);
      const values = batch.map((content, batchIndex) => {
        const chunkIndex = offset + batchIndex;
        const vector = this.embeddings.toPgVector(vectors[batchIndex]!);
        const profile = this.embeddings.getProfile(vectors[batchIndex]!.length);
        const metadata = JSON.stringify({ sourceName: filename });

        return Prisma.sql`(${randomUUID()}, ${documentId}, ${chunkIndex}, ${content}, ${vector}::vector, ${profile.provider}, ${profile.model}, ${profile.version}, ${profile.dimension}, ${metadata}::jsonb, NOW())`;
      });

      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO "Chunk" ("id", "documentId", "chunkIndex", "content", "embedding", "embeddingProvider", "embeddingModel", "embeddingVersion", "embeddingDimension", "metadata", "createdAt")
        VALUES ${Prisma.join(values)}
      `);
    }
  }
}
