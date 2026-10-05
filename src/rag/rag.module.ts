import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { KnowledgeBasesModule } from '../knowledge-bases/knowledge-bases.module';
import { LlmModule } from '../llm/llm.module';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';

@Module({
  imports: [AuthModule, EmbeddingsModule, KnowledgeBasesModule, LlmModule],
  controllers: [RagController],
  providers: [RagService],
})
export class RagModule {}
