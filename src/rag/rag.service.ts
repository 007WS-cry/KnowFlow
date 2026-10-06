import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { repairFilenameEncoding } from '../documents/filename-encoding';
import { EmbeddingService } from '../embeddings/embedding.service';
import { EmbeddingProfile } from '../embeddings/embedding.types';
import { KnowledgeBasesService } from '../knowledge-bases/knowledge-bases.service';
import { LlmService } from '../llm/llm.service';
import { PrismaService } from '../prisma/prisma.service';
import { RerankerService } from '../reranker/reranker.service';
import { RedisCacheService } from '../cache/redis-cache.service';

export interface RetrievedChunk {
  id: string;
  documentId: string;
  documentName: string;
  chunkIndex: number;
  content: string;
  score: number;
  pageNumber?: number | null;
  headingPath?: string[];
  metadata?: Record<string, unknown> | null;
  vectorRank?: number;
  vectorScore?: number;
  keywordRank?: number;
  keywordScore?: number;
  fusionScore?: number;
  rerankScore?: number;
}

export interface RetrievalCitation {
  citation: number;
  documentId: string;
  documentName: string;
  chunkIndex: number;
  score: number;
  pageNumber: number | null;
  headingPath: string[];
}

export interface RagRetrievalResult {
  knowledgeBaseId: string;
  question: string;
  answerMode: 'empty' | 'llm';
  chunks: RetrievedChunk[];
  sources: RetrievalCitation[];
  citations: RetrievalCitation[];
  retrievalDebug?: Record<string, unknown>;
}

interface VectorRow extends Omit<RetrievedChunk, 'score'> {
  score: number;
}

interface KeywordRow extends Omit<RetrievedChunk, 'score'> {
  score: number;
}

interface FusedCandidate extends Omit<RetrievedChunk, 'score'> {
  vectorRank?: number;
  vectorScore?: number;
  keywordRank?: number;
  keywordScore?: number;
  fusionScore: number;
  rerankScore?: number;
}

interface RetrievalDebug {
  embeddingProfile: EmbeddingProfile;
  vectorCandidateCount: number;
  keywordCandidateCount: number;
  fusionCandidateCount: number;
  rerankedCandidateCount: number;
  candidates: Array<{
    id: string;
    documentId: string;
    documentName: string;
    chunkIndex: number;
    vectorRank: number | null;
    vectorScore: number | null;
    keywordRank: number | null;
    keywordScore: number | null;
    fusionScore: number;
    rerankScore: number | null;
  }>;
}

const RRF_K = 60;

@Injectable()
export class RagService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingService,
    private readonly knowledgeBases: KnowledgeBasesService,
    private readonly llm: LlmService,
    private readonly reranker: RerankerService,
    private readonly config: ConfigService,
    private readonly cache: RedisCacheService,
  ) {}

  async ask(userId: string, knowledgeBaseId: string, question: string, topK = 5, debug = false) {
    const retrieval = await this.retrieve(userId, knowledgeBaseId, question, topK, debug);
    const answer =
      retrieval.chunks.length === 0
        ? '当前知识库还没有可检索的已处理文档，请先上传文档并等待处理完成。'
        : await this.llm.generateAnswer(
            question,
            retrieval.chunks.map((chunk, index) => ({
              citation: index + 1,
              documentName: chunk.documentName,
              chunkIndex: chunk.chunkIndex,
              content: chunk.content,
              pageNumber: chunk.pageNumber ?? null,
              headingPath: chunk.headingPath ?? [],
            })),
          );
    return { ...retrieval, answer, answerMode: retrieval.chunks.length === 0 ? 'empty' : 'llm' };
  }

  async retrieve(
    userId: string,
    knowledgeBaseId: string,
    question: string,
    topK = 5,
    debug = false,
  ): Promise<RagRetrievalResult> {
    const knowledgeBase = await this.knowledgeBases.getById(knowledgeBaseId);
    const vector = await this.embeddings.embedQuery(question);
    if (!vector.some((value) => value !== 0)) {
      throw new BadRequestException('问题中没有可用于检索的文字');
    }
    const profile = this.embeddings.getProfile(vector.length);
    await this.ensureConsistentEmbeddingProfile(profile);

    const cacheKey = this.retrievalCacheKey(knowledgeBase, question, topK, debug, profile);
    const cached = await this.cache.get<RagRetrievalResult>(cacheKey);
    if (cached) return cached;

    const recallLimit = Number(this.config.get('RAG_RECALL_CANDIDATE_LIMIT', 50));
    const rerankLimit = Math.min(
      recallLimit,
      Number(this.config.get('RAG_RERANK_CANDIDATE_LIMIT', 50)),
    );
    const pgVector = this.embeddings.toPgVector(vector);
    const [vectorRows, keywordRows] = await Promise.all([
      this.recallByVector(
        userId,
        knowledgeBaseId,
        knowledgeBase.workspaceId,
        profile,
        pgVector,
        recallLimit,
      ),
      this.recallByKeyword(
        userId,
        knowledgeBaseId,
        knowledgeBase.workspaceId,
        question,
        recallLimit,
      ),
    ]);
    const fused = fuseRankedCandidates(vectorRows, keywordRows).slice(0, rerankLimit);
    const reranked = await this.reranker.rerank(
      question,
      fused.map(({ id, content }) => ({ id, content })),
    );
    const ordered = reranked
      .map(({ index, score }) => ({ ...fused[index]!, rerankScore: score }))
      .sort((left, right) => (right.rerankScore ?? 0) - (left.rerankScore ?? 0));
    const finalCandidates = ordered.slice(0, topK);

    const chunks: RetrievedChunk[] = finalCandidates.map((candidate) => ({
      id: candidate.id,
      documentId: candidate.documentId,
      documentName: repairFilenameEncoding(candidate.documentName),
      chunkIndex: candidate.chunkIndex,
      content: candidate.content,
      score: candidate.rerankScore ?? candidate.fusionScore,
      pageNumber:
        typeof candidate.metadata?.pageNumber === 'number' ? candidate.metadata.pageNumber : null,
      headingPath: Array.isArray(candidate.metadata?.headingPath)
        ? candidate.metadata.headingPath.filter((part): part is string => typeof part === 'string')
        : [],
      metadata: candidate.metadata,
      ...(debug
        ? {
            vectorRank: candidate.vectorRank,
            vectorScore: candidate.vectorScore,
            keywordRank: candidate.keywordRank,
            keywordScore: candidate.keywordScore,
            fusionScore: candidate.fusionScore,
            rerankScore: candidate.rerankScore,
          }
        : {}),
    }));

    const sources = chunks.map((chunk, index) => ({
      citation: index + 1,
      documentId: chunk.documentId,
      documentName: chunk.documentName,
      chunkIndex: chunk.chunkIndex,
      score: Number(chunk.score),
      pageNumber: chunk.pageNumber ?? null,
      headingPath: chunk.headingPath ?? [],
    }));

    const result: RagRetrievalResult = {
      knowledgeBaseId,
      question,
      answerMode: chunks.length === 0 ? 'empty' : 'llm',
      chunks,
      sources,
      citations: sources,
    };
    if (debug) {
      result.retrievalDebug = buildRetrievalDebug(
        profile,
        vectorRows,
        keywordRows,
        fused,
        ordered,
      ) as unknown as Record<string, unknown>;
    }
    await this.cache.set(
      cacheKey,
      result,
      Number(this.config.get('RAG_RETRIEVAL_CACHE_TTL_SECONDS', 300)),
    );
    return result;
  }

  private retrievalCacheKey(
    knowledgeBase: { id: string; workspaceId: string; indexVersion?: number },
    question: string,
    topK: number,
    debug: boolean,
    profile: EmbeddingProfile,
  ): string {
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          workspaceId: knowledgeBase.workspaceId,
          knowledgeBaseId: knowledgeBase.id,
          indexVersion: knowledgeBase.indexVersion ?? 1,
          question: question.normalize('NFKC').trim().toLocaleLowerCase(),
          topK,
          debug,
          modelConfig: {
            embedding: profile,
            rerankerProvider: this.config.get('RERANKER_PROVIDER', 'compatible'),
            rerankerModel: this.config.get('RERANKER_MODEL', ''),
            rerankerBaseUrl: this.config.get('RERANKER_BASE_URL', ''),
            llmModel: this.config.get('LLM_MODEL', ''),
            llmBaseUrl: this.config.get('LLM_BASE_URL', ''),
            recallLimit: this.config.get('RAG_RECALL_CANDIDATE_LIMIT', 50),
            rerankLimit: this.config.get('RAG_RERANK_CANDIDATE_LIMIT', 50),
          },
        }),
      )
      .digest('hex');
    return `rag:retrieval:${digest}`;
  }

  private async recallByVector(
    userId: string,
    knowledgeBaseId: string,
    workspaceId: string,
    profile: EmbeddingProfile,
    pgVector: string,
    limit: number,
  ): Promise<VectorRow[]> {
    const vectorType = Prisma.raw(`vector(${profile.dimension})`);
    const dimensionValue = Prisma.raw(String(profile.dimension));
    const rows = await this.prisma.$queryRaw<VectorRow[]>(Prisma.sql`
      SELECT
        c."id",
        c."documentId",
        d."originalName" AS "documentName",
        c."chunkIndex",
        c."content",
        c."metadata",
        (1 - (c."embedding"::${vectorType} <=> ${pgVector}::${vectorType}))::float8 AS "score"
      FROM "Chunk" c
      INNER JOIN "Document" d ON d."id" = c."documentId"
      INNER JOIN "KnowledgeBase" kb ON kb."id" = d."knowledgeBaseId"
      WHERE d."knowledgeBaseId" = ${knowledgeBaseId}
        AND kb."workspaceId" = ${workspaceId}
        AND EXISTS (
          SELECT 1 FROM "WorkspaceMember" wm
          WHERE wm."workspaceId" = kb."workspaceId" AND wm."userId" = ${userId}
        )
        AND c."embedding" IS NOT NULL
        AND c."embeddingProvider" = ${profile.provider}
        AND c."embeddingModel" = ${profile.model}
        AND c."embeddingVersion" = ${profile.version}
        AND c."embeddingDimension" = ${dimensionValue}
        AND d."activeIndexVersion" > 0
        AND c."documentIndexVersion" = d."activeIndexVersion"
      ORDER BY c."embedding"::${vectorType} <=> ${pgVector}::${vectorType}
      LIMIT ${limit}
    `);
    return rows.map((row, index) => ({
      ...row,
      score: Number(row.score),
      documentName: repairFilenameEncoding(row.documentName),
      vectorRank: index + 1,
      vectorScore: Number(row.score),
    }));
  }

  private async recallByKeyword(
    userId: string,
    knowledgeBaseId: string,
    workspaceId: string,
    question: string,
    limit: number,
  ): Promise<KeywordRow[]> {
    const terms = buildSearchTerms(question);
    const termValues = Prisma.join(terms.map((term) => Prisma.sql`(${term})`));
    const rows = await this.prisma.$queryRaw<KeywordRow[]>(Prisma.sql`
      WITH search_query AS (
        SELECT plainto_tsquery('simple', ${question}) AS terms, ${question}::text AS phrase
      ), search_terms(term) AS (VALUES ${termValues})
      SELECT
        c."id",
        c."documentId",
        d."originalName" AS "documentName",
        c."chunkIndex",
        c."content",
        c."metadata",
        (
          ts_rank_cd(to_tsvector('simple', c."content"), q.terms)
          + similarity(c."content", q.phrase)
          + (SELECT COUNT(*)::float8 / ${terms.length}
             FROM search_terms st
             WHERE strpos(lower(c."content"), lower(st.term)) > 0)
        )::float8 AS "score"
      FROM "Chunk" c
      INNER JOIN "Document" d ON d."id" = c."documentId"
      INNER JOIN "KnowledgeBase" kb ON kb."id" = d."knowledgeBaseId"
      CROSS JOIN search_query q
      WHERE d."knowledgeBaseId" = ${knowledgeBaseId}
        AND kb."workspaceId" = ${workspaceId}
        AND EXISTS (
          SELECT 1 FROM "WorkspaceMember" wm
          WHERE wm."workspaceId" = kb."workspaceId" AND wm."userId" = ${userId}
        )
        AND d."activeIndexVersion" > 0
        AND c."documentIndexVersion" = d."activeIndexVersion"
        AND (
          to_tsvector('simple', c."content") @@ q.terms
          OR c."content" % q.phrase
          OR strpos(lower(c."content"), lower(q.phrase)) > 0
          OR EXISTS (
            SELECT 1 FROM search_terms st
            WHERE strpos(lower(c."content"), lower(st.term)) > 0
          )
        )
      ORDER BY "score" DESC, c."id"
      LIMIT ${limit}
    `);
    return rows.map((row, index) => ({
      ...row,
      score: Number(row.score),
      documentName: repairFilenameEncoding(row.documentName),
      keywordRank: index + 1,
      keywordScore: Number(row.score),
    }));
  }

  private async ensureConsistentEmbeddingProfile(profile: EmbeddingProfile): Promise<void> {
    const [mismatch] = await this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS count
      FROM "Chunk" c
      INNER JOIN "Document" d ON d."id" = c."documentId"
      WHERE c."embedding" IS NOT NULL
        AND c."documentIndexVersion" = d."activeIndexVersion"
        AND d."activeIndexVersion" > 0
        AND (
          c."embeddingProvider" IS DISTINCT FROM ${profile.provider}
          OR c."embeddingModel" IS DISTINCT FROM ${profile.model}
          OR c."embeddingVersion" IS DISTINCT FROM ${profile.version}
          OR c."embeddingDimension" IS DISTINCT FROM ${profile.dimension}
        )
    `);
    if (Number(mismatch?.count ?? 0) > 0) {
      throw new ServiceUnavailableException(
        'Embedding 模型与已建索引不一致，请先运行 npm run embeddings:reindex',
      );
    }
  }
}

export function buildSearchTerms(question: string): string[] {
  const normalized = question.normalize('NFKC').toLocaleLowerCase();
  const terms = new Set<string>();
  for (const match of normalized.matchAll(/[\u3400-\u9fff]+|[\p{L}\p{N}_]+/gu)) {
    const token = match[0];
    if (!/[\u3400-\u9fff]/u.test(token)) {
      terms.add(token);
      continue;
    }
    const characters = Array.from(token);
    if (characters.length === 1) terms.add(token);
    for (const size of [2, 3]) {
      for (let index = 0; index <= characters.length - size; index += 1) {
        terms.add(characters.slice(index, index + size).join(''));
      }
    }
  }
  const result = [...terms].slice(0, 50);
  return result.length > 0 ? result : [normalized];
}

export function fuseRankedCandidates(
  vectorRows: VectorRow[],
  keywordRows: KeywordRow[],
): FusedCandidate[] {
  const candidates = new Map<string, FusedCandidate>();
  for (const row of vectorRows) {
    const candidate: FusedCandidate = {
      id: row.id,
      documentId: row.documentId,
      documentName: row.documentName,
      chunkIndex: row.chunkIndex,
      content: row.content,
      metadata: row.metadata,
      vectorRank: row.vectorRank,
      vectorScore: row.vectorScore ?? row.score,
      fusionScore: 1 / (RRF_K + (row.vectorRank ?? 1)),
    };
    candidates.set(row.id, candidate);
  }
  for (const row of keywordRows) {
    const current = candidates.get(row.id);
    if (current) {
      current.keywordRank = row.keywordRank;
      current.keywordScore = row.keywordScore ?? row.score;
      current.fusionScore += 1 / (RRF_K + (row.keywordRank ?? 1));
    } else {
      candidates.set(row.id, {
        id: row.id,
        documentId: row.documentId,
        documentName: row.documentName,
        chunkIndex: row.chunkIndex,
        content: row.content,
        metadata: row.metadata,
        keywordRank: row.keywordRank,
        keywordScore: row.keywordScore ?? row.score,
        fusionScore: 1 / (RRF_K + (row.keywordRank ?? 1)),
      });
    }
  }
  return [...candidates.values()].sort(
    (left, right) => right.fusionScore - left.fusionScore || left.id.localeCompare(right.id),
  );
}

function buildRetrievalDebug(
  profile: EmbeddingProfile,
  vectorRows: VectorRow[],
  keywordRows: KeywordRow[],
  fused: FusedCandidate[],
  reranked: FusedCandidate[],
): RetrievalDebug {
  const rerankScores = new Map(reranked.map(({ id, rerankScore }) => [id, rerankScore]));
  return {
    embeddingProfile: profile,
    vectorCandidateCount: vectorRows.length,
    keywordCandidateCount: keywordRows.length,
    fusionCandidateCount: fuseRankedCandidates(vectorRows, keywordRows).length,
    rerankedCandidateCount: reranked.length,
    candidates: fused.map((candidate) => ({
      id: candidate.id,
      documentId: candidate.documentId,
      documentName: candidate.documentName,
      chunkIndex: candidate.chunkIndex,
      vectorRank: candidate.vectorRank ?? null,
      vectorScore: candidate.vectorScore ?? null,
      keywordRank: candidate.keywordRank ?? null,
      keywordScore: candidate.keywordScore ?? null,
      fusionScore: candidate.fusionScore,
      rerankScore: rerankScores.get(candidate.id) ?? null,
    })),
  };
}
