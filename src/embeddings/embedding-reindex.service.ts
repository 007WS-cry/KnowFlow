import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EmbeddingService } from './embedding.service';
import { EmbeddingIndexService } from './embedding-index.service';
import { PrismaService } from '../prisma/prisma.service';

const BATCH_SIZE = 64;

@Injectable()
export class EmbeddingReindexService {
  private readonly logger = new Logger(EmbeddingReindexService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingService,
    private readonly embeddingIndex: EmbeddingIndexService,
  ) {}

  async reindexAll(): Promise<void> {
    // Fail before clearing existing vectors if the active provider is unavailable.
    const probe = await this.embeddings.embedQuery('KnowFlow embedding reindex check');
    if (!probe) throw new Error('Embedding provider returned no vectors');
    const profile = this.embeddings.getProfile(probe.length);
    await this.embeddingIndex.ensureHnswIndex(profile.dimension);

    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "Chunk"
      SET "embedding" = NULL,
          "embeddingProvider" = NULL,
          "embeddingModel" = NULL,
          "embeddingVersion" = NULL,
          "embeddingDimension" = NULL
    `);

    let cursor: string | undefined;
    let processed = 0;
    while (true) {
      const batch = await this.prisma.chunk.findMany({
        ...(cursor ? { where: { id: { gt: cursor } } } : {}),
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        select: { id: true, content: true },
      });
      if (batch.length === 0) break;

      const vectors = await this.embeddings.embedDocuments(batch.map(({ content }) => content));
      const rows = batch.map(({ id }, index) => {
        const vector = vectors[index]!;
        const rowProfile = this.embeddings.getProfile(vector.length);
        return Prisma.sql`(${id}, ${this.embeddings.toPgVector(vector)}::vector, ${rowProfile.provider}, ${rowProfile.model}, ${rowProfile.version}, ${rowProfile.dimension})`;
      });
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "Chunk" AS c
        SET "embedding" = v."embedding",
            "embeddingProvider" = v."provider",
            "embeddingModel" = v."model",
            "embeddingVersion" = v."version",
            "embeddingDimension" = v."dimension"
        FROM (VALUES ${Prisma.join(rows)}) AS v("id", "embedding", "provider", "model", "version", "dimension")
        WHERE c."id" = v."id"
      `);

      processed += batch.length;
      cursor = batch[batch.length - 1]!.id;
      this.logger.log(`Re-embedded ${processed} chunks with ${profile.provider}/${profile.model}`);
    }
    this.logger.log(
      `Embedding reindex completed: ${processed} chunks at ${profile.dimension} dimensions`,
    );
  }
}
