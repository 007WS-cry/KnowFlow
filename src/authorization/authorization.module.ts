import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WorkspacePolicyGuard } from './workspace-policy.guard';
import { WorkspacePolicyService } from './workspace-policy.service';

@Module({
  imports: [PrismaModule],
  providers: [WorkspacePolicyService, WorkspacePolicyGuard],
  exports: [WorkspacePolicyService, WorkspacePolicyGuard],
})
export class AuthorizationModule {}
