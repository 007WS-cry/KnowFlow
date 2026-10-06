import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envValidationSchema } from '../config/env.validation';
import { PrismaModule } from '../prisma/prisma.module';
import { EmbeddingsModule } from './embeddings.module';
import { EmbeddingReindexService } from './embedding-reindex.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validationSchema: envValidationSchema }),
    PrismaModule,
    EmbeddingsModule,
  ],
  providers: [EmbeddingReindexService],
})
export class EmbeddingReindexModule {}
