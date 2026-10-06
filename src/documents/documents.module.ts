import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { KnowledgeBasesModule } from '../knowledge-bases/knowledge-bases.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { DocumentProcessingService } from './document-processing.service';
import { DocumentProcessor } from './document-processor';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EmbeddingsModule,
    KnowledgeBasesModule,
    QueueModule,
    StorageModule,
  ],
  controllers: [DocumentsController],
  providers: [DocumentProcessingService, DocumentProcessor, DocumentsService],
})
export class DocumentsModule {}
