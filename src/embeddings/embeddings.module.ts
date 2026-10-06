import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { EmbeddingService } from './embedding.service';
import { EmbeddingIndexService } from './embedding-index.service';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from './embedding.types';
import { LocalEmbeddingProvider } from './local-embedding.provider';
import { OpenAiCompatibleEmbeddingProvider } from './openai-compatible-embedding.provider';

@Module({
  imports: [PrismaModule],
  providers: [
    OpenAiCompatibleEmbeddingProvider,
    LocalEmbeddingProvider,
    {
      provide: EMBEDDING_PROVIDER,
      inject: [ConfigService, OpenAiCompatibleEmbeddingProvider, LocalEmbeddingProvider],
      useFactory: (
        config: ConfigService,
        openAi: OpenAiCompatibleEmbeddingProvider,
        local: LocalEmbeddingProvider,
      ): EmbeddingProvider =>
        config.get<string>('EMBEDDING_PROVIDER', 'openai-compatible') === 'local' ? local : openAi,
    },
    EmbeddingService,
    EmbeddingIndexService,
  ],
  exports: [EmbeddingService, EmbeddingIndexService],
})
export class EmbeddingsModule {}
