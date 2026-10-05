import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EmbeddingService } from '../embeddings/embedding.service';
import { PrismaService } from '../prisma/prisma.service';
import { KnowledgeBasesService } from '../knowledge-bases/knowledge-bases.service';
import { LlmService } from '../llm/llm.service';
import { repairFilenameEncoding } from '../documents/filename-encoding';

export interface RetrievedChunk {
  id: string;
  documentId: string;
  documentName: string;
  chunkIndex: number;
  content: string;
  score: number;
}

@Injectable()
export class RagService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingService,
    private readonly knowledgeBases: KnowledgeBasesService,
    private readonly llm: LlmService,
  ) {}

  async ask(userId: string, knowledgeBaseId: string, question: string, topK = 5) {
    const knowledgeBase = await this.knowledgeBases.getAccessible(userId, knowledgeBaseId);
    const vector = await this.embeddings.embed(question);
    if (!vector.some((value) => value !== 0)) {
      throw new BadRequestException('问题中没有可用于检索的文字');
    }
    const pgVector = this.embeddings.toPgVector(vector);

    const chunks = (await this.prisma.$queryRaw<RetrievedChunk[]>(Prisma.sql`
      SELECT
        c."id",
        c."documentId",
        d."originalName" AS "documentName",
        c."chunkIndex",
        c."content",
        (1 - (c."embedding" <=> ${pgVector}::vector))::float8 AS "score"
      FROM "Chunk" c
      INNER JOIN "Document" d ON d."id" = c."documentId"
      INNER JOIN "KnowledgeBase" kb ON kb."id" = d."knowledgeBaseId"
      WHERE d."knowledgeBaseId" = ${knowledgeBaseId}
        AND kb."workspaceId" = ${knowledgeBase.workspaceId}
        AND EXISTS (
          SELECT 1
          FROM "WorkspaceMember" wm
          WHERE wm."workspaceId" = kb."workspaceId"
            AND wm."userId" = ${userId}
        )
        AND c."embedding" IS NOT NULL
        AND d."status" = 'READY'
      ORDER BY c."embedding" <=> ${pgVector}::vector
      LIMIT ${topK}
    `)).map((chunk) => ({
      ...chunk,
      documentName: repairFilenameEncoding(chunk.documentName),
    }));

    const sources = chunks.map((chunk, index) => ({
      citation: index + 1,
      documentId: chunk.documentId,
      documentName: chunk.documentName,
      chunkIndex: chunk.chunkIndex,
      score: Number(chunk.score),
    }));

    const answer =
      chunks.length === 0
        ? '当前知识库还没有可检索的已处理文档，请先上传文档并等待处理完成。'
        : await this.llm.generateAnswer(
            question,
            chunks.map((chunk, index) => ({
              citation: index + 1,
              documentName: chunk.documentName,
              chunkIndex: chunk.chunkIndex,
              content: chunk.content,
            })),
          );

    return {
      knowledgeBaseId,
      question,
      answerMode: chunks.length === 0 ? 'empty' : 'llm',
      answer,
      chunks,
      sources,
      citations: sources,
    };
  }
}
