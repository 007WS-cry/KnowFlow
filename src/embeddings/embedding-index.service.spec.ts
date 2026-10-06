import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingIndexService } from './embedding-index.service';

describe('EmbeddingIndexService', () => {
  it('creates a dimension-specific HNSW index using a validated dimension', async () => {
    const prisma = { $executeRaw: jest.fn().mockResolvedValue(0) };
    const service = new EmbeddingIndexService(prisma as unknown as PrismaService);
    await service.ensureHnswIndex(384);

    const query = prisma.$executeRaw.mock.calls[0]![0] as { sql: string; values: unknown[] };
    expect(query.sql).toContain('Chunk_embedding_hnsw_384_idx');
    expect(query.sql).toContain('vector(384)');
    expect(query.sql).toContain('"embeddingDimension" = 384');
    expect(query.values).toEqual([]);
    await service.ensureHnswIndex(384);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('rejects dimensions that exceed pgvector HNSW limits', async () => {
    const prisma = { $executeRaw: jest.fn() };
    const service = new EmbeddingIndexService(prisma as unknown as PrismaService);
    await expect(service.ensureHnswIndex(3072)).rejects.toThrow('between 1 and 2000');
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
