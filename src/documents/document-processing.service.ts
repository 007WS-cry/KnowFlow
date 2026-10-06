import { Injectable, Logger } from '@nestjs/common';
import { DocumentProcessingStage, DocumentStatus, Prisma } from '@prisma/client';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../storage/minio.service';
import { EmbeddingService } from '../embeddings/embedding.service';
import { EmbeddingIndexService } from '../embeddings/embedding-index.service';
import { chunkStructuredBlocks, ParsedBlock, StructuredChunk } from './structured-chunker';

const INSERT_BATCH_SIZE = 64;

class DocumentProcessingCancelledError extends Error {
  constructor() {
    super('文档处理任务已取消');
  }
}

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
      where: {
        id: documentId,
        status: { in: [DocumentStatus.PENDING, DocumentStatus.FAILED] },
        processingStage: { not: DocumentProcessingStage.UPLOAD },
        cancelRequested: false,
      },
      data: {
        status: DocumentStatus.PROCESSING,
        processingStage: DocumentProcessingStage.PARSING,
        progress: 5,
        errorMessage: null,
        processedAt: null,
      },
    });
    if (claimed.count === 0) return;

    const nextIndexVersion = document.activeIndexVersion + 1;
    try {
      await this.prisma.chunk.deleteMany({
        where: { documentId, documentIndexVersion: nextIndexVersion },
      });
      await this.assertNotCancelled(documentId);
      const fileBuffer = await this.readObject(document.objectKey);
      const blocks = await this.extractBlocks(document.originalName, fileBuffer);
      await this.updateProgress(documentId, DocumentProcessingStage.CHUNKING, 20);
      const chunks = chunkStructuredBlocks(blocks);
      if (chunks.length === 0) throw new Error('文档中没有可索引的文本内容');

      await this.updateProgress(documentId, DocumentProcessingStage.EMBEDDING, 30);
      await this.insertChunks(
        documentId,
        document.originalName,
        chunks,
        nextIndexVersion,
        async (progress) => {
          await this.updateProgress(documentId, DocumentProcessingStage.EMBEDDING, progress);
        },
      );
      await this.updateProgress(documentId, DocumentProcessingStage.INDEXING, 92);

      await this.prisma.$transaction(async (tx) => {
        const activated = await tx.document.updateMany({
          where: { id: documentId, cancelRequested: false },
          data: {
            status: DocumentStatus.READY,
            processingStage: DocumentProcessingStage.COMPLETE,
            progress: 100,
            errorMessage: null,
            processedAt: new Date(),
            activeIndexVersion: nextIndexVersion,
          },
        });
        if (activated.count === 0) throw new DocumentProcessingCancelledError();
        await tx.knowledgeBase.update({
          where: { id: document.knowledgeBaseId },
          data: { indexVersion: { increment: 1 }, updatedAt: new Date() },
        });
      });
      await this.prisma.chunk
        .deleteMany({ where: { documentId, documentIndexVersion: { not: nextIndexVersion } } })
        .catch((error: unknown) =>
          this.logger.warn(`Old index cleanup failed for ${documentId}: ${String(error)}`),
        );
      this.logger.log(`Indexed document ${documentId} into ${chunks.length} structured chunks`);
    } catch (error) {
      await this.prisma.chunk
        .deleteMany({ where: { documentId, documentIndexVersion: nextIndexVersion } })
        .catch(() => undefined);
      if (error instanceof DocumentProcessingCancelledError) {
        await this.prisma.document.updateMany({
          where: { id: documentId },
          data: {
            status: DocumentStatus.CANCELLED,
            processingStage: DocumentProcessingStage.COMPLETE,
            progress: 100,
            cancelRequested: false,
          },
        });
        return;
      }
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

  private async extractBlocks(filename: string, buffer: Buffer): Promise<ParsedBlock[]> {
    const extension = filename.toLowerCase().split('.').pop();
    if (extension === 'txt' || extension === 'md' || extension === 'markdown') {
      return this.parsePlainText(buffer.toString('utf8'), extension !== 'txt');
    }
    if (extension === 'docx') {
      const html = (await mammoth.convertToHtml({ buffer })).value;
      return this.parseHtmlBlocks(html);
    }
    if (extension === 'pdf') {
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        let paragraphIndex = 0;
        return result.pages.flatMap((page) =>
          page.text
            .split(/\n{2,}/u)
            .map((text) => text.replace(/\s*\n\s*/gu, ' ').trim())
            .filter(Boolean)
            .map((text) => ({
              text,
              pageNumber: page.num,
              headingPath: [],
              paragraphIndex: ++paragraphIndex,
              blockType: 'paragraph' as const,
            })),
        );
      } finally {
        await parser.destroy();
      }
    }
    throw new Error('暂不支持该文件类型');
  }

  private parsePlainText(text: string, markdown: boolean): ParsedBlock[] {
    const normalized = text.replaceAll('\u0000', '').replace(/\r\n?/gu, '\n').trim();
    const blocks: ParsedBlock[] = [];
    const headingPath: string[] = [];
    let paragraphIndex = 0;
    let tableIndex = 0;
    const lines = normalized.split('\n');
    for (let index = 0; index < lines.length;) {
      const line = lines[index]!.trim();
      if (!line) {
        index += 1;
        continue;
      }
      const heading = markdown ? line.match(/^(#{1,6})\s+(.+)$/u) : null;
      if (heading) {
        const level = heading[1]!.length;
        headingPath.length = level - 1;
        headingPath[level - 1] = heading[2]!.trim();
        blocks.push({
          text: heading[2]!.trim(),
          headingPath: [...headingPath],
          paragraphIndex: ++paragraphIndex,
          blockType: 'heading',
        });
        index += 1;
        continue;
      }
      if (markdown && line.includes('|')) {
        const currentTable = tableIndex++;
        let rowIndex = 0;
        while (index < lines.length && lines[index]!.trim().includes('|')) {
          const row = lines[index]!.trim();
          if (!/^\|?\s*:?-{3,}/u.test(row)) {
            const cells = row
              .replace(/^\||\|$/gu, '')
              .split('|')
              .map((cell) => cell.trim());
            blocks.push({
              text: cells.join(' | '),
              headingPath: [...headingPath],
              paragraphIndex: ++paragraphIndex,
              blockType: 'table',
              tableIndex: currentTable,
              rowIndex: rowIndex++,
            });
          }
          index += 1;
        }
        continue;
      }
      const paragraph: string[] = [];
      while (
        index < lines.length &&
        lines[index]!.trim() &&
        !(markdown && /^(#{1,6})\s/u.test(lines[index]!.trim()))
      ) {
        if (markdown && lines[index]!.trim().includes('|')) break;
        paragraph.push(lines[index]!.trim());
        index += 1;
      }
      if (paragraph.length) {
        blocks.push({
          text: paragraph.join(' '),
          headingPath: [...headingPath],
          paragraphIndex: ++paragraphIndex,
          blockType: 'paragraph',
        });
      } else {
        index += 1;
      }
    }
    return blocks;
  }

  private parseHtmlBlocks(html: string): ParsedBlock[] {
    const blocks: ParsedBlock[] = [];
    const headingPath: string[] = [];
    let paragraphIndex = 0;
    let tableIndex = 0;
    for (const match of html.matchAll(/<(h[1-6]|p|table)\b[^>]*>([\s\S]*?)<\/\1>/giu)) {
      if (match[1]!.toLowerCase() === 'table') {
        const currentTable = tableIndex++;
        let rowIndex = 0;
        for (const row of match[2]!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
          const cells = [...row[1]!.matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/giu)].map(
            (cell) => decodeHtml(cell[1]!.replace(/<[^>]+>/gu, ' ')).trim(),
          );
          const text = cells.filter(Boolean).join(' | ');
          if (text) {
            blocks.push({
              text,
              headingPath: [...headingPath],
              paragraphIndex: ++paragraphIndex,
              blockType: 'table',
              tableIndex: currentTable,
              rowIndex: rowIndex++,
            });
          }
        }
        continue;
      }
      const text = decodeHtml(match[2]!.replace(/<[^>]+>/gu, ' '))
        .replace(/\s+/gu, ' ')
        .trim();
      if (!text) continue;
      const heading = match[1]!.toLowerCase().match(/^h([1-6])$/u);
      if (heading) {
        const level = Number(heading[1]);
        headingPath.length = level - 1;
        headingPath[level - 1] = text;
        blocks.push({
          text,
          headingPath: [...headingPath],
          paragraphIndex: ++paragraphIndex,
          blockType: 'heading',
        });
      } else {
        blocks.push({
          text,
          headingPath: [...headingPath],
          paragraphIndex: ++paragraphIndex,
          blockType: 'paragraph',
        });
      }
    }
    return blocks;
  }

  private async updateProgress(
    documentId: string,
    processingStage: DocumentProcessingStage,
    progress: number,
  ): Promise<void> {
    const result = await this.prisma.document.updateMany({
      where: { id: documentId, cancelRequested: false, status: DocumentStatus.PROCESSING },
      data: { processingStage, progress },
    });
    if (result.count === 0) throw new DocumentProcessingCancelledError();
  }

  private async assertNotCancelled(documentId: string): Promise<void> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { cancelRequested: true, status: true },
    });
    if (!document || document.cancelRequested || document.status === DocumentStatus.CANCELLED) {
      throw new DocumentProcessingCancelledError();
    }
  }

  private async insertChunks(
    documentId: string,
    filename: string,
    chunks: StructuredChunk[],
    documentIndexVersion: number,
    onProgress: (progress: number) => Promise<void>,
  ): Promise<void> {
    for (let offset = 0; offset < chunks.length; offset += INSERT_BATCH_SIZE) {
      await this.assertNotCancelled(documentId);
      const batch = chunks.slice(offset, offset + INSERT_BATCH_SIZE);
      const vectors = await this.embeddings.embedDocuments(batch.map(({ content }) => content));
      await this.embeddingIndex.ensureHnswIndex(vectors[0]!.length);
      const values = batch.map(({ content, metadata }, batchIndex) => {
        const chunkIndex = offset + batchIndex;
        const vector = this.embeddings.toPgVector(vectors[batchIndex]!);
        const profile = this.embeddings.getProfile(vectors[batchIndex]!.length);
        const chunkMetadata = JSON.stringify({ sourceName: filename, ...metadata });
        return Prisma.sql`(${randomUUID()}, ${documentId}, ${documentIndexVersion}, ${chunkIndex}, ${content}, ${vector}::vector, ${profile.provider}, ${profile.model}, ${profile.version}, ${profile.dimension}, ${chunkMetadata}::jsonb, NOW())`;
      });
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO "Chunk" ("id", "documentId", "documentIndexVersion", "chunkIndex", "content", "embedding", "embeddingProvider", "embeddingModel", "embeddingVersion", "embeddingDimension", "metadata", "createdAt")
        VALUES ${Prisma.join(values)}
      `);
      const progress =
        30 + Math.round((Math.min(offset + batch.length, chunks.length) / chunks.length) * 58);
      await onProgress(progress);
    }
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&#(\d+);/gu, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/giu, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
}
