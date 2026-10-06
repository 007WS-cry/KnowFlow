import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  RERANKER_PROVIDER,
  RerankerDocument,
  RerankerProvider,
  RerankerResult,
} from './reranker.types';

@Injectable()
export class RerankerService {
  constructor(
    @Inject(RERANKER_PROVIDER) private readonly provider: RerankerProvider,
    private readonly config: ConfigService,
  ) {}

  rerank(query: string, documents: RerankerDocument[]): Promise<RerankerResult[]> {
    if (this.config.get<string>('RERANKER_PROVIDER', 'compatible') === 'disabled') {
      return Promise.resolve(
        documents.map((_, index) => ({ index, score: documents.length - index })),
      );
    }
    return this.provider.rerank(query, documents);
  }
}
