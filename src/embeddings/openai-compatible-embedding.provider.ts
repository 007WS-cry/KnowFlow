import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbeddingProvider } from './embedding.types';

interface EmbeddingsResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
  error?: { message?: string };
}

@Injectable()
export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly providerName = 'openai-compatible';
  readonly model: string;
  readonly version: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly dimensions?: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('EMBEDDING_BASE_URL').replace(/\/+$/, '');
    this.apiKey = config.get<string>('EMBEDDING_API_KEY')?.trim() ?? '';
    this.model = config.getOrThrow<string>('EMBEDDING_MODEL');
    this.version = config.get<string>('EMBEDDING_VERSION', '1');
    const dimensions = config.get<string | number>('EMBEDDING_DIMENSIONS');
    if (dimensions !== undefined && `${dimensions}`.trim()) this.dimensions = Number(dimensions);
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          ...(this.dimensions ? { dimensions: this.dimensions } : {}),
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new ServiceUnavailableException('Embedding 服务暂不可用');
    }

    if (!response.ok) {
      throw new ServiceUnavailableException(`Embedding 服务返回 HTTP ${response.status}`);
    }

    let payload: EmbeddingsResponse;
    try {
      payload = (await response.json()) as EmbeddingsResponse;
    } catch {
      throw new ServiceUnavailableException('Embedding 服务返回了无效响应');
    }

    const data = payload.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new ServiceUnavailableException('Embedding 服务返回的向量数量不正确');
    }

    const ordered = [...data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
    const vectors = ordered.map((item) => item.embedding);
    if (
      vectors.some(
        (vector) =>
          !Array.isArray(vector) ||
          vector.length === 0 ||
          vector.some((value) => !Number.isFinite(value)),
      )
    ) {
      throw new ServiceUnavailableException('Embedding 服务返回了无效向量');
    }
    const dimensions = vectors[0]!.length;
    if (
      dimensions > 2000 ||
      vectors.some((vector) => vector!.length !== dimensions) ||
      (this.dimensions !== undefined && dimensions !== this.dimensions)
    ) {
      throw new ServiceUnavailableException('Embedding 服务返回的向量维度不匹配');
    }
    return vectors as number[][];
  }
}
