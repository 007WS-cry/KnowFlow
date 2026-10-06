import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbeddingProfile, EmbeddingProvider, EMBEDDING_PROVIDER } from './embedding.types';

@Injectable()
export class EmbeddingService {
  private readonly providerBatchSize = 32;
  private readonly queryPrefix: string;
  private readonly documentPrefix: string;
  private readonly pipelineVersion: string;

  constructor(
    @Inject(EMBEDDING_PROVIDER) private readonly provider: EmbeddingProvider,
    config: ConfigService,
  ) {
    this.queryPrefix = config.get<string>('EMBEDDING_QUERY_PREFIX', '');
    this.documentPrefix = config.get<string>('EMBEDDING_DOCUMENT_PREFIX', '');
    this.pipelineVersion =
      this.queryPrefix || this.documentPrefix
        ? `${provider.version};q=${encodeURIComponent(this.queryPrefix)};d=${encodeURIComponent(this.documentPrefix)}`
        : provider.version;
  }

  async embed(text: string): Promise<number[]> {
    return this.embedQuery(text);
  }

  async embedQuery(text: string): Promise<number[]> {
    return (await this.embedMany([`${this.queryPrefix}${text}`]))[0]!;
  }

  embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embedMany(texts.map((text) => `${this.documentPrefix}${text}`));
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += this.providerBatchSize) {
      const batch = texts.slice(offset, offset + this.providerBatchSize);
      const embedded = await this.provider.embedMany(batch);
      if (embedded.length !== batch.length) {
        throw new Error('Embedding provider returned the wrong vector count');
      }
      const dimension = embedded[0]?.length;
      if (
        !dimension ||
        dimension > 2000 ||
        embedded.some(
          (vector) =>
            vector.length !== dimension || vector.some((value) => !Number.isFinite(value)),
        )
      ) {
        throw new Error('Embedding provider returned invalid vectors');
      }
      if (vectors.length > 0 && vectors[0]!.length !== dimension) {
        throw new Error('Embedding provider changed vector dimensions within one batch');
      }
      vectors.push(...embedded);
    }
    return vectors;
  }

  getProfile(dimension: number): EmbeddingProfile {
    return {
      provider: this.provider.providerName,
      model: this.provider.model,
      version: this.pipelineVersion,
      dimension,
    };
  }

  toPgVector(vector: number[]): string {
    if (!vector.length || vector.length > 2000 || vector.some((value) => !Number.isFinite(value))) {
      throw new Error('Expected a finite pgvector embedding with 1 to 2000 dimensions');
    }
    return `[${vector.map((value) => value.toFixed(8)).join(',')}]`;
  }
}
