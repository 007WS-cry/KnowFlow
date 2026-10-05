import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { KnowledgeBasesController } from './knowledge-bases.controller';
import { KnowledgeBasesService } from './knowledge-bases.service';

@Module({
  imports: [AuthModule, WorkspacesModule, QueueModule, StorageModule],
  controllers: [KnowledgeBasesController],
  providers: [KnowledgeBasesService],
  exports: [KnowledgeBasesService],
})
export class KnowledgeBasesModule {}
