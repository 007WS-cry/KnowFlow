import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { EmbeddingReindexModule } from './embedding-reindex.module';
import { EmbeddingReindexService } from './embedding-reindex.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(EmbeddingReindexModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    await app.get(EmbeddingReindexService).reindexAll();
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Embedding reindex failed'}\n`);
  process.exitCode = 1;
});
