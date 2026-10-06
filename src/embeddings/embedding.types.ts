export interface EmbeddingProfile {
  provider: string;
  model: string;
  version: string;
  dimension: number;
}

export interface EmbeddingProvider {
  readonly providerName: string;
  readonly model: string;
  readonly version: string;
  embedMany(texts: string[]): Promise<number[][]>;
}

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');
