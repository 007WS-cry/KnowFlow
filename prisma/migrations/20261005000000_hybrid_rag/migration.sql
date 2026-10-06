CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP INDEX IF EXISTS "Chunk_embedding_hnsw_idx";

ALTER TABLE "Chunk"
    ALTER COLUMN "embedding" TYPE vector,
    ADD COLUMN "embeddingProvider" TEXT,
    ADD COLUMN "embeddingModel" TEXT,
    ADD COLUMN "embeddingVersion" TEXT,
    ADD COLUMN "embeddingDimension" INTEGER;

-- Existing MVP embeddings are feature hashes, so they cannot be mixed with model embeddings.
UPDATE "Chunk"
SET "embedding" = NULL;

ALTER TABLE "Chunk"
    ADD CONSTRAINT "Chunk_embedding_profile_check"
    CHECK (
      ("embedding" IS NULL AND "embeddingProvider" IS NULL AND "embeddingModel" IS NULL AND "embeddingVersion" IS NULL AND "embeddingDimension" IS NULL)
      OR
      ("embedding" IS NOT NULL AND "embeddingProvider" IS NOT NULL AND "embeddingModel" IS NOT NULL AND "embeddingVersion" IS NOT NULL AND "embeddingDimension" = vector_dims("embedding"))
    );

CREATE INDEX "Chunk_content_search_gin_idx"
    ON "Chunk" USING gin (to_tsvector('simple', "content"));

CREATE INDEX "Chunk_content_trigram_gin_idx"
    ON "Chunk" USING gin ("content" gin_trgm_ops);
