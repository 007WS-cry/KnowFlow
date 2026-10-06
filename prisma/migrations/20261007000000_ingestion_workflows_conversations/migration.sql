ALTER TYPE "DocumentStatus" ADD VALUE 'CANCELLED';

CREATE TYPE "DocumentProcessingStage" AS ENUM ('UPLOAD', 'QUEUED', 'PARSING', 'CHUNKING', 'EMBEDDING', 'INDEXING', 'COMPLETE');
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT');

ALTER TABLE "KnowledgeBase"
    ADD COLUMN "indexVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "Document"
    ADD COLUMN "processingStage" "DocumentProcessingStage" NOT NULL DEFAULT 'UPLOAD',
    ADD COLUMN "progress" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "multipartUploadId" TEXT,
    ADD COLUMN "uploadExpiresAt" TIMESTAMPTZ(6),
    ADD COLUMN "activeIndexVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Chunk"
    ADD COLUMN "documentIndexVersion" INTEGER NOT NULL DEFAULT 1;
UPDATE "Document" SET "activeIndexVersion" = 1 WHERE "status" = 'READY';
UPDATE "Document"
SET "processingStage" = 'COMPLETE', "progress" = 100
WHERE "status" = 'READY';
UPDATE "Document"
SET "processingStage" = 'QUEUED', "progress" = 0
WHERE "status" IN ('PENDING', 'PROCESSING', 'FAILED');
DROP INDEX "Chunk_documentId_chunkIndex_key";
CREATE UNIQUE INDEX "Chunk_documentId_documentIndexVersion_chunkIndex_key"
    ON "Chunk"("documentId", "documentIndexVersion", "chunkIndex");
CREATE INDEX "Chunk_documentId_documentIndexVersion_idx"
    ON "Chunk"("documentId", "documentIndexVersion");

CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Conversation_userId_updatedAt_idx" ON "Conversation"("userId", "updatedAt");
CREATE INDEX "Conversation_knowledgeBaseId_idx" ON "Conversation"("knowledgeBaseId");
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_knowledgeBaseId_fkey"
    FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "citations" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Document" ADD CONSTRAINT "Document_progress_check" CHECK ("progress" BETWEEN 0 AND 100);
