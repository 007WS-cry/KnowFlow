import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { DocumentsModule } from './documents/documents.module';
import { HealthController } from './health/health.controller';
import { KnowledgeBasesModule } from './knowledge-bases/knowledge-bases.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { RagModule } from './rag/rag.module';
import { RerankerModule } from './reranker/reranker.module';
import { StorageModule } from './storage/storage.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { envValidationSchema } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      validationOptions: {
        allowUnknown: true,
        abortEarly: false,
      },
    }),
    AuthModule,
    WorkspacesModule,
    KnowledgeBasesModule,
    DocumentsModule,
    RagModule,
    RerankerModule,
    PrismaModule,
    QueueModule,
    StorageModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
