import { Module } from '@nestjs/common';
import { HttpRerankerProvider } from './http-reranker.provider';
import { RERANKER_PROVIDER } from './reranker.types';
import { RerankerService } from './reranker.service';

@Module({
  providers: [
    HttpRerankerProvider,
    { provide: RERANKER_PROVIDER, useExisting: HttpRerankerProvider },
    RerankerService,
  ],
  exports: [RerankerService],
})
export class RerankerModule {}
