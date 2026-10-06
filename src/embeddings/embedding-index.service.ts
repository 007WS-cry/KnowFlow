import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class EmbeddingIndexService {
  private readonly indexPromises = new Map<number, Promise<void>>();

  constructor(private readonly prisma: PrismaService) {}

  async ensureHnswIndex(dimension: number): Promise<void> {
    if (!Number.isInteger(dimension) || dimension < 1 || dimension > 2000) {
      throw new Error('HNSW embedding dimensions must be between 1 and 2000');
    }
    const previous = this.indexPromises.get(dimension);
    if (previous) return previous;

    const creation = this.createHnswIndex(dimension);
    this.indexPromises.set(dimension, creation);
    try {
      await creation;
    } catch (error) {
      this.indexPromises.delete(dimension);
      throw error;
    }
  }

  private async createHnswIndex(dimension: number): Promise<void> {
    const indexName = Prisma.raw(`"Chunk_embedding_hnsw_${dimension}_idx"`);
    const vectorType = Prisma.raw(`vector(${dimension})`);
    const dimensionValue = Prisma.raw(String(dimension));
    await this.prisma.$executeRaw(Prisma.sql`
      CREATE INDEX IF NOT EXISTS ${indexName}
      ON "Chunk" USING hnsw (("embedding"::${vectorType}) vector_cosine_ops)
      WHERE "embedding" IS NOT NULL AND "embeddingDimension" = ${dimensionValue}
    `);
  }
}
