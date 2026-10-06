import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RerankerDocument, RerankerProvider, RerankerResult } from './reranker.types';

interface RerankResponse {
  results?: Array<{ index?: number; relevance_score?: number; score?: number }>;
}

@Injectable()
export class HttpRerankerProvider implements RerankerProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('RERANKER_BASE_URL').replace(/\/+$/, '');
    this.apiKey = config.get<string>('RERANKER_API_KEY')?.trim() ?? '';
    this.model = config.getOrThrow<string>('RERANKER_MODEL');
  }

  async rerank(query: string, documents: RerankerDocument[]): Promise<RerankerResult[]> {
    if (documents.length === 0) return [];
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/rerank`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          query,
          documents: documents.map(({ content }) => content),
          top_n: documents.length,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ServiceUnavailableException('Reranker 服务暂不可用');
    }
    if (!response.ok) {
      throw new ServiceUnavailableException(`Reranker 服务返回 HTTP ${response.status}`);
    }

    let payload: RerankResponse;
    try {
      payload = (await response.json()) as RerankResponse;
    } catch {
      throw new ServiceUnavailableException('Reranker 服务返回了无效响应');
    }
    if (!Array.isArray(payload.results) || payload.results.length !== documents.length) {
      throw new ServiceUnavailableException('Reranker 服务返回的候选数量不正确');
    }

    const results = payload.results.map((result) => ({
      index: result.index,
      score: result.relevance_score ?? result.score,
    }));
    if (
      results.some(
        ({ index, score }) =>
          !Number.isInteger(index) ||
          index! < 0 ||
          index! >= documents.length ||
          !Number.isFinite(score),
      ) ||
      new Set(results.map(({ index }) => index)).size !== documents.length
    ) {
      throw new ServiceUnavailableException('Reranker 服务返回了无效排序结果');
    }
    return results as RerankerResult[];
  }
}
